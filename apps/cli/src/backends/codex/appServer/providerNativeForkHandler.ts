import { buildCodexAgentRuntimeDescriptor, resolvePersistedCodexRuntimeIdentity, resolveVendorResumeIdFromSessionMetadata, readSessionMetadataRuntimeDescriptor } from '@happier-dev/agents';
import {
  ProviderNativeForkFailedBeforeDispatchError,
  ProviderNativeForkIndeterminateError,
  type ProviderNativeForkHandler,
} from '@/backends/forking/providerNativeForkHandler';
import { logger } from '@/utils/logger';

import { forkCodexAppServerConversationNative } from './nativeFork';
import { sanitizeCodexAppServerRpcDiagnosticString } from './client/codexAppServerRpcLogSanitizer';
import { resolveCodexAppServerProcessEnv } from './resolveCodexAppServerProcessEnv';

function readErrorDiagnostic(error: unknown, redactedValues: readonly string[]): Readonly<{
  errorName: string;
  errorMessage: string;
  errorCode?: string | number;
}> {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const rawErrorCode = record && (typeof record.code === 'string' || typeof record.code === 'number')
    ? record.code
    : undefined;
  const errorCode = typeof rawErrorCode === 'string'
    ? sanitizeCodexAppServerRpcDiagnosticString(rawErrorCode, { redactedValues })
    : rawErrorCode;
  if (error instanceof Error) {
    return {
      errorName: error.name || 'Error',
      errorMessage: sanitizeCodexAppServerRpcDiagnosticString(error.message, { redactedValues }),
      ...(errorCode !== undefined ? { errorCode } : {}),
    };
  }
  return {
    errorName: typeof error,
    errorMessage: sanitizeCodexAppServerRpcDiagnosticString(String(error), { redactedValues }),
    ...(errorCode !== undefined ? { errorCode } : {}),
  };
}

function logCodexNativeForkDiagnostic(message: string, details: Record<string, unknown>): void {
  try {
    logger.debug(message, details);
  } catch {
    // Diagnostics must never affect fork behavior.
  }
}

