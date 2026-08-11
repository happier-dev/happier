import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';
import { resolve } from 'node:path';

import type { ConnectedServiceRuntimeAuthSelectionMaterializer } from '@/daemon/connectedServices/sessionAuthSwitch/runtimeAuthSelectionMaterializerTypes';
import type { ConnectedServiceResolvedSelection } from '@/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn';
import { resolveExistingSessionAttachContext } from '@/daemon/sessionEncryption/resolveExistingSessionAttachContext';
import { resolveTrackedConnectedServiceSwitchContinuityContext } from '@/daemon/connectedServices/sessionAuthSwitch/resolveTrackedConnectedServiceSwitchContinuityContext';
import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import type { Credentials } from '@/persistence';

import { materializeClaudeConnectedServiceSelection } from './materializeClaudeConnectedServiceSelection';
import { resolveClaudeConnectedServiceStableConfigDir } from './resolveClaudeConnectedServiceStableAuthDir';
import {
  CLAUDE_RUNTIME_AUTH_SHARED_GROUP_SURFACE_METADATA_KEY,
  buildClaudeRuntimeAuthSharedGroupSurfaceMetadata,
  readClaudeRuntimeAuthSharedGroupSurfaceMetadata,
} from './claudeRuntimeAuthSharedGroupSurfaceMetadata';
import { resolveClaudeConnectedServiceCandidatePersistedSessionFile } from './resolveClaudeConnectedServiceCandidatePersistedSessionFile';
import { createConnectedServiceGroupMutationCurrentnessValidator } from '@/daemon/connectedServices/credentials/createConnectedServiceGroupMutationCurrentnessValidator';

function readCredentialRecord(value: unknown): ConnectedServiceCredentialRecordV1 | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as ConnectedServiceCredentialRecordV1
    : null;
}

function readBinding(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftTrimmed = left.trim();
  const rightTrimmed = right.trim();
  return leftTrimmed.length > 0 && rightTrimmed.length > 0 && resolve(leftTrimmed) === resolve(rightTrimmed);
}

function trackedRuntimeTargetsClaudeSharedGroupConfig(
  trackedEnv: NodeJS.ProcessEnv | undefined,
  runtimeClaudeConfigDir: string,
): boolean {
  return samePath(trackedEnv?.CLAUDE_CONFIG_DIR, runtimeClaudeConfigDir)
    || samePath(
      trackedEnv?.[HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY],
      runtimeClaudeConfigDir,
    );
}

async function resolvePersistedClaudeSessionMetadata(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  agentId: 'claude';
}>): Promise<Record<string, unknown> | null> {
  const token = typeof params.credentials.token === 'string' ? params.credentials.token.trim() : '';
  if (!token) return null;
  const attachContext = await resolveExistingSessionAttachContext({
    token,
    sessionId: params.sessionId,
    agent: params.agentId,
    credentials: params.credentials,
  }).catch(() => null);
  return attachContext?.ok === true ? attachContext.metadata : null;
}

function buildSelection(params: Readonly<{
  serviceId: ConnectedServiceId;
  record: ConnectedServiceCredentialRecordV1;
  binding: unknown;
  profileId: string;
  groupId?: string;
  activeProfileId?: string;
  fallbackProfileId?: string;
  generation?: number;
  credentialRevision?: Parameters<ReturnType<typeof createConnectedServiceGroupMutationCurrentnessValidator>>[0]['credentialRevision'];
}>): ConnectedServiceResolvedSelection | null {
  const binding = readBinding(params.binding);
  if (binding?.selection === 'group') {
    const groupId = typeof params.groupId === 'string' && params.groupId.trim().length > 0
      ? params.groupId.trim()
      : null;
    const activeProfileId = typeof params.activeProfileId === 'string' && params.activeProfileId.trim().length > 0
      ? params.activeProfileId.trim()
      : params.profileId;
    const fallbackProfileId = typeof params.fallbackProfileId === 'string' && params.fallbackProfileId.trim().length > 0
      ? params.fallbackProfileId.trim()
      : activeProfileId;
    const generation = typeof params.generation === 'number' && Number.isFinite(params.generation)
      ? params.generation
      : 0;
    if (!groupId) return null;
    return {
      kind: 'group',
      serviceId: params.serviceId,
      groupId,
      activeProfileId,
      fallbackProfileId,
      generation,
      credentialRevision: params.credentialRevision ?? null,
      record: params.record,
      policy: null,
    };
  }

  return {
    kind: 'profile',
    serviceId: params.serviceId,
    profileId: params.profileId,
    record: params.record,
  };
}

