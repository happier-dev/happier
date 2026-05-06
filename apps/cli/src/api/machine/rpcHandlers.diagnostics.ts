import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { readBugReportLogTail } from '@/diagnostics/bugReportMachineDiagnostics';
import { collectBugReportMachineDiagnosticsSnapshotForBugReport } from '@/diagnostics/bugReportMachineDiagnosticsRecipe';
import { configuration } from '@/configuration';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import { BUG_REPORT_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration';

async function toCanonicalPath(path: string): Promise<string | null> {
  const normalized = String(path ?? '').trim();
  if (!normalized) return null;
  try {
    return await realpath(normalized);
  } catch {
    return null;
  }
}

function isPathInside(targetPath: string, allowedDir: string): boolean {
  const rel = relative(allowedDir, targetPath);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function collectBugReportDiagnostics() {
  return await collectBugReportMachineDiagnosticsSnapshotForBugReport();
}

async function readAllowedBugReportLogTail(rawParams: any) {
  const maxBytes = typeof rawParams?.maxBytes === 'number' && Number.isFinite(rawParams.maxBytes)
    ? Math.min(Math.max(Math.floor(rawParams.maxBytes), 1024), 1_000_000)
    : 200_000;
  const path = typeof rawParams?.path === 'string' && rawParams.path.trim().length > 0 ? rawParams.path.trim() : '';
  const diagnostics = await collectBugReportMachineDiagnosticsSnapshotForBugReport();
  const allowedPaths = new Set<string>();
  if (diagnostics.daemonState?.daemonLogPath) {
    allowedPaths.add(diagnostics.daemonState.daemonLogPath.trim());
  }
  for (const entry of diagnostics.daemonLogs) {
    if (typeof entry.path === 'string' && entry.path.trim().length > 0) {
      allowedPaths.add(entry.path.trim());
    }
  }
  for (const entry of diagnostics.stackContext?.logCandidates ?? []) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      allowedPaths.add(entry.trim());
    }
  }

  const canonicalAllowedPaths = new Set<string>();
  for (const candidatePath of allowedPaths) {
    const canonicalPath = await toCanonicalPath(candidatePath);
    if (canonicalPath) {
      canonicalAllowedPaths.add(canonicalPath);
    }
  }

  let canonicalRequestedPath: string | null = null;
  if (path) {
    canonicalRequestedPath = await toCanonicalPath(path);
    if (!canonicalRequestedPath || !canonicalAllowedPaths.has(canonicalRequestedPath)) {
      return {
        ok: false,
        error: 'Requested log path is not allowed for bug report diagnostics',
      };
    }
  }

  const fallbackPath = Array.from(canonicalAllowedPaths)[0] ?? null;
  const targetPath = canonicalRequestedPath ?? fallbackPath;
  if (!targetPath) {
    return {
      ok: false,
      error: 'No daemon log path available',
    };
  }

  try {
    const tail = await readBugReportLogTail(targetPath, maxBytes);
    return {
      ok: true,
      path: targetPath,
      tail,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function createBugReportDiagnosticsRpcActionExecutor(): RpcActionExecutor {
  return {
    execute: async (actionId, input) => {
      if (actionId === 'bugreport.collectDiagnostics') {
        return { ok: true, result: await collectBugReportDiagnostics() };
      }
      if (actionId === 'bugreport.getLogTail') {
        return { ok: true, result: await readAllowedBugReportLogTail(input) };
      }
      if (actionId === 'bugreport.uploadArtifact') {
        const rawParams = input as any;
        return {
          ok: true,
          result: {
            ok: false,
            error: 'Daemon-side upload is not enabled; upload via report service pre-signed URL from UI.',
            uploadUrl: typeof rawParams?.uploadUrl === 'string' ? rawParams.uploadUrl : null,
          },
        };
      }
      return {
        ok: false,
        errorCode: 'unsupported_action',
        error: `unsupported_action:${actionId}`,
      };
    },
  };
}

export function registerMachineDiagnosticsRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  actionExecutor?: RpcActionExecutor;
}>): void {
  const { rpcHandlerManager } = params;

  rpcHandlerManager.registerHandler(RPC_METHODS.SESSION_LOG_TAIL, async (rawParams: any) => {
    const maxBytes = typeof rawParams?.maxBytes === 'number' && Number.isFinite(rawParams.maxBytes)
      ? Math.min(Math.max(Math.floor(rawParams.maxBytes), 1024), 1_000_000)
      : 200_000;
    const path = typeof rawParams?.path === 'string' && rawParams.path.trim().length > 0 ? rawParams.path.trim() : '';
    if (!path) {
      return {
        success: false,
        error: 'Session log path is required',
      };
    }
    if (!path.toLowerCase().endsWith('.log')) {
      return {
        success: false,
        error: 'Session log path must point to a .log file',
      };
    }

    const canonicalRequestedPath = await toCanonicalPath(path);
    if (!canonicalRequestedPath) {
      return {
        success: false,
        error: 'Session log path is unavailable on this machine',
      };
    }

    const canonicalHappyHomeDir = await toCanonicalPath(resolve(configuration.happyHomeDir));
    if (!canonicalHappyHomeDir) {
      return {
        success: false,
        error: 'Happy home directory is unavailable for log validation',
      };
    }

    const allowedRoots = [
      resolve(canonicalHappyHomeDir, 'logs'),
      resolve(canonicalHappyHomeDir, 'stacks'),
    ];
    if (!allowedRoots.some((dir) => isPathInside(canonicalRequestedPath, dir))) {
      return {
        success: false,
        error: 'Requested log path is outside allowed Happier directories',
      };
    }

    try {
      const fileStat = await stat(canonicalRequestedPath);
      const tail = await readBugReportLogTail(canonicalRequestedPath, maxBytes);
      return {
        success: true,
        path: canonicalRequestedPath,
        tail,
        truncated: fileStat.size > maxBytes,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  registerActionSpecRpcHandlers({
    rpcHandlerManager,
    actionExecutor: params.actionExecutor ?? createBugReportDiagnosticsRpcActionExecutor(),
    scopes: BUG_REPORT_RPC_SCOPES,
  });
}
