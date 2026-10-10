import type { CatalogAgentId } from '@/agent/catalog/ids';
import { isCatalogAgentId } from '@/agent/catalog/resolution';
import { buildConfiguredAcpBackendSessionMetadata } from '@/agent/acp/catalog/configured/sessionMetadata';
import type { StoredCredentials } from '@/persistence';
import { resolveAvailableAccountSettings } from '@/settings/accountSettings/resolveAvailableAccountSettings';
import type { BackendTargetRefV1, BackendTargetRefV2 } from '@happier-dev/protocol';
import { readAcpConfiguredBackendV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/acpConfiguredBackendV1';
import { isInvalidNestedLegacyCustomAcpPlaceholder, readLegacyConfiguredAcpBackendId } from '@happier-dev/protocol/backends/targets/compat/customAcp';
import { resolveLinkedExternalSessionMetadataV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { resolveConfiguredAcpBackendFromAccountSettings } from '@/agent/acp/catalog/configured/resolveBackend';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveConcreteCompatBackendTargetRefs } from '@/session/backendTargets/resolveConcreteBackendTargetRefs';
import { isConcreteLegacyConfiguredBackendId } from '@/session/backendTargets/compat/legacyConfiguredBackend';

export type SessionForkBackendTargetResolution =
  | Readonly<{
      ok: true;
      catalogAgentId: CatalogAgentId;
      agentHintAgentId: string;
      backendTargetV2: BackendTargetRefV2;
      backendTarget: BackendTargetRefV1;
      replayFlavor: string;
      metadataOverlay: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      ok: true;
      catalogAgentId: null;
      agentHintAgentId: string;
      backendTargetV2: BackendTargetRefV2;
      backendTarget: Readonly<{ kind: 'configuredAcpBackend'; backendId: string }>;
      replayFlavor: string;
      metadataOverlay: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      ok: false;
      errorMessage: string;
    }>;

export async function resolveSessionForkBackendTarget(params: Readonly<{
  parentMetadata: Record<string, unknown>;
  credentials: StoredCredentials;
}>): Promise<SessionForkBackendTargetResolution> {
  const linkedSessionResolution = resolveLinkedExternalSessionMetadataV1(
    params.parentMetadata,
  );
  if (
    !linkedSessionResolution.ok
    && linkedSessionResolution.error !== 'linked_session_not_found'
  ) {
    return {
      ok: false,
      errorMessage: linkedSessionResolution.error,
    };
  }

  const metadataConfiguredBackend = readAcpConfiguredBackendV1FromMetadata(params.parentMetadata);
  const flavorConfiguredBackendId = readLegacyConfiguredAcpBackendId(params.parentMetadata.flavor);
  const candidateConfiguredBackendId = metadataConfiguredBackend?.backendId ?? flavorConfiguredBackendId ?? null;

  if (candidateConfiguredBackendId) {
    if (!isConcreteLegacyConfiguredBackendId(candidateConfiguredBackendId)) {
      return {
        ok: false,
        errorMessage: 'Session metadata missing configured backend flavor',
      };
    }
    const scopeKey = resolveAccountSettingsScopeKey(params.credentials);
    const accountSettings = await resolveAvailableAccountSettings({ credentials: params.credentials });
    let accountSnapshot = getActiveAccountSettingsSnapshot();
    const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
    if (!accountSettings || accountSnapshot?.scopeKey !== scopeKey) {
      return { ok: false, errorMessage: 'Configured ACP catalog is unavailable' };
    }
    if (accountSnapshot.acpCatalog?.status !== 'ready') {
      try {
        const { refreshActiveAcpCatalog } = await import('@/agent/acp/catalog/hydrateAcpCatalog');
        await refreshActiveAcpCatalog({ credentials: params.credentials });
      } catch {
        return { ok: false, errorMessage: 'Configured ACP catalog is unavailable' };
      }
      accountSnapshot = getActiveAccountSettingsSnapshot();
    }
    if (getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken
      || accountSnapshot?.scopeKey !== scopeKey || accountSnapshot.acpCatalog?.status !== 'ready') {
      return { ok: false, errorMessage: 'Configured ACP catalog is unavailable' };
    }
    const resolvedConfiguredBackend = resolveConfiguredAcpBackendFromAccountSettings(
      accountSnapshot.settings,
      candidateConfiguredBackendId,
      accountSnapshot.acpCatalog,
    );

    if (resolvedConfiguredBackend) {
      const title = resolvedConfiguredBackend.title;
      const backendTarget = { kind: 'configuredAcpBackend', backendId: candidateConfiguredBackendId } as const;
      const backendTargetRefs = resolveConcreteCompatBackendTargetRefs(backendTarget);
      if (!backendTargetRefs) {
        return {
          ok: false,
          errorMessage: 'Session metadata missing configured backend flavor',
        };
      }
      return {
        ok: true,
        catalogAgentId: null,
        agentHintAgentId: `acp:${candidateConfiguredBackendId}`,
        backendTargetV2: backendTargetRefs.backendTargetV2,
        backendTarget,
        replayFlavor: `acp:${candidateConfiguredBackendId}`,
        metadataOverlay: buildConfiguredAcpBackendSessionMetadata({
          backendId: candidateConfiguredBackendId,
          title,
        }),
      };
    }
    return { ok: false, errorMessage: 'Session metadata missing configured backend flavor' };
  }

  if (
    typeof params.parentMetadata.flavor === 'string'
    && isInvalidNestedLegacyCustomAcpPlaceholder(params.parentMetadata.flavor)
  ) {
    return {
      ok: false,
      errorMessage: 'Session metadata missing agent flavor',
    };
  }

  const agentRaw = resolveAgentIdFromSessionMetadata(params.parentMetadata);
  if (!agentRaw || !isCatalogAgentId(agentRaw)) {
    return {
      ok: false,
      errorMessage: 'Session metadata missing agent flavor',
    };
  }

  const backendTargetRefs = resolveConcreteCompatBackendTargetRefs({
    kind: 'builtInAgent',
    agentId: agentRaw,
  });
  if (!backendTargetRefs) {
    return {
      ok: false,
      errorMessage: 'Session metadata missing agent flavor',
    };
  }

  return {
    ok: true,
    catalogAgentId: agentRaw,
    agentHintAgentId: agentRaw,
    backendTargetV2: backendTargetRefs.backendTargetV2,
    backendTarget: backendTargetRefs.backendTarget,
    replayFlavor: agentRaw,
    metadataOverlay: {},
  };
}
