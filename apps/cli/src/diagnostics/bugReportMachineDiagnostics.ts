import { existsSync } from 'node:fs';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

import { readDaemonState } from '@/persistence';
import { listDaemonLogFiles } from '@/ui/logger';
import { redactBugReportSensitiveText } from '@happier-dev/protocol';

export type BugReportMachineDiagnosticsSnapshot = {
  daemonState: {
    pid: number;
    httpPort: number;
    startedAt: number;
    startedWithCliVersion: string;
    hasControlToken: boolean;
    daemonLogPath: string | null;
  } | null;
  daemonLogs: Array<{ file: string; path: string; modifiedAt: string }>;
  runtime: {
    cwd: string;
    platform: string;
    nodeVersion: string;
  };
  stackContext: {
    stackName: string | null;
    stackEnvPath: string | null;
    runtimeStatePath: string | null;
    runtimeState: string | null;
    logCandidates: string[];
  } | null;
};

type CollectMachineDiagnosticsOptions = {
  daemonLogLimit?: number;
  stackLogLimit?: number;
  stackRuntimeMaxChars?: number;
};

function trimTextTail(input: string, maxChars: number): string {
  const normalized = Math.max(1_024, Math.floor(maxChars));
  if (input.length <= normalized) return input;
  return input.slice(input.length - normalized);
}

function trimTextTailToMaxBytes(input: string, maxBytes: number): string {
  const normalized = Math.max(1_024, Math.floor(maxBytes));
  const encoder = new TextEncoder();
  if (encoder.encode(input).byteLength <= normalized) return input;

  let low = 0;
  let high = input.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = input.slice(mid);
    if (encoder.encode(candidate).byteLength > normalized) {
      low = mid + 1;
      continue;
    }
    high = mid;
  }
  return input.slice(low);
}

export async function readBugReportLogTail(path: string, maxBytes: number): Promise<string> {
  const normalizedMax = Math.max(1_024, Math.floor(maxBytes));
  const file = await open(path, 'r');
  try {
    const metadata = await file.stat();
    const start = Math.max(0, metadata.size - normalizedMax);
    const size = Math.max(0, metadata.size - start);
    if (size <= 0) return '';
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read(buffer, 0, size, start);
    const tail = buffer.subarray(0, bytesRead).toString('utf8');
    const redacted = redactBugReportSensitiveText(tail);
    return trimTextTailToMaxBytes(redacted, normalizedMax);
  } finally {
    await file.close();
  }
}

async function collectStackBugReportContext(input: {
  stackLogLimit: number;
  stackRuntimeMaxChars: number;
}): Promise<BugReportMachineDiagnosticsSnapshot['stackContext']> {
  const stackName = (process.env.HAPPIER_STACK_STACK ?? '').toString().trim() || null;
  const stackEnvPath = (process.env.HAPPIER_STACK_ENV_FILE ?? '').toString().trim() || null;
  const runtimeFromEnv = (process.env.HAPPIER_STACK_RUNTIME_STATE_PATH ?? '').toString().trim();
  const stackBaseDir = stackEnvPath ? dirname(stackEnvPath) : null;
  const runtimeStatePath = (runtimeFromEnv || (stackBaseDir ? join(stackBaseDir, 'stack.runtime.json') : '')).trim() || null;
  const logsDir = stackBaseDir ? join(stackBaseDir, 'logs') : null;
  const canonicalLogsDir = logsDir && existsSync(logsDir) ? await realpath(logsDir).catch(() => null) : null;

  if (!stackName && !stackEnvPath && !runtimeStatePath) {
    return null;
  }

  const logCandidates = new Set<string>();
  let runtimeState: string | null = null;

  if (runtimeStatePath && existsSync(runtimeStatePath)) {
    try {
      const runtimeRaw = await readFile(runtimeStatePath, 'utf8');
      runtimeState = trimTextTail(runtimeRaw, input.stackRuntimeMaxChars);
      try {
        const runtimeJson = JSON.parse(runtimeRaw) as { logs?: { runner?: unknown } };
        if (runtimeJson?.logs && typeof runtimeJson.logs.runner === 'string' && runtimeJson.logs.runner.trim()) {
          const runnerPath = runtimeJson.logs.runner.trim();
          if (canonicalLogsDir) {
            const canonicalRunnerPath = await realpath(runnerPath).catch(() => null);
            if (
              canonicalRunnerPath
              && (canonicalRunnerPath === canonicalLogsDir || canonicalRunnerPath.startsWith(`${canonicalLogsDir}${sep}`))
            ) {
              logCandidates.add(canonicalRunnerPath);
            }
          }
        }
      } catch {
        // Runtime snapshot is still useful even when partially written.
      }
    } catch {
      runtimeState = null;
    }
  }

  if (logsDir && existsSync(logsDir)) {
      try {
        const entries = await readdir(logsDir);
        const files = await Promise.all(
          entries
            .filter((entry) => entry.endsWith('.log'))
            .map(async (entry) => {
              const path = join(logsDir, entry);
              const metadata = await stat(path);
              return { path, modified: metadata.mtimeMs };
            }),
        );
        files
          .sort((a, b) => b.modified - a.modified)
          .slice(0, input.stackLogLimit)
          .forEach((entry) => {
            logCandidates.add(entry.path);
          });
      } catch {
        // Optional stack diagnostics.
      }
  }

  return {
    stackName,
    stackEnvPath,
    runtimeStatePath,
    runtimeState,
    logCandidates: Array.from(logCandidates).slice(0, Math.max(1, input.stackLogLimit + 1)),
  };
}

export async function collectBugReportMachineDiagnosticsSnapshot(
  options: CollectMachineDiagnosticsOptions = {},
): Promise<BugReportMachineDiagnosticsSnapshot> {
  const daemonLogLimit = Number.isFinite(options.daemonLogLimit) ? Math.max(1, Math.floor(options.daemonLogLimit!)) : 5;
  const stackLogLimit = Number.isFinite(options.stackLogLimit) ? Math.max(1, Math.floor(options.stackLogLimit!)) : 3;
  const stackRuntimeMaxChars = Number.isFinite(options.stackRuntimeMaxChars)
    ? Math.max(4_096, Math.floor(options.stackRuntimeMaxChars!))
    : 400_000;

  const daemonState = await readDaemonState();
  const daemonLogs = await listDaemonLogFiles(daemonLogLimit);
  const stackContext = await collectStackBugReportContext({ stackLogLimit, stackRuntimeMaxChars });

  return {
    daemonState: daemonState
      ? {
          pid: daemonState.pid,
          httpPort: daemonState.httpPort,
          startedAt: daemonState.startedAt,
          startedWithCliVersion: daemonState.startedWithCliVersion,
          hasControlToken: Boolean(daemonState.controlToken),
          daemonLogPath: daemonState.daemonLogPath ?? null,
        }
      : null,
    daemonLogs: daemonLogs.map((entry) => ({
      file: entry.file,
      path: entry.path,
      modifiedAt: entry.modified.toISOString(),
    })),
    runtime: {
      cwd: process.cwd(),
      platform: process.platform,
      nodeVersion: process.version,
    },
    stackContext,
  };
}
