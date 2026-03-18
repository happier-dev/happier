function isBenignConsoleWriteError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''
  const message = 'message' in error ? String((error as { message?: unknown }).message ?? '') : ''
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || /broken pipe|stream.*destroyed/i.test(message)
}

type ConsoleErrorWritable = {
  on(event: 'error', listener: (error: unknown) => void): unknown
  __happierConsoleWriteGuardInstalled__?: boolean
}

function installConsoleWriteErrorGuard(stream: ConsoleErrorWritable): void {
  if (stream.__happierConsoleWriteGuardInstalled__) return
  stream.__happierConsoleWriteGuardInstalled__ = true
  stream.on('error', (error: unknown) => {
    if (!isBenignConsoleWriteError(error)) throw error
  })
}

export function installConsoleWriteErrorGuards(params?: Readonly<{
  stdout?: ConsoleErrorWritable
  stderr?: ConsoleErrorWritable
}>): void {
  installConsoleWriteErrorGuard(params?.stdout ?? process.stdout)
  installConsoleWriteErrorGuard(params?.stderr ?? process.stderr)
}

export function shouldInstallConsoleWriteErrorGuards(params?: Readonly<{
  processVersions?: Readonly<Record<string, string | undefined>>
}>): boolean {
  return typeof params?.processVersions?.bun !== 'string'
}

function writeConsoleBestEffort(writer: (...args: unknown[]) => void, args: unknown[]): void {
  try {
    writer(...args)
  } catch (error) {
    if (!isBenignConsoleWriteError(error)) throw error
  }
}

export function writeConsoleLogBestEffort(...args: unknown[]): void {
  writeConsoleBestEffort(console.log, args)
}

export function writeConsoleErrorBestEffort(...args: unknown[]): void {
  writeConsoleBestEffort(console.error, args)
}