function buildPreflightRuntimeAuthSelection(params: Readonly<{
  activeServerDir: string;
  serviceId: ConnectedServiceId;
  baseSelection: Parameters<ConnectedServiceRuntimeAuthSelectionMaterializer>[0]['baseSelection'];
  record: ConnectedServiceCredentialRecordV1;
  selection: ConnectedServiceResolvedSelection | null;
}>): unknown {
  if (params.serviceId !== 'claude-subscription' || params.selection?.kind !== 'group') {
    return params.baseSelection;
  }

  const runtimeClaudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
    activeServerDir: params.activeServerDir,
    serviceId: 'claude-subscription',
    fallbackProfileId: params.selection.fallbackProfileId,
    selection: params.selection,
  });
  if (!runtimeClaudeConfigDir) return params.baseSelection;

  const sourceClaudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
    activeServerDir: params.activeServerDir,
    serviceId: 'claude-subscription',
    fallbackProfileId: params.selection.activeProfileId,
    selection: {
      kind: 'profile',
      serviceId: 'claude-subscription',
      profileId: params.selection.activeProfileId,
      record: params.record,
    },
  });
  const sharedGroupSurfaceMetadata = buildClaudeRuntimeAuthSharedGroupSurfaceMetadata({
    runtimeClaudeConfigDir,
    runtimeMaterializedRoot: runtimeClaudeConfigDir,
    sourceClaudeConfigDir,
  });
  if (!sharedGroupSurfaceMetadata) return params.baseSelection;
  return {
    ...params.baseSelection,
    targetMaterializedEnv: {
      CLAUDE_CONFIG_DIR: sharedGroupSurfaceMetadata.runtimeClaudeConfigDir,
    },
    targetMaterializedRoot: sharedGroupSurfaceMetadata.runtimeMaterializedRoot,
    [CLAUDE_RUNTIME_AUTH_SHARED_GROUP_SURFACE_METADATA_KEY]: sharedGroupSurfaceMetadata,
  };
}

