import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

import { isPidPresent } from '@happier-dev/cli-common/process'
import psList from 'ps-list'

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

async function waitForProcessParent(
  pid: number,
  expectedParentPid: number,
  opts: { timeoutMs: number; intervalMs?: number },
): Promise<void> {
  if (process.platform === 'win32') return
  const intervalMs = opts.intervalMs ?? 25
  const start = Date.now()

  while (Date.now() - start < opts.timeoutMs) {
    try {
      const processes = await psList()
      const entry = processes.find((processInfo) => processInfo.pid === pid)
      if (entry?.ppid === expectedParentPid) return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, opts.timeoutMs)))
      return
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(`Timed out waiting for pid ${pid} to be visible as a child of ${expectedParentPid}`)
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

  await waitForProcessParent(childPid, parent.pid!, { timeoutMs })

  return { parent, childPid }
}

/** The testkit's assertion name for the canonical predicate; the rule lives at the owner. */
export function isPidAlive(pid: number): boolean {
  return isPidPresent(pid)
}

async function isPidRunning(pid: number): Promise<boolean> {
  if (!isPidAlive(pid)) return false
  if (process.platform === 'win32') return true
  try {
    const processes = await psList()
    return processes.some((processInfo) => processInfo.pid === pid)
  } catch {
    return isPidAlive(pid)
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
    if (!(await isPidRunning(pid))) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  return !(await isPidRunning(pid))
}
