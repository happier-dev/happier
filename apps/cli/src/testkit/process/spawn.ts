import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

export function spawnTestProcess(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  const child = spawn(command, [...args], {
    stdio: 'ignore',
    ...options,
  })

  if (!child.pid) {
    throw new Error('Failed to spawn test process')
  }

  return child
}

export function spawnDetachedTestProcess(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  const child = spawnTestProcess(command, args, {
    detached: true,
    ...options,
  })
  child.unref()
  return child
}

export function spawnInlineNodeTestProcess(source: string, options: SpawnOptions = {}): ChildProcess {
  return spawnTestProcess(process.execPath, ['-e', source], options)
}

export function spawnDetachedInlineNodeTestProcess(source: string, options: SpawnOptions = {}): ChildProcess {
  return spawnDetachedTestProcess(process.execPath, ['-e', source], options)
}

export async function spawnInlineNodeParentWithChild(
  childSource = 'setInterval(() => {}, 1000)',
  opts: { timeoutMs?: number } = {},
): Promise<{ parent: ChildProcess; childPid: number }> {
  const timeoutMs = opts.timeoutMs ?? 2_000
  const parent = spawnInlineNodeTestProcess(
    [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], { stdio: "ignore" });`,
      'console.log(String(child.pid));',
      'setInterval(() => {}, 1000);',
    ].join('\n'),
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )

  const childPid = await new Promise<number>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for child pid'))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timer)
      parent.stdout?.off('data', onData)
      parent.off('error', onError)
      parent.off('exit', onExit)
    }

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString()
      const line = buffer.trim().split('\n')[0]?.trim()
      const parsed = line ? Number.parseInt(line, 10) : Number.NaN
      if (Number.isFinite(parsed) && parsed > 0) {
        cleanup()
        resolve(parsed)
      }
    }

    const onError = (error: unknown) => {
      cleanup()
      reject(error)
    }

    const onExit = () => {
      cleanup()
      reject(new Error('Parent exited before emitting child pid'))
    }

    parent.stdout?.on('data', onData)
    parent.once('error', onError)
    parent.once('exit', onExit)
  }).catch((error) => {
    try {
      parent.kill()
    } catch {
      // ignore
    }
    throw error
  })

  return { parent, childPid }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function waitForProcessExit(
  pid: number,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 5_000
  const intervalMs = opts.intervalMs ?? 50
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  return !isPidAlive(pid)
}