export const codexAppServerProviderNativeForkHandler: ProviderNativeForkHandler = async (params) => {
  const runtimeIdentity = readSessionMetadataRuntimeDescriptor(params.parentMetadata, 'codex');
  const backendMode = runtimeIdentity?.backendMode ?? resolvePersistedCodexRuntimeIdentity(params.parentMetadata)?.backendMode ?? null;
  const vendorSessionIdRaw = resolveVendorResumeIdFromSessionMetadata('codex', params.parentMetadata) ?? '';
  const forkPointType = params.forkPoint.type;
  const baseDiagnostic = {
    agentId: params.agentId,
    parentSessionId: params.parentSessionId,
    backendMode,
    forkPointType,
    targetSeqInclusive: params.targetSeqInclusive,
    hasRuntimeDescriptor: Boolean(runtimeIdentity),
    hasVendorSessionId: vendorSessionIdRaw.trim().length > 0,
    hasRuntimeHomePath: typeof runtimeIdentity?.homePath === 'string' && runtimeIdentity.homePath.trim().length > 0,
  };

  const skipReason = (() => {
    if (backendMode !== 'appServer') return 'backend_mode_not_app_server';
    if (!vendorSessionIdRaw) return 'vendor_session_id_missing';
    if (forkPointType !== 'latest') return 'fork_point_not_latest';
    return null;
  })();
  if (skipReason) {
    logCodexNativeForkDiagnostic('[CodexAppServerFork] skipping native fork', {
      ...baseDiagnostic,
      skipReason,
      fallbackResult: 'fallback_to_replay',
    });
    return null;
  }

  const processEnv = await resolveCodexAppServerProcessEnv({
    processEnv: process.env,
    affinity: runtimeIdentity,
  });

  logCodexNativeForkDiagnostic('[CodexAppServerFork] attempting native latest fork', {
    ...baseDiagnostic,
  });

  let outcome: Awaited<ReturnType<typeof forkCodexAppServerConversationNative>>;
  try {
    outcome = await forkCodexAppServerConversationNative({
      directory: params.directory,
      parentCodexSessionId: vendorSessionIdRaw,
      processEnv,
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch (error) {
    if (params.signal?.aborted && error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    logCodexNativeForkDiagnostic('[CodexAppServerFork] native latest fork outcome is indeterminate', {
      ...baseDiagnostic,
      ...readErrorDiagnostic(error, [vendorSessionIdRaw]),
      fallbackResult: 'do_not_replay_outcome_unknown',
    });
    throw new ProviderNativeForkIndeterminateError();
  }

  if (outcome.type === 'unsupported') {
    logCodexNativeForkDiagnostic('[CodexAppServerFork] native latest fork unsupported', {
      ...baseDiagnostic,
      fallbackResult: 'fallback_to_replay',
    });
    return null;
  }

  if (outcome.type === 'failed_before_dispatch') {
    logCodexNativeForkDiagnostic('[CodexAppServerFork] native latest fork failed', {
      ...baseDiagnostic,
      ...readErrorDiagnostic(outcome.error, [vendorSessionIdRaw]),
      fallbackResult: 'failed_before_dispatch',
    });
    throw new ProviderNativeForkFailedBeforeDispatchError(outcome.error);
  }

  if (outcome.type === 'indeterminate_after_dispatch') {
    logCodexNativeForkDiagnostic('[CodexAppServerFork] native latest fork outcome is indeterminate', {
      ...baseDiagnostic,
      ...readErrorDiagnostic(outcome.error, [vendorSessionIdRaw]),
      fallbackResult: 'do_not_replay_outcome_unknown',
    });
    throw new ProviderNativeForkIndeterminateError();
  }

  const vendorSessionId = outcome.vendorSessionId.trim();
  if (!vendorSessionId) {
    logCodexNativeForkDiagnostic('[CodexAppServerFork] native latest fork returned no vendor session id', {
      ...baseDiagnostic,
      fallbackResult: 'fallback_to_replay',
    });
    return null;
  }

  const providerHint = {
    providerId: params.agentId,
    backendMode: 'appServer',
    vendorSessionId,
  };
  const childMetadataHomePath = runtimeIdentity?.home === 'connectedService'
    ? null
    : runtimeIdentity?.homePath ?? null;
  const childMetadataSqliteHomePath = runtimeIdentity?.home === 'connectedService'
    ? null
    : runtimeIdentity?.sqliteHomePath ?? null;

  logCodexNativeForkDiagnostic('[CodexAppServerFork] native latest fork succeeded', {
    ...baseDiagnostic,
    hasForkedVendorSessionId: true,
    fallbackResult: 'native_fork_succeeded',
  });

  return {
    vendorSessionId,
    spawn: {
      resume: vendorSessionId,
      codexBackendMode: 'appServer',
      ...(runtimeIdentity?.homePath
        ? {
            environmentVariables: {
              CODEX_HOME: runtimeIdentity.homePath,
              CODEX_SQLITE_HOME: processEnv.CODEX_SQLITE_HOME ?? runtimeIdentity.homePath,
            },
          }
        : {}),
    },
    metadata: {
      codexSessionId: vendorSessionId,
      codexBackendMode: 'appServer',
      ...(runtimeIdentity
        ? {
            agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
              backendMode: 'appServer',
              vendorSessionId,
              home: runtimeIdentity.home,
              connectedServiceId: runtimeIdentity.connectedServiceId,
              connectedServiceProfileId: runtimeIdentity.connectedServiceProfileId,
              connectedServiceGroupId: runtimeIdentity.connectedServiceGroupId,
              homePath: childMetadataHomePath,
              sqliteHomePath: childMetadataSqliteHomePath,
            }),
          }
        : {}),
    },
    providerHint,
  };
};
