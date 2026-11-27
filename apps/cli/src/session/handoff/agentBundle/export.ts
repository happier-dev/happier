import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { SessionHandoffAgentBundle } from '../types';
import {
  readDeclaredVendorHandoffRefusal,
  projectSessionMetadataForAgentHandoff,
  readProviderSessionIdSessionState,
  resolveAgentIdFromSessionMetadata,
} from '@happier-dev/agents';
import { resolveLinkedExternalSessionAuthorityV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';

import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { resolveConnectedServicesMaterializationBaseDir } from '@/daemon/connectedServices/materialize/resolveConnectedServicesMaterializationBaseDir';
import type { RequesterWorkAttributionV1 } from '@happier-dev/protocol/machines/requesterWorkAttributionV1';
import { resolveRequesterSessionRuntimeDirectories } from '@/daemon/sessionEncryption/requesterSessionRuntimeDirectories';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { listSessionHandoffAgentBundleSourceFilePaths } from './file';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export type PreparedSessionHandoffAgentBundleExport = () => Promise<Readonly<{
  agentBundle: SessionHandoffAgentBundle;
  targetPath: string;
}>>;

/**
 * A requester's Session runs on Agent homes its launch owner placed under that
 * Account's own roots. Its runtime descriptor arrives from the requester's own
 * Session metadata, so the files an export carries must come from those roots,
 * never from the Machine owner's or another Account's storage.
 */
function assertRequesterOwnsBundleSources(params: Readonly<{
  bundle: unknown;
  activeServerDir: string;
  requester: Pick<RequesterWorkAttributionV1, 'accountId'>;
}>): void {
  const roots = resolveRequesterSessionRuntimeDirectories({
    activeServerDir: params.activeServerDir,
    connectedServicesMaterializationBaseDir: resolveConnectedServicesMaterializationBaseDir(configuration.happyHomeDir),
    attribution: params.requester,
  });
  const outside = listSessionHandoffAgentBundleSourceFilePaths(params.bundle).some(filePath =>
    !isCanonicalAbsolutePathInsideRoot(roots.activeServerDir, filePath)
    && !isCanonicalAbsolutePathInsideRoot(roots.connectedServicesMaterializationBaseDir, filePath));
  if (!outside) return;
  throw createActionExecuteFailureError({
    ok: false,
    errorCode: 'handoff_failed',
    error: "The Session's recorded Agent home is not in its requester's own storage on this Machine",
    failureCause: { phase: 'session_handoff.source_export', errorClass: 'Error', errorCode: 'handoff_failed', httpStatus: null },
  });
}

/** Resolve export eligibility before Stop; read the final native snapshot afterwards. */
export async function prepareSessionHandoffAgentBundleExport(params: Readonly<{
  metadata: unknown;
  activeServerDir: string;
  /** The requester bound to this Session at admission; absent for the Machine's own Sessions. */
  requester?: Pick<RequesterWorkAttributionV1, 'accountId'>;
}>): Promise<PreparedSessionHandoffAgentBundleExport> {
  const metadata = asRecord(params.metadata);
  if (!metadata) {
    throw new Error('Session metadata is unavailable');
  }

  const externalSessionLinkAuthority = resolveLinkedExternalSessionAuthorityV1(metadata);
  const linkedSession = externalSessionLinkAuthority.ok && externalSessionLinkAuthority.transcriptStorage === 'direct'
    ? externalSessionLinkAuthority.linkedSession : null;
  const sessionAgentId = linkedSession?.agentId ?? resolveAgentIdFromSessionMetadata(metadata, null);
  const refusal = externalSessionLinkAuthority.ok ? readDeclaredVendorHandoffRefusal(sessionAgentId) : null;
  if (refusal) {
    throw createActionExecuteFailureError({
      ...refusal,
      failureCause: { phase: 'session_handoff.source_export', errorClass: 'Error', errorCode: refusal.errorCode, httpStatus: null },
    });
  }

  const agentMetadata = projectSessionMetadataForAgentHandoff(metadata);
  const sessionProviderSessionId = readProviderSessionIdSessionState(metadata).value;
  const bridge = getSessionHostBridge();
  const eligibility = await bridge.resolveSessionHandoffEligibility({
    metadata: agentMetadata,
    sourceMachineId: metadata.machineId,
    externalSessionLinkAuthority,
    ...(sessionAgentId ? { sessionAgentId } : {}),
    ...(sessionProviderSessionId ? { sessionProviderSessionId } : {}),
  });
  if (!eligibility.eligible) {
    throw new Error(`Session is not eligible for handoff: ${eligibility.reasonCode}`);
  }

  const targetPath = typeof metadata.path === 'string' ? metadata.path.trim() : '';
  if (!targetPath) {
    throw new Error('Session path is unavailable for handoff');
  }

  const currentRuntime = await bridge.resolveCurrentExecutionSurfacesForCatalogAgent(
    eligibility.agentId,
  );
  const providerOps = currentRuntime
    && currentRuntime.agentId === eligibility.agentId
    && currentRuntime.backendId === eligibility.backendId
    ? currentRuntime.executionSurfaces.handoff
    : null;
  if (!providerOps) {
    throw new Error(`Unsupported handoff provider: ${eligibility.agentId}`);
  }

  return async () => {
    const agentBundle = await providerOps.exportBundle({
      sessionId: eligibility.vendorHandoffId,
      metadata: agentMetadata,
      directory: params.activeServerDir,
    });
    if (!agentBundle.ok) {
      const closedMessage = `Session handoff export failed: ${agentBundle.code}`;
      // A requester's own metadata names the home the Agent read; its free text can describe
      // another person's files. The requester gets the closed message; the Machine log keeps the cause.
      if (params.requester && agentBundle.message) {
        logger.warnLocalFile('[session-handoff] requester source export refused', { errorClass: 'Error',
          errorCode: agentBundle.code, message: agentBundle.message });
      }
      throw createActionExecuteFailureError({
        ok: false,
        errorCode: agentBundle.code,
        error: params.requester ? closedMessage : agentBundle.message ?? closedMessage,
        ...(agentBundle.diagnostics?.length ? { details: { diagnostics: agentBundle.diagnostics } } : {}),
        failureCause: { phase: 'session_handoff.source_export', errorClass: 'Error',
          errorCode: agentBundle.code, httpStatus: null },
      });
    }
    if (params.requester) {
      assertRequesterOwnsBundleSources({ bundle: agentBundle.value.bundle, activeServerDir: params.activeServerDir,
        requester: params.requester });
    }
    return {
      agentBundle: agentBundle.value.bundle as SessionHandoffAgentBundle,
      targetPath,
    };
  };
}

export async function exportSessionHandoffAgentBundle(params: Readonly<{
  metadata: unknown;
  activeServerDir: string;
}>): ReturnType<PreparedSessionHandoffAgentBundleExport> {
  return await (await prepareSessionHandoffAgentBundleExport(params))();
}
