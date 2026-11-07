import { randomUUID } from 'node:crypto';

import type { ApiClient } from '@/api/api';
import { resolveConnectedServiceCredentialResolutions } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import type { StoredCredentials } from '@/persistence';
import {
  readConnectedServiceChildSelectionsFromEnv,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { createConnectedServiceRuntimeAuthNativeHome } from '@/daemon/connectedServices/runtimeAuth/createRuntimeAuthNativeHome';
import { createSessionConnectedServiceAuthTransport } from '@/session/runtime/control/transport';
import {
  type AccountSettings,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceCredentialRevisionV1,
  type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import type { ConnectedAccountPurposeBindingOwner } from '../purposeBindings/ConnectedAccountPurposeBindingOwner';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { materializeConnectedServicesForSpawn } from '../materialize/materializeConnectedServicesForSpawn';
import { resolveConnectedServiceNativeHomeTarget } from '../materialize/resolveConnectedServiceNativeHomeTarget';
import type { validateConnectedServiceGroupMutationCurrentness } from '../accountGroups/generation/validateGroupMutationCurrentness';
import { ConnectedServiceGroupMutationCurrentnessError } from '../accountGroups/generation/groupMutationCurrentnessFailure';
import type { ConnectedServicesMaterializationDiagnostic } from '../materialization/materializer';
import { readQualifiedConnectedAccountCredentialMaterial, readQualifiedConnectedAccountCredentialIdentity } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey, resolveQualifiedConnectedAccountServiceForIngressServiceId } from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';

import type { SessionConnectedServiceRuntimeAuthSelectionMaterializerInput } from './switchSessionConnectedServiceAuth';
import { resolveTrackedConnectedServiceSwitchContinuityContext } from './resolveTrackedConnectedServiceSwitchContinuityContext';
import { readConnectedServiceCredentialProviderAccountId } from '../shared/connectedServiceCredentialRecord';
import { createConnectedServiceAuthGenerationApplyFailureError } from '../runtimeAuth/connectedServiceAuthGenerationApplyFailure';

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function materializeSessionConnectedServiceRuntimeAuthSelection(params: Readonly<{
  credentials: StoredCredentials;
  api: ApiClient;
  activeServerDir?: string;
  baseDir?: string;
  connectedAccountsOwner?: StablePluginConnectedAccountsOwner;
  activatePurposeBindings?: ConnectedAccountPurposeBindingOwner['activatePurposeBindings'];
  validateGroupMutationCurrentness?: (input: Parameters<typeof validateConnectedServiceGroupMutationCurrentness>[0]['input'])
    => ReturnType<typeof validateConnectedServiceGroupMutationCurrentness>;
  input: SessionConnectedServiceRuntimeAuthSelectionMaterializerInput;
  accountSettings?: AccountSettings | null;
  processEnv?: NodeJS.ProcessEnv;
  allowNativeAccountState?: boolean;
}>): Promise<unknown | null> {
  if (params.input.next.source !== 'connected') return null;
  const legacyServiceId =
    resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
      params.input.serviceId,
    );
  const binding = params.input.normalizedBindings.bindingsByServiceId[params.input.serviceId];
  if (!binding || binding.source !== 'connected') return null;

  if (typeof params.api.getAccountEncryptionMode !== 'function') return null;
  const previousSelections = readConnectedServiceChildSelectionsFromEnv(
    params.input.tracked?.spawnOptions?.environmentVariables ?? {},
  );
  const previousSelection = previousSelections?.get(params.input.serviceId) ?? null;
  const previousGroupSelection =
    binding.selection === 'group'
    && previousSelection?.kind === 'group'
    && previousSelection.groupId === binding.groupId
      ? previousSelection
      : null;
  const groupMetadata =
    binding.selection === 'group'
    && params.input.groupMetadata?.groupId === binding.groupId
      ? params.input.groupMetadata
      : null;
  const profileId = binding.selection === 'group'
    ? readNonEmptyString(params.input.next.profileId)
      || readNonEmptyString(groupMetadata?.activeProfileId)
      || readNonEmptyString(previousGroupSelection?.activeProfileId)
      || readNonEmptyString(binding.profileId)
    : readNonEmptyString(binding.profileId);
  if (!profileId) return null;

  let record: ConnectedServiceCredentialRecordV1 | undefined;
  let credentialRevision: ConnectedServiceCredentialRevisionV1;
  let providerAccountIdentity: Readonly<{ providerAccountId: string | null; providerOrganizationId: string | null }> = {
    providerAccountId: null, providerOrganizationId: null,
  };
  if (legacyServiceId) {
    const resolutions = await resolveConnectedServiceCredentialResolutions({
      credentials: params.credentials,
      api: params.api,
      bindings: [{ serviceId: legacyServiceId, profileId }],
    });
    const resolution = resolutions.get(legacyServiceId);
    if (resolution?.revisionSemantics !== 'revisioned') {
      if (binding.selection === 'group') throw createConnectedServiceAuthGenerationApplyFailureError({ errorCode: 'credential_revision_missing' });
      return null;
    }
    record = resolution.record;
    credentialRevision = resolution.credentialRevision;
    providerAccountIdentity = {
      providerAccountId: readConnectedServiceCredentialProviderAccountId(record),
      providerOrganizationId: resolution.providerOrganizationId ?? null,
    };
  } else {
    const service = resolveQualifiedConnectedAccountServiceForIngressServiceId(params.input.serviceId);
    if (!service) return null;
    const material = await readQualifiedConnectedAccountCredentialMaterial({
      credentials: params.credentials,
      account: { service, accountId: profileId },
      requestPurpose: 'connected-accounts:request-auth-replacement',
      getAccountEncryptionMode: async () => await params.api.getAccountEncryptionMode(),
    });
    if (!material) return null;
    credentialRevision = material.snapshot.credentialRevision;
    providerAccountIdentity = readQualifiedConnectedAccountCredentialIdentity(material);
  }
  const fallbackProfileId = binding.selection === 'group'
    ? readNonEmptyString(groupMetadata?.fallbackProfileId)
      || readNonEmptyString(previousGroupSelection?.fallbackProfileId)
      || profileId
    : null;
  const generation = binding.selection === 'group'
    ? typeof groupMetadata?.generation === 'number'
      ? groupMetadata.generation
      : typeof previousGroupSelection?.generation === 'number'
        ? previousGroupSelection.generation
        : 0
    : null;

  const baseSelection = {
    kind: binding.selection,
    serviceId: params.input.serviceId,
    binding,
    profileId,
    ...(params.input.runtimeAuthApplyReason
      ? { applyReason: params.input.runtimeAuthApplyReason }
      : {}),
    ...(binding.selection === 'group'
      ? {
          groupId: binding.groupId,
          activeProfileId: profileId,
          fallbackProfileId: fallbackProfileId!,
          generation: generation!,
        }
      : {}),
    credentialRevision,
    ...(providerAccountIdentity.providerAccountId ? {
      sourceProviderAccountId: providerAccountIdentity.providerAccountId,
      ...(providerAccountIdentity.providerOrganizationId
        ? { sourceProviderOrganizationId: providerAccountIdentity.providerOrganizationId } : {}),
    } : {}),
  };

  const isMaterializationCurrent = async () => {
    if (binding.selection !== 'group') return true;
    if (!params.validateGroupMutationCurrentness) throw new Error('connected_account_group_currentness_unavailable');
    const currentness = await params.validateGroupMutationCurrentness({ serviceId: params.input.serviceId,
      groupId: binding.groupId, profileId, generation: generation!, credentialRevision });
    if (!currentness.current) throw new ConnectedServiceGroupMutationCurrentnessError(currentness.reason);
    return true;
  };
  let targetMaterializedRoot: string | null = null;
  let targetMaterializedEnv: Readonly<Record<string, string>> | null = null;
  let diagnostics: readonly ConnectedServicesMaterializationDiagnostic[] = [];
  if (params.activeServerDir) {
    const registryLease = await acquireAuthoritativePluginRuntimeRegistryLease();
    try {
      const registry = registryLease.registry;
      const contribution = registry.contributes.agentDefinitionsById.get(params.input.agentId);
      const catalogEntry = await registry.acquireAgentCatalogEntry?.(params.input.agentId) ?? contribution?.catalogEntry;
      const snapshot = resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
        agentId: params.input.agentId, bindings: params.input.normalizedBindings,
        contributions: registry.contributes, catalogEntry,
      });
      const nativeHomeDeclaration = (await catalogEntry?.getConnectedServiceStateSharingDescriptor?.())?.nativeHome;
      const owner = params.connectedAccountsOwner ?? registry.resolveConnectedAccountPurposeBindingOwner?.();
      if (nativeHomeDeclaration) {
        if (!snapshot || !contribution?.identity || !owner || !params.activatePurposeBindings) {
          throw new Error('connected_account_runtime_selection_authority_unavailable');
        }
        const operationId = randomUUID();
        const purposeLease = params.activatePurposeBindings({
          subject: { kind: 'operation', operationId, consumer: contribution.identity,
            sessionId: params.input.sessionId, isCurrent: () => true },
          purposes: snapshot.purposes, bindings: snapshot.bindings,
          directMaterialOrigins: snapshot.directMaterialOrigins,
        });
        try {
          const expectedAccountsByPurposeKey = new Map<string, QualifiedConnectedAccountRef>();
          for (const scope of snapshot.fileMaterializationPurposes ?? []) {
            const resolved = await owner.getBinding({ ...scope,
              exactPurposeBindingSubjectId: purposeLease.subjectId, signal: new AbortController().signal });
            if (resolved) {
              const selectedService = resolveQualifiedConnectedAccountServiceForIngressServiceId(params.input.serviceId);
              if (selectedService && resolved.account.service.pluginId === selectedService.pluginId
                && resolved.account.service.localId === selectedService.localId && resolved.account.accountId !== profileId) {
                throw new Error('shared_generation_application_superseded');
              }
              expectedAccountsByPurposeKey.set(qualifiedPurposeKey(scope.purpose), resolved.account);
            }
          }
          if (nativeHomeDeclaration) {
            targetMaterializedRoot = resolveConnectedServiceNativeHomeTarget({
              agentId: params.input.agentId, activeServerDir: params.activeServerDir,
              nativeHome: nativeHomeDeclaration, snapshot, expectedAccountsByPurposeKey,
            });
            targetMaterializedEnv = targetMaterializedRoot
              ? { [nativeHomeDeclaration.environmentKey]: targetMaterializedRoot } : null;
          }
          if (params.input.mode === 'apply') {
            if (!params.baseDir) throw new Error('connected_account_runtime_selection_base_dir_unavailable');
            const continuity = resolveTrackedConnectedServiceSwitchContinuityContext({
              agentId: params.input.agentId, baseDir: params.baseDir, tracked: params.input.tracked,
              persistedSessionMetadata: params.input.persistedSessionMetadata,
            });
            const materialized = await materializeConnectedServicesForSpawn({
              agentId: params.input.agentId, materializationKey: operationId,
              requesterWorkAttributionV1: params.input.tracked?.requesterWorkAttributionV1
                ?? params.input.tracked?.spawnOptions?.requesterWorkAttributionV1,
              activeServerDir: params.activeServerDir, baseDir: params.baseDir,
              sessionDirectory: params.input.cwd ?? params.input.tracked?.spawnOptions?.directory,
              recordsByServiceId: new Map(), connectedAccountsOwner: params.connectedAccountsOwner,
              connectedAccountMaterializationAuthority: { kind: 'qualified',
                purposeBindings: snapshot.bindings, requestAuthPurposeBindings: [] },
              qualifiedPurposeBindingSnapshot: snapshot, exactPurposeBindingSubjectId: purposeLease.subjectId,
              runtimeDescriptorV1: continuity.runtimeDescriptorV1,
              vendorResumeId: continuity.vendorResumeId,
              candidatePersistedSessionFile: continuity.candidatePersistedSessionFile,
              accountSettings: params.accountSettings, processEnv: params.processEnv,
              allowNativeAccountState: params.allowNativeAccountState === true,
              isAccountRuntimeCurrent: async () => purposeLease.isCurrent() && await isMaterializationCurrent(),
            });
            try {
              if (!materialized) throw new Error('connected_account_runtime_selection_materialization_unavailable');
              diagnostics = materialized.diagnostics ?? [];
              targetMaterializedRoot = materialized?.targetMaterializedRoot ?? targetMaterializedRoot;
              if (nativeHomeDeclaration && targetMaterializedRoot) {
                targetMaterializedEnv = { [nativeHomeDeclaration.environmentKey]: targetMaterializedRoot };
              }
            } finally {
              await materialized?.cleanupOnExit?.();
            }
          }
        } finally {
          purposeLease.dispose();
        }
      }
    } finally {
      await registryLease.release();
    }
  }
  const runtimeAuthTransport = createSessionConnectedServiceAuthTransport({
    credentials: params.credentials,
    sessionId: params.input.sessionId,
  });
  const nativeHome = targetMaterializedRoot
    ? await createConnectedServiceRuntimeAuthNativeHome({
        agentId: params.input.agentId,
        root: targetMaterializedRoot,
      })
    : null;

  return {
    ...baseSelection,
    ...(record ? { credential: record } : {}),
    applyConnectedServiceAuthGeneration: async (
      request: Parameters<typeof runtimeAuthTransport.applyConnectedServiceAuthGeneration>[0],
    ) => {
      const result = await runtimeAuthTransport.applyConnectedServiceAuthGeneration(request);
      return result.ok
        ? result.value
        : { ok: false as const, error: result.error, errorCode: result.code };
    },
    ...(targetMaterializedRoot ? { targetMaterializedRoot } : {}),
    ...(targetMaterializedEnv ? { targetMaterializedEnv } : {}),
    ...(diagnostics.length ? { diagnostics } : {}),
    ...(nativeHome ? { nativeHome } : {}),
  };
}
