import { createProfileOperations, setBuiltinProfileEnabledPreferenceV1, type ProfileOperationResult } from '@happier-dev/protocol/profiles/profileOperations';
import { AGENT_IDS } from '@happier-dev/agents';
import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import { isLaunchProfileV2 } from '@happier-dev/protocol/profiles/read';
import { LaunchProfileV2Schema } from '@happier-dev/protocol/profiles/v2/schema';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { buildLaunchProfileArtifactHeaderV1, LaunchProfileArtifactV1Schema, readLaunchProfileArtifactV1 } from '@happier-dev/protocol/launchProfiles/launchProfileArtifactV1';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { deleteProfileRecord, deleteProfileRecordInContext, readProfileCatalogProjectionInContext,
    writeProfileRecord, writeProfileRecordInContext, type ProfileAccountContext, type ProfileRowMutationResponseV1 } from '@/sync/api/account/apiProfileCatalog';
import { invalidateProfileCatalogProjection, refreshProfileCatalog } from '@/sync/engine/settings/profileCatalogEngine';
import { getProfileCatalogSnapshot } from '@/sync/store/settings/profileCatalogSnapshot';
import { areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { getStorage } from '@/sync/domains/state/storageStore';
import { readProfileEnabledById } from '@/sync/domains/profiles/profileEnablement';
import { readUiVisibleProfileCatalogSnapshot } from '@/sync/domains/profiles/aiLaunchProfileCollection';
import { requireOneShotAccountSettingsMutationApplied } from '@/sync/engine/settings/syncSettings';

export type UiProfileOperationsOptions = Readonly<{
    scope: AccountSettingsScope;
    signal?: AbortSignal;
    builtinNames?: readonly string[];
    agentIds?: readonly string[];
    isCurrent?: () => boolean;
    /** Real opened AuthoringMemory evidence, supplied only for search and selection. */
    selectionMemory?: Readonly<{ lastUsedProfile: string | null }>;
    /** Named reads/editing demand builtin visibility only after authoritative membership admission. */
    addressedProfileId?: string;
    readSelectionMemory?: () => Promise<Readonly<{ lastUsedProfile: string | null }>>;
    /** Captured Action memory owner; mounted UI uses the incumbent scoped owner. */
    clearRememberedProfile?: (input: Readonly<{ id: string }>) => Promise<void>;
}>;
const loading: ProfileCatalogSnapshotV1 = { status: 'loading' };

function mutationResult(id: string, outcome: ProfileRowMutationResponseV1): ProfileOperationResult {
    if (outcome.status === 'updated' || outcome.status === 'conflict') return { status: outcome.status, id, revision: outcome.revision };
    return { status: 'unavailable', reason: outcome.status };
}

function compose(options: UiProfileOperationsOptions, context?: ProfileAccountContext,
    projection?: Awaited<ReturnType<typeof readProfileCatalogProjectionInContext>>,
    capturedSettings?: Readonly<Record<string, unknown>>) {
    const assertCurrent = () => {
        options.signal?.throwIfAborted();
        context?.assertCurrent();
        if (options.isCurrent && !options.isCurrent()) throw new Error('Profile Account scope changed');
        if (context && context.accountId !== options.scope.accountId) throw new Error('Profile Account scope changed');
    };
    const readSnapshot = () => projection ?? getProfileCatalogSnapshot(options.scope);
    const readOrdinarySettings = () => {
        assertCurrent();
        if (context) return capturedSettings;
        const state = getStorage().getState();
        return areAccountSettingsScopesEqual(state.settingsScope, options.scope) ? state.settings : undefined;
    };
    const refresh = async () => {
        if (context) {
            projection = await readProfileCatalogProjectionInContext(context, options.signal);
            assertCurrent();
        }
        // The mounted scoped loader owns publication, including its current
        // credential/focus checks. A captured Action must refresh that same owner.
        await invalidateProfileCatalogProjection(options.scope);
    };
    const acknowledged = async (id: string, outcome: ProfileRowMutationResponseV1) => {
        const result = mutationResult(id, outcome);
        // A projection failure cannot erase an acknowledged authoritative write.
        if (result.status === 'updated') await refresh().catch(() => undefined);
        return result;
    };
    return createProfileOperations({
        builtinNames: options.builtinNames,
        agentIds: options.agentIds ?? AGENT_IDS,
        clearRememberedProfile: options.clearRememberedProfile ?? (!context ? async ({ id }) => {
            assertCurrent();
            await getSyncSingleton().applyAuthoringMemoryDelta({
                lastUsedProfileReplacement: { base: id, proposed: null },
            }, { expectedSettingsScope: options.scope });
        } : undefined),
        readCatalog: () => { assertCurrent(); return readSnapshot()?.catalog ?? loading; },
        artifactsById: () => readSnapshot()?.artifactsById ?? new Map(),
        readVisibleProfiles: () => {
            const snapshot = readSnapshot();
            const raw = readOrdinarySettings();
            const memory = context ? options.selectionMemory : { lastUsedProfile: getStorage().getState().authoringMemory.lastUsedProfile };
            if (!snapshot || !raw || !memory) {
                return { status: 'unavailable', reason: 'profile_selection_evidence_unavailable' };
            }
            const projected = readUiVisibleProfileCatalogSnapshot(snapshot, raw, memory);
            if (!projected.available) return { status: 'unavailable', reason: 'profile_catalog_unavailable' };
            return projected.profiles;
        },
        readEnabledPreferences: () => readProfileEnabledById(readOrdinarySettings()?.profileEnabledById),
        setBuiltinEnabled: async input => {
            assertCurrent();
            let updatedSettings: Record<string, unknown> | undefined;
            const mutate = (raw: Readonly<Record<string, unknown>>) => {
                assertCurrent();
                updatedSettings = setBuiltinProfileEnabledPreferenceV1(raw, input.subject.id, input.enabled);
                return updatedSettings;
            };
            const outcome = context
                ? await context.mutateRawSettings(mutate, {
                    expectedSettingsVersion: input.expectedSettingsVersion, rebaseOnConflict: false, observeOutcome: true,
                })
                : await getSyncSingleton().mutateAccountSettingsOnce({ expectedSettingsScope: options.scope,
                    expectedSettingsVersion: input.expectedSettingsVersion, rebaseOnConflict: false,
                    mutate: raw => ({ settings: mutate(raw), value: undefined }),
                });
            const applied = requireOneShotAccountSettingsMutationApplied(outcome);
            if (context) capturedSettings = updatedSettings;
            return { status: 'preference-updated', id: input.subject.id, enabled: input.enabled, settingsVersion: applied.settingsVersion };
        },
        writeRecord: async input => {
            assertCurrent();
            return acknowledged(input.record.id, await (context
                ? writeProfileRecordInContext(context, input, options.signal)
                : writeProfileRecord(options.scope, input, options.signal)));
        },
        deleteRecord: async input => {
            assertCurrent();
            return acknowledged(input.id, await (context
                ? deleteProfileRecordInContext(context, input, options.signal)
                : deleteProfileRecord(options.scope, input, options.signal)));
        },
        writeArtifactProfile: async ({ profile, record, expectedRevision, expectedArtifactRevision }) => {
            assertCurrent();
            if (record.definition.kind !== 'artifact') return { status: 'invalid', reason: 'invalid-definition', id: record.id };
            const resource = readSnapshot()?.artifactsById.get(record.definition.artifactId);
            const content = resource && readLaunchProfileArtifactV1(resource);
            if (!resource?.revision || !content) return { status: 'unavailable', reason: 'profile_definition_unavailable' };
            if (expectedArtifactRevision.headerVersion !== resource.revision.headerVersion
                || expectedArtifactRevision.bodyVersion !== resource.revision.bodyVersion) {
                return { status: 'conflict', id: record.id, revision: expectedRevision };
            }
            const parsed = LaunchProfileArtifactV1Schema.safeParse({ ...content, profile: isLaunchProfileV2(profile)
                ? createStoredReadSchema(LaunchProfileV2Schema).parse(profile) : createStoredReadSchema(AIBackendProfileSchema).parse(profile) });
            if (!parsed.success) return { status: 'invalid', reason: 'invalid-definition', id: record.id };
            const captured = context ?? await captureLazyActionAccountContext(options.scope.serverId, options.signal);
            try {
                if (captured.accountId !== options.scope.accountId) throw new Error('Profile Account scope changed');
                const result = await captured.workflowArtifacts.update({ artifactId: resource.artifactId,
                    expectedRevision: expectedArtifactRevision, header: { ...resource.header, ...buildLaunchProfileArtifactHeaderV1(parsed.data) },
                    body: JSON.stringify(parsed.data), signal: options.signal });
                if (!result.ok) return result.errorCode === 'version_mismatch'
                    ? { status: 'conflict', id: record.id, revision: expectedRevision }
                    : { status: 'unavailable', reason: result.errorCode ?? 'profile_artifact_edit_failed' };
                await refresh().catch(() => undefined);
                return { status: 'updated', id: record.id, revision: expectedRevision };
            } finally { if (!context) captured.dispose(); }
        },
    });
}

/** Mounted UI operations retain their Account identity and current row revision. */
export function createUiProfileOperations(options: UiProfileOperationsOptions) {
    const operations = compose(options);
    return { ...operations, save: async (input: Parameters<typeof operations.save>[0]) => {
        options.signal?.throwIfAborted();
        if (options.isCurrent && !options.isCurrent()) throw new Error('Profile Account scope changed');
        const catalog = getProfileCatalogSnapshot(options.scope)?.catalog;
        // New drafts can be edited before the inventory opens. Join its existing load before admission.
        if (!catalog || catalog.status === 'loading') await refreshProfileCatalog(options.scope);
        return operations.save(input);
    } };
}

/** Actions reuse their already-admitted Home/key lifetime, including the initial inventory read. */
export async function createUiProfileOperationsInContext(options: UiProfileOperationsOptions & Readonly<{ context: ProfileAccountContext }>) {
    options.context.assertCurrent();
    const projection = await readProfileCatalogProjectionInContext(options.context, options.signal);
    const catalog = projection.catalog;
    const selectionMemory = options.selectionMemory ?? (options.addressedProfileId && options.readSelectionMemory
        && catalog.status === 'ready' && catalog.source === 'destination'
        && !catalog.records.some(row => row.record.id === options.addressedProfileId)
        ? await options.readSelectionMemory() : undefined);
    options.context.assertCurrent();
    const settings = selectionMemory ? await options.context.readRawSettings() : undefined;
    options.context.assertCurrent();
    return compose({ ...options, selectionMemory }, options.context, projection, settings);
}
