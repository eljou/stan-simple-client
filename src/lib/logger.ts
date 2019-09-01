export interface Logger {
  info: (msg: string | string[]) => void
  debug: (msg: string | string[]) => void
  error: (msg: string | string[]) => void
}

export const defaultLogger = (prefix: string): Logger => ({
  info: (msg): void => {
    console.log(prefix, Array.isArray(msg) ? [...msg] : msg)
  },
  debug: (msg): void => {
    console.debug(prefix, Array.isArray(msg) ? [...msg] : msg)
  },
  error: (msg): void => {
    console.error(prefix, Array.isArray(msg) ? [...msg] : msg)
  },
})
