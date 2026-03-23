export async function waitForPidInspection<T>(
  inspectPid: (pid: number) => Promise<T | null>,
  pid: number,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T | null> {
  const timeoutMs = opts.timeoutMs ?? 5_000
  const intervalMs = opts.intervalMs ?? 100
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    const inspected = await inspectPid(pid)
    if (inspected !== null) return inspected
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  return null
}
