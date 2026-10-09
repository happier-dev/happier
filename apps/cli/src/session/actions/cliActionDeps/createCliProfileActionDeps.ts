import { AGENT_IDS } from '@happier-dev/agents';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import type { z } from 'zod';
import { AccountSettingMutationV1Schema } from '@happier-dev/protocol/account/settings/accountSettingMutationV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { buildLaunchProfileArtifactHeaderV1, LaunchProfileArtifactV1Schema, readLaunchProfileArtifactV1 } from '@happier-dev/protocol/launchProfiles/launchProfileArtifactV1';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { DEFAULT_BUILT_IN_BACKEND_PROFILES } from '@happier-dev/protocol/profiles/builtInBackendProfiles';
import { createProfileActionExecuteV1 } from '@happier-dev/protocol/profiles/profileActionsV1';
import { createProfileOperations, setBuiltinProfileEnabledPreferenceV1, setProfileFavoritePreferenceV1,
  type ProfileOperationResult, type ProfileOperations } from '@happier-dev/protocol/profiles/profileOperations';
import { isLaunchProfileV2 } from '@happier-dev/protocol/profiles/read';
import type { ProfileRowMutationResponseV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { LaunchProfileV2Schema } from '@happier-dev/protocol/profiles/v2/schema';
import { createProviderErrorV1, ProviderErrorV1Schema, providerErrorFromRpcFailure } from '@happier-dev/protocol/providers/errors';
import { DaemonProviderProfileMigrationPreviewRequestV1Schema, DaemonProviderProfileMigrationPreviewResponseV1Schema,
  DaemonProviderProfileMigrationConfirmRequestV1Schema, DaemonProviderProfileMigrationConfirmResponseV1Schema,
  DaemonProviderProfileMigrationConflictConfirmRequestV1Schema, DaemonProviderProfileMigrationConflictConfirmResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { requireAccountSettingsMutationSuccess, updateAccountSettingsV2Once,
  updateAccountSettingsV2WithRetry } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { refreshActiveProfileCatalog } from '@/settings/profiles/hydrateProfileCatalog';
import { createCliProfileStore, createCliProfileStoreForOperation, type CliProfileStore } from '@/settings/profiles/profileStore';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { clearAuthoringMemoryLastUsedProfileIfEqual, readAuthoringMemoryLastUsedProfile } from '@/settings/profiles/readAuthoringMemoryLastUsedProfile';
import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';
import { createAuthoringMemoryClient } from '@/settings/authoringMemory/createAuthoringMemoryClient';

function mutationResult(id: string, result: ProfileRowMutationResponseV1): ProfileOperationResult {
  if (result.status === 'updated' || result.status === 'conflict') return { status: result.status, id, revision: result.revision };
  return { status: 'unavailable', reason: result.status };
}

/** Typed Profile Actions borrow the existing catalog, persistence and preference owners. */
export function createCliProfileActionExecuteV1(params: Readonly<{
  credentials: StoredCredentials;
  serverId: string;
  serverHttpBaseUrl: string;
  operationContext?: SavedSecretOperationContextV1;
  callMachineAction(input: Readonly<{
    machineId: string; serverId?: string; method: string; request: unknown; signal?: AbortSignal;
    authority?: ActionExecutorContext['authority']; authorization?: ActionExecutorContext['rpcSessionAuthorization'];
    context?: ActionExecutorContext; effectActionId?: string; exactMachine?: true;
  }>): Promise<unknown>;
}>): NonNullable<ActionExecutorDeps['profileActionExecute']> {
  const scopeKey = runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => resolveAccountSettingsScopeKey(params.credentials));
  return async (request, context) => runWithServerHttpBaseUrl(params.serverHttpBaseUrl, async (): Promise<ActionExecuteResult> => {
    if (context.serverId && context.serverId !== params.serverId) {
      return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
    }
    let store: CliProfileStore | undefined;
    const readSnapshot = () => params.operationContext ? params.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
    const assertCurrent = () => {
      context.signal?.throwIfAborted();
      const active = readSnapshot();
      if (params.operationContext && !active || active && active.scopeKey !== scopeKey) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
      store?.assertCurrent();
    };
    const isCurrent = () => { try { assertCurrent(); return true; } catch { return false; } };
    const refreshCatalog = () => refreshActiveProfileCatalog({ credentials: params.credentials, signal: context.signal,
      ...(params.operationContext ? { operationContext: params.operationContext } : {}) });
    const refreshPrivateSettings = async () => {
      if (!params.operationContext) return;
      const snapshot = await bootstrapAccountSettingsContext({ credentials: params.credentials, mode: 'blocking', refresh: 'force',
        publication: 'invocation', honorAccountSettingsModeEnv: false });
      if (snapshot.source !== 'network' || !await params.operationContext.replaceAccountSettings(snapshot)) {
        throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
      }
    };
    const requestLegacyRpc = async <TSchema extends z.ZodType>(schema: TSchema, operation: 'read' | 'mutation',
      payload: Readonly<{ machineId: string; sourceProfileId: string }>, method: string): Promise<z.output<TSchema>> => {
      assertCurrent();
      const errorContext = { machineId: payload.machineId, sourceProfileId: payload.sourceProfileId };
      try {
        const parsed = schema.safeParse(await params.callMachineAction({ machineId: payload.machineId,
          serverId: params.serverId, method, request: payload, signal: context.signal,
          authority: context.authority, authorization: context.rpcSessionAuthorization,
          context, effectActionId: request.actionId, exactMachine: true }));
        if (!parsed.success) return schema.parse({ status: 'error', error: createProviderErrorV1(operation === 'mutation'
          ? 'provider_rpc_mutation_outcome_unknown' : 'provider_rpc_response_invalid', errorContext) });
        if (operation === 'read') assertCurrent();
        return parsed.data;
      } catch (caught) {
        // These refusals belong to the caller boundary and occur before RPC dispatch.
        if (caught && typeof caught === 'object' && 'code' in caught
          && (caught.code === 'server_scope_mismatch' || caught.code === 'not_authenticated')) throw caught;
        const typed = ProviderErrorV1Schema.safeParse(caught);
        const error = typed.success ? typed.data : operation === 'mutation'
          ? createProviderErrorV1('provider_rpc_mutation_outcome_unknown', errorContext)
          : providerErrorFromRpcFailure(caught, errorContext);
        return schema.parse({ status: 'error', error });
      }
    };
    let operations: Promise<ProfileOperations> | undefined;
    const resolveOperations = () => operations ??= (async () => {
      assertCurrent();
      if (!params.operationContext && !getActiveAccountSettingsSnapshot()) {
        await bootstrapAccountSettingsContext({ credentials: params.credentials, mode: 'blocking' });
      }
      assertCurrent();
      store = params.operationContext ? createCliProfileStoreForOperation({ operationContext: params.operationContext, signal: context.signal })
        : createCliProfileStore({ credentials: params.credentials, signal: context.signal });
      await refreshCatalog();
      assertCurrent();
      const capturedStore = store;
      let projection = await capturedStore.readCatalog();
      let visible: ReturnType<typeof readProfilesFromAccountSettings> | undefined;
      const addressedId = request.actionId === 'launch_profiles.read' ? request.input.id : undefined;
      const requiresVisibility = request.actionId === 'launch_profiles.search'
        || (request.actionId === 'launch_profiles.select' && request.input.id !== null)
        || (addressedId !== undefined && projection.catalog.status === 'ready'
          && !projection.catalog.records.some(row => row.record.id === addressedId));
      if (requiresVisibility && projection.catalog.status === 'ready') {
        const lastUsedProfile = await readAuthoringMemoryLastUsedProfile(params.credentials, context.signal);
        const source = await capturedStore.readSourceSnapshot();
        assertCurrent();
        visible = readProfilesFromAccountSettings(source.raw, projection.artifactsById, { lastUsedProfile }, projection.catalog);
      }
      const refresh = async () => {
        await refreshCatalog();
        projection = await capturedStore.readCatalog();
      };
      const acknowledged = async (id: string, result: ProfileRowMutationResponseV1) => {
        const outcome = mutationResult(id, result);
        if (outcome.status === 'updated') await refresh().catch(() => undefined);
        return outcome;
      };
      return createProfileOperations({
        readCatalog: () => projection.catalog,
        artifactsById: () => projection.artifactsById,
        builtinNames: DEFAULT_BUILT_IN_BACKEND_PROFILES.map(profile => profile.name), agentIds: AGENT_IDS,
        readVisibleProfiles: () => visible?.visibleProfiles ?? { status: 'unavailable', reason: 'profile_selection_evidence_unavailable' },
        readEnabledPreferences: () => visible?.enabledByProfileId ?? {},
        writeRecord: async input => {
          assertCurrent();
          return acknowledged(input.record.id, await capturedStore.writeRecord(input));
        },
        deleteRecord: async input => {
          assertCurrent();
          return acknowledged(input.id, await capturedStore.deleteRecord(input));
        },
        clearRememberedProfile: async ({ id }) => {
          assertCurrent();
          await readAuthoringMemoryLastUsedProfile(params.credentials, context.signal);
          assertCurrent();
          await clearAuthoringMemoryLastUsedProfileIfEqual(params.credentials, id, context.signal);
        },
        setBuiltinEnabled: async input => {
          const result = await updateAccountSettingsV2Once({ credentials: params.credentials,
            signal: context.signal, shouldSubmit: isCurrent, shouldCommit: () => !params.operationContext && isCurrent(),
            expectedVersion: input.expectedSettingsVersion,
            mutate: raw => setBuiltinProfileEnabledPreferenceV1(raw, input.subject.id, input.enabled) });
          if (result.status === 'conflict') return { status: 'conflict', id: input.subject.id, revision: result.currentVersion };
          const settled = requireAccountSettingsMutationSuccess(result);
          await refreshPrivateSettings();
          return { status: 'preference-updated', id: input.subject.id, enabled: input.enabled, settingsVersion: settled.version };
        },
        writeArtifactProfile: async ({ profile, record, expectedRevision, expectedArtifactRevision }) => {
          assertCurrent();
          if (record.definition.kind !== 'artifact') return { status: 'invalid', reason: 'invalid-definition', id: record.id };
          const resource = projection.artifactsById.get(record.definition.artifactId);
          const content = resource && readLaunchProfileArtifactV1(resource);
          if (!resource?.revision || !content) return { status: 'unavailable', reason: 'profile_definition_unavailable' };
          if (resource.revision.headerVersion !== expectedArtifactRevision.headerVersion
            || resource.revision.bodyVersion !== expectedArtifactRevision.bodyVersion) {
            return { status: 'conflict', id: record.id, revision: expectedRevision };
          }
          const parsed = LaunchProfileArtifactV1Schema.safeParse({ ...content, profile: isLaunchProfileV2(profile)
            ? createStoredReadSchema(LaunchProfileV2Schema).parse(profile) : createStoredReadSchema(AIBackendProfileSchema).parse(profile) });
          if (!parsed.success) return { status: 'invalid', reason: 'invalid-definition', id: record.id };
          const result = await createCredentialedAccountArtifactStore(params.credentials).update({ artifactId: resource.artifactId,
            expectedRevision: expectedArtifactRevision, header: { ...resource.header, ...buildLaunchProfileArtifactHeaderV1(parsed.data) },
            body: JSON.stringify(parsed.data), signal: context.signal });
          if (!result.ok) return result.errorCode === 'version_mismatch'
            ? { status: 'conflict', id: record.id, revision: expectedRevision }
            : { status: 'unavailable', reason: result.errorCode };
          await refresh().catch(() => undefined);
          return { status: 'updated', id: record.id, revision: expectedRevision };
        },
      });
    })();
    const execute = createProfileActionExecuteV1({
      operations: resolveOperations,
      favorite: async ({ id, favorite }) => {
        assertCurrent();
        const result = await updateAccountSettingsV2WithRetry({ credentials: params.credentials,
          signal: context.signal, shouldSubmit: isCurrent, shouldCommit: () => !params.operationContext && isCurrent(),
          prepareMutation: raw => AccountSettingMutationV1Schema.parse({ operations: [{ op: 'set', key: 'favoriteProfiles',
            value: setProfileFavoritePreferenceV1(raw, id, favorite).favoriteProfiles }] }) });
        requireAccountSettingsMutationSuccess(result);
        await refreshPrivateSettings();
        return { status: 'updated', id, favorite };
      },
      select: async ({ id }) => {
        assertCurrent();
        if (id !== null) {
          const admitted = (await resolveOperations()).validateSelection({ id });
          if (admitted.status !== 'selected') return admitted;
        }
        await readAuthoringMemoryLastUsedProfile(params.credentials, context.signal);
        assertCurrent();
        const memory = await createAuthoringMemoryClient({ credentials: params.credentials, signal: context.signal });
        const row = await memory.read('lastUsedProfile');
        if (row.status !== 'present' && row.status !== 'absent' && row.status !== 'deleted') {
          return { status: 'unavailable', reason: row.status };
        }
        if (row.status === 'present') memory.open('lastUsedProfile', row.content);
        assertCurrent();
        const result = await memory.mutate('lastUsedProfile', row.status === 'absent' ? 'absent' : row.revision,
          memory.seal('lastUsedProfile', id));
        if (result.status !== 'updated') return { status: 'unavailable', reason: result.status === 'conflict'
          ? 'authoring_memory_revision_conflict' : result.status };
        return { status: 'selected', id };
      },
      edit: async () => ({ status: 'unavailable', reason: 'profile_editor_unavailable' }),
      discardDraft: async () => ({ status: 'unavailable', reason: 'profile_editor_not_mounted' }),
      selectSecret: async input => (await resolveOperations()).selectSecret(input),
      legacyPreview: async input => requestLegacyRpc(DaemonProviderProfileMigrationPreviewResponseV1Schema, 'read',
        DaemonProviderProfileMigrationPreviewRequestV1Schema.parse(input), RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREVIEW),
      legacyConvert: async input => requestLegacyRpc(DaemonProviderProfileMigrationConfirmResponseV1Schema, 'mutation',
        DaemonProviderProfileMigrationConfirmRequestV1Schema.parse(input), RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFIRM),
      legacyResolveConflict: async input => requestLegacyRpc(DaemonProviderProfileMigrationConflictConfirmResponseV1Schema, 'mutation',
        DaemonProviderProfileMigrationConflictConfirmRequestV1Schema.parse(input), RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFLICT_CONFIRM),
    });
    try {
      if (params.operationContext && !await params.operationContext.isCurrent()) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
      return await execute(request, context);
    }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'outcome_unknown') {
        return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
      }
      throw error;
    }
  });
}