export const materializeClaudeConnectedServiceRuntimeAuthSelection: ConnectedServiceRuntimeAuthSelectionMaterializer = async (
  params,
) => {
  if (params.input.agentId !== 'claude') return params.baseSelection;
  if (params.input.serviceId !== 'claude-subscription' && params.input.serviceId !== 'anthropic') {
    return params.baseSelection;
  }
  const activeServerDir = typeof params.activeServerDir === 'string' && params.activeServerDir.trim().length > 0
    ? params.activeServerDir.trim()
    : '';
  if (!activeServerDir) return params.baseSelection;

  const record = readCredentialRecord(params.baseSelection.record);
  if (!record) return params.baseSelection;
  const selection = buildSelection({
    serviceId: params.input.serviceId,
    record,
    binding: params.baseSelection.binding,
    profileId: params.baseSelection.profileId,
    ...(typeof params.baseSelection.groupId === 'string' ? { groupId: params.baseSelection.groupId } : {}),
    ...(typeof params.baseSelection.activeProfileId === 'string' ? { activeProfileId: params.baseSelection.activeProfileId } : {}),
    ...(typeof params.baseSelection.fallbackProfileId === 'string' ? { fallbackProfileId: params.baseSelection.fallbackProfileId } : {}),
    ...(typeof params.baseSelection.generation === 'number' ? { generation: params.baseSelection.generation } : {}),
    ...(params.input.expectedCredentialRevision
      ? { credentialRevision: params.input.expectedCredentialRevision }
      : {}),
  });
  const sharedGroupRuntimeAuthSelection = buildPreflightRuntimeAuthSelection({
    activeServerDir,
    serviceId: params.input.serviceId,
    baseSelection: params.baseSelection,
    record,
    selection,
  });
  if (params.input.mode === 'preflight') return sharedGroupRuntimeAuthSelection;
  const preflightSharedGroupMetadata = readClaudeRuntimeAuthSharedGroupSurfaceMetadata(
    sharedGroupRuntimeAuthSelection,
  );
  if (
    preflightSharedGroupMetadata
    && trackedRuntimeTargetsClaudeSharedGroupConfig(
      params.input.tracked.spawnOptions?.environmentVariables,
      preflightSharedGroupMetadata.runtimeClaudeConfigDir,
    )
  ) {
    return sharedGroupRuntimeAuthSelection;
  }
  const trackedContinuityContext = resolveTrackedConnectedServiceSwitchContinuityContext({
    agentId: params.input.agentId,
    baseDir: activeServerDir,
    tracked: params.input.tracked,
    resolveCandidatePersistedSessionFile: (_agentId, metadata) =>
      resolveClaudeConnectedServiceCandidatePersistedSessionFile({ metadata }),
  });
  // RD-CLD-1/RD-MAT-4: tracked state alone (hook-reported webhook metadata / spawn resume) can be
  // empty on early-turn failures or thin re-attach markers. Fall back to the server-persisted
  // session metadata — the same source the FSM continuity gate consults — so the switch-time
  // rematerialization can still carry the vendor session file instead of silently skipping it.
  const continuityContext = trackedContinuityContext.candidatePersistedSessionFile
    ? trackedContinuityContext
    : resolveTrackedConnectedServiceSwitchContinuityContext({
        agentId: params.input.agentId,
        baseDir: activeServerDir,
        tracked: params.input.tracked,
        persistedSessionMetadata: await resolvePersistedClaudeSessionMetadata({
          credentials: params.credentials,
          sessionId: params.input.sessionId,
          agentId: params.input.agentId,
        }),
        resolveCandidatePersistedSessionFile: (_agentId, metadata) =>
          resolveClaudeConnectedServiceCandidatePersistedSessionFile({ metadata }),
      });
  const materialized = await materializeClaudeConnectedServiceSelection({
    activeServerDir,
    serviceId: params.input.serviceId,
    record,
    fallbackProfileId: params.baseSelection.profileId,
    selection,
    processEnv: params.processEnv ?? process.env,
    accountSettings: params.accountSettings ?? null,
    sessionDirectory: params.input.tracked.spawnOptions?.directory ?? null,
    vendorResumeId: continuityContext.vendorResumeId,
    candidatePersistedSessionFile: continuityContext.candidatePersistedSessionFile,
    validateGroupMutationCurrentness: createConnectedServiceGroupMutationCurrentnessValidator({
      api: params.api,
      credentials: params.credentials,
    }),
  });
  if (!materialized) return params.baseSelection;

  const materializedClaudeConfigDir = materialized.env.CLAUDE_CONFIG_DIR;
  const sourceClaudeConfigDir = selection?.kind === 'group' && params.input.serviceId === 'claude-subscription'
    ? resolveClaudeConnectedServiceStableConfigDir({
        activeServerDir,
        serviceId: 'claude-subscription',
        fallbackProfileId: selection.activeProfileId,
        selection: {
          kind: 'profile',
          serviceId: 'claude-subscription',
          profileId: selection.activeProfileId,
          record,
        },
      })
    : null;
  const sharedGroupSurfaceMetadata = params.input.serviceId === 'claude-subscription'
    && selection?.kind === 'group'
    ? buildClaudeRuntimeAuthSharedGroupSurfaceMetadata({
        runtimeClaudeConfigDir: materializedClaudeConfigDir,
        runtimeMaterializedRoot: materialized.targetMaterializedRoot,
        sourceClaudeConfigDir,
      })
    : null;
  if (sharedGroupSurfaceMetadata) {
    return {
      ...params.baseSelection,
      targetMaterializedEnv: {
        CLAUDE_CONFIG_DIR: sharedGroupSurfaceMetadata.runtimeClaudeConfigDir,
      },
      targetMaterializedRoot: sharedGroupSurfaceMetadata.runtimeMaterializedRoot,
      materializationDiagnostics: materialized.diagnostics,
      [CLAUDE_RUNTIME_AUTH_SHARED_GROUP_SURFACE_METADATA_KEY]: sharedGroupSurfaceMetadata,
    };
  }

  return {
    ...params.baseSelection,
    targetMaterializedEnv: materialized.env,
    targetMaterializedRoot: materialized.targetMaterializedRoot,
    materializationDiagnostics: materialized.diagnostics,
  };
};
