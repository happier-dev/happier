import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { readBugReportLogTail } from '@/diagnostics/bugReportMachineDiagnostics';
import { collectBugReportMachineDiagnosticsSnapshotForBugReport } from '@/diagnostics/bugReportMachineDiagnosticsRecipe';
import { BugReportDiagnosticsRequestSchema } from '@happier-dev/protocol/bugs/reports/machineDiagnostics';
import type { BugReportMachineDiagnosticsSnapshot } from '@happier-dev/protocol';
import { projectIdentityFreeDiagnosticLogTail, projectIdentityFreeMachineDiagnostics } from '@/diagnostics/identityFreeMachineDiagnostics';
import { projectMachineDoctorSnapshotForAction } from '@happier-dev/protocol/diagnostics/doctorSnapshot';
import { MachineDoctorSnapshotActionInputV1Schema } from '@happier-dev/protocol/actions/specs/machineConnection';
import { configuration } from '@/configuration';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import { BUG_REPORT_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration';
import { createFilesystemEffectAdmission, type FilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

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

async function collectBugReportDiagnostics(input: unknown, scope: Parameters<typeof collectBugReportMachineDiagnosticsSnapshotForBugReport>[1]) {
  const request = BugReportDiagnosticsRequestSchema.parse(input);
  return await collectBugReportMachineDiagnosticsSnapshotForBugReport(
    'sessionId' in request || 'logSelection' in request ? request : undefined, scope,
  );
}

async function readAllowedBugReportLogTail(rawParams: any, signal?: AbortSignal) {
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
    const tail = await readBugReportLogTail(targetPath, maxBytes, { signal });
    return {
      ok: true,
      path: targetPath,
      tail,
    };
  } catch (error) {
    return {
      ok: false,
      ...(readRpcErrorCode(error) ? { errorCode: readRpcErrorCode(error) } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function createBugReportDiagnosticsRpcActionExecutor(): RpcActionExecutor {
  return {
    execute: async (actionId, input, context) => {
      if (actionId === 'bugreport.collectDiagnostics') {
        return { ok: true, result: await collectBugReportDiagnostics(input, {
          ...(context?.signal ? { signal: context.signal } : {}),
        }) };
      }
      if (actionId === 'bugreport.getLogTail') {
        return { ok: true, result: await readAllowedBugReportLogTail(input, context?.signal) };
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
  filesystemEffectAdmission?: FilesystemEffectAdmission;
}>): void {
  const { rpcHandlerManager } = params;
  const admission = params.filesystemEffectAdmission ?? createFilesystemEffectAdmission();
  const executor = params.actionExecutor ?? createBugReportDiagnosticsRpcActionExecutor();

  rpcHandlerManager.registerHandler(RPC_METHODS.MACHINES_DOCTOR_SNAPSHOT, async (rawParams, context) => {
    const request = MachineDoctorSnapshotActionInputV1Schema.safeParse(rawParams);
    if (!request.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    if (!context?.machineAdmission) {
      return { ok: false, errorCode: 'machine_access_denied', error: 'machine_access_denied' };
    }
    if (context.machineAdmission.machineId !== request.data.machineId) {
      return { ok: false, errorCode: 'machine_target_mismatch', error: 'machine_target_mismatch' };
    }
    context.signal.throwIfAborted();
    const { buildDoctorSnapshot } = await import('@/ui/doctorSnapshot');
    const snapshot = await buildDoctorSnapshot();
    context.signal.throwIfAborted();
    return projectMachineDoctorSnapshotForAction(snapshot);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_LOG_TAIL, async (rawParams: any, context) => {
    const failure = await admission.rpc(context);
    if (failure) return { success: false, ...failure };
    if (context?.machineAdmission?.role === 'use') {
      const omitted = projectIdentityFreeDiagnosticLogTail();
      return { success: omitted.ok, error: omitted.error };
    }
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
      const tail = await readBugReportLogTail(canonicalRequestedPath, maxBytes, { signal: context?.signal });
      return {
        success: true,
        path: canonicalRequestedPath,
        tail,
        truncated: fileStat.size > maxBytes,
      };
    } catch (error) {
      return {
        success: false,
        ...(readRpcErrorCode(error) ? { errorCode: readRpcErrorCode(error) } : {}),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  registerActionSpecRpcHandlers({
    rpcHandlerManager,
    actionExecutor: { execute: async (actionId, input, context) => {
      // Both a supplied CLI executor and the local fallback spend the same
      // receiving filesystem authority; neither can borrow daemon log custody.
      const failure = await admission.action(context);
      if (failure) return { ok: false, ...failure };
      const use = context?.machineAdmission?.role === 'use';
      if (actionId === RPC_METHODS.BUGREPORT_GET_LOG_TAIL && use) {
        return { ok: true, result: projectIdentityFreeDiagnosticLogTail() };
      }
      // This daemon resolves a selected Session with its custodian's credentials
      // and markers, never with the Use requester's Session authority, so Use
      // selects no Session: an id or prefix would return another Account's facts.
      const sessionFree = use && actionId === RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS
        && input !== null && typeof input === 'object' && 'sessionId' in input;
      const result = await executor.execute(actionId, sessionFree
        ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'sessionId')) : input, context);
      context?.signal?.throwIfAborted();
      // The installed diagnostics executor owns this output; only the verified
      // ingress role selects its cross-Account disclosure projection.
      return result.ok && actionId === RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS && context?.machineAdmission?.role === 'use'
        ? { ...result, result: projectIdentityFreeMachineDiagnostics(result.result as BugReportMachineDiagnosticsSnapshot) }
        : result;
    } },
    scopes: BUG_REPORT_RPC_SCOPES,
  });
}
