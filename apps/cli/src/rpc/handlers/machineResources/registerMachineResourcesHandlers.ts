import { execFile } from 'node:child_process'
import { readFile, statfs } from 'node:fs/promises'
import { cpus, freemem, homedir, totalmem } from 'node:os'
import { promisify } from 'node:util'

import type { RpcHandlerRegistrar } from '@/api/rpc/types'
import type { DaemonResourcesGetResponse } from '@happier-dev/protocol'
import { RPC_METHODS } from '@happier-dev/protocol/rpc'

const CPU_SAMPLE_DELAY_MS = 250
const MEMORY_PROBE_TIMEOUT_MS = 2_000
const MEMINFO_PATH = '/proc/meminfo'
// vm_stat lives at different absolute paths across macOS versions.
const VM_STAT_BINARIES = ['/usr/sbin/vm_stat', '/usr/bin/vm_stat'] as const

const execFileAsync = promisify(execFile)

export type MachineResourcesCpuTimes = Readonly<{
  idle: number
  total: number
}>

export type MachineResourcesMemoryProbe = Readonly<{
  usedBytes: number
  availableBytes: number
}>

type RegisterMachineResourcesHandlersParams = Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar
  deps?: Readonly<{
    homeDir?: string
    cpuSampleDelayMs?: number
    readCpuTimes?: () => MachineResourcesCpuTimes
    platform?: NodeJS.Platform
    vmStatTimeoutMs?: number
    readVmStatOutput?: () => Promise<string>
    readProcMeminfo?: () => Promise<string>
  }>
}>

function readCpuTimesFromOs(): MachineResourcesCpuTimes {
  let idle = 0
  let total = 0
  for (const { times } of cpus()) {
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  return { idle, total }
}

async function readVmStatOutputFromSystem(timeoutMs: number): Promise<string> {
  let lastError: unknown = null
  for (const binary of VM_STAT_BINARIES) {
    try {
      const { stdout } = await execFileAsync(binary, [], {
        timeout: timeoutMs,
        windowsHide: true,
      })
      return stdout
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('vm_stat is unavailable')
}

async function readProcMeminfoFromSystem(): Promise<string> {
  return await readFile(MEMINFO_PATH, { encoding: 'utf8' })
}

// macOS parks nearly all RAM in file cache, so total - freemem counts the cache as used and
// massively overstates usage. Activity Monitor's "Memory Used" is app + wired + compressed,
// i.e. active + wired pages here.
function parseVmStatMemory(output: string): MachineResourcesMemoryProbe | null {
  const pageSizeMatch = /page size of (\d+) bytes/.exec(output)
  if (!pageSizeMatch) return null
  const pageSize = Number(pageSizeMatch[1])
  if (!Number.isInteger(pageSize) || pageSize <= 0) return null

  const pages = new Map<string, number>()
  for (const line of output.split('\n')) {
    const match = /^"?([^":]+?)"?\s*:\s+(\d+)\.?\s*$/.exec(line)
    if (!match) continue
    pages.set(match[1].trim(), Number(match[2]))
  }

  const active = pages.get('Pages active')
  const wired = pages.get('Pages wired down')
  const compressor = pages.get('Pages occupied by compressor')
  const free = pages.get('Pages free')
  const speculative = pages.get('Pages speculative')
  const inactive = pages.get('Pages inactive')
  if (
    active === undefined || wired === undefined || compressor === undefined ||
    free === undefined || speculative === undefined || inactive === undefined
  ) {
    return null
  }

  return {
    usedBytes: (active + wired + compressor) * pageSize,
    availableBytes: (free + speculative + inactive) * pageSize,
  }
}

function parseProcMeminfoMemory(content: string): MachineResourcesMemoryProbe | null {
  const valuesKb = new Map<string, number>()
  for (const line of content.split('\n')) {
    const match = /^([^:]+):\s+(\d+)\s+kB/.exec(line)
    if (!match) continue
    valuesKb.set(match[1].trim(), Number(match[2]))
  }

  const memTotalKb = valuesKb.get('MemTotal')
  const memAvailableKb = valuesKb.get('MemAvailable')
  if (memTotalKb === undefined || memAvailableKb === undefined || memTotalKb <= 0) return null

  return {
    usedBytes: (memTotalKb - memAvailableKb) * 1024,
    availableBytes: memAvailableKb * 1024,
  }
}

async function sampleMemoryBytes(input: Readonly<{
  platform: NodeJS.Platform
  readVmStatOutput: () => Promise<string>
  readProcMeminfo: () => Promise<string>
}>): Promise<MachineResourcesMemoryProbe> {
  try {
    if (input.platform === 'darwin') {
      const probe = parseVmStatMemory(await input.readVmStatOutput())
      if (probe) return probe
    } else if (input.platform === 'linux') {
      const probe = parseProcMeminfoMemory(await input.readProcMeminfo())
      if (probe) return probe
    }
  } catch {
    // The platform probe is best-effort; fall through to the always-available os-based formula.
  }
  // Windows freemem() is ullAvailPhys, so this is the correct caliber there; elsewhere it is
  // the degraded fallback when the platform probe fails.
  const totalBytes = totalmem()
  const availableBytes = freemem()
  return { usedBytes: totalBytes - availableBytes, availableBytes }
}

async function sampleMachineResources(input: Readonly<{
  homeDir: string
  cpuSampleDelayMs: number
  readCpuTimes: () => MachineResourcesCpuTimes
  platform: NodeJS.Platform
  readVmStatOutput: () => Promise<string>
  readProcMeminfo: () => Promise<string>
}>): Promise<DaemonResourcesGetResponse> {
  try {
    const firstCpuTimes = input.readCpuTimes()
    await new Promise((resolve) => {
      setTimeout(resolve, input.cpuSampleDelayMs)
    })
    const secondCpuTimes = input.readCpuTimes()

    const cpuDeltaTotal = secondCpuTimes.total - firstCpuTimes.total
    const cpuDeltaIdle = secondCpuTimes.idle - firstCpuTimes.idle
    // Counter deltas can escape 0-100 when the CPU count changes between the two reads
    // (VM resize), so clamp to the range the snapshot schema declares.
    const cpuUsagePercent = cpuDeltaTotal <= 0
      ? 0
      : Math.min(100, Math.max(0, (1 - cpuDeltaIdle / cpuDeltaTotal) * 100))

    const memoryTotalBytes = totalmem()
    const memory = await sampleMemoryBytes(input)
    // Page counters and os.totalmem() come from independent sources, so the ratio can
    // escape 0-100; clamp to the range the snapshot schema declares.
    const memoryUsagePercent = Math.min(100, Math.max(0, (memory.usedBytes / memoryTotalBytes) * 100))

    const disk = await statfs(input.homeDir)
    const diskTotalBytes = disk.blocks * disk.bsize
    if (diskTotalBytes <= 0) {
      return {
        ok: false,
        error: `Disk stats unavailable for ${input.homeDir}`,
        errorCode: 'sample_failed',
      }
    }
    const diskAvailableBytes = disk.bavail * disk.bsize
    const diskUsedBytes = diskTotalBytes - diskAvailableBytes

    return {
      ok: true,
      snapshot: {
        sampledAt: Date.now(),
        cpu: { usagePercent: cpuUsagePercent },
        memory: {
          totalBytes: memoryTotalBytes,
          usedBytes: memory.usedBytes,
          usagePercent: memoryUsagePercent,
        },
        disk: {
          path: input.homeDir,
          totalBytes: diskTotalBytes,
          availableBytes: diskAvailableBytes,
          usedBytes: diskUsedBytes,
          usagePercent: (diskUsedBytes / diskTotalBytes) * 100,
        },
      },
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to sample machine resources',
      errorCode: 'sample_failed',
    }
  }
}

export function registerMachineResourcesHandlers(params: RegisterMachineResourcesHandlersParams): void {
  const homeDir = params.deps?.homeDir ?? homedir()
  const cpuSampleDelayMs = params.deps?.cpuSampleDelayMs ?? CPU_SAMPLE_DELAY_MS
  const readCpuTimes = params.deps?.readCpuTimes ?? readCpuTimesFromOs
  const vmStatTimeoutMs = params.deps?.vmStatTimeoutMs ?? MEMORY_PROBE_TIMEOUT_MS

  params.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_RESOURCES_GET,
    async () => await sampleMachineResources({
      homeDir,
      cpuSampleDelayMs,
      readCpuTimes,
      platform: params.deps?.platform ?? process.platform,
      readVmStatOutput: params.deps?.readVmStatOutput ?? (() => readVmStatOutputFromSystem(vmStatTimeoutMs)),
      readProcMeminfo: params.deps?.readProcMeminfo ?? readProcMeminfoFromSystem,
    }),
  )
}
