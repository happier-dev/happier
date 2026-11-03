import { createHash } from 'node:crypto';

import { AccountSettingsSavedSecretMutationError, applyAccountSettingsSavedSecretMutation, resolveAccountSettingsPluginSecretBinding, resolveAccountSettingsPluginSecret, listUnreferencedPluginCreatedSecretResources } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1, type PersonalSavedSecretActionIdV1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { PluginAccountSecretBinding, PluginAccountSecretBindingTarget } from '@happier-dev/protocol';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk/errors';
import type { SharedSecretAudience, SharedSecretSaveResult } from '@happier-dev/plugin-sdk/secrets';
import { SharedSavedSecretCreateInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { isDeepStrictEqual } from 'node:util';

import {
    getActiveAccountSettingsSnapshot,
    getActiveAccountSettingsSnapshotLifetimeToken,
    type ActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { readStoredCredentials } from '@/persistence';
import { refreshAccountSettingsForMinimumVersion } from '@/settings/accountSettings/refreshAccountSettingsForMinimumVersion';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { AccountSettingsMutationResult } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { refreshSavedSecretCatalogForOperation } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { readSavedSecretCatalogForOperation } from '@/settings/secrets/savedSecretCatalogRead';
import { createCliPersonalSavedSecretActionExecute } from '@/settings/secrets/personalSavedSecretActionHost';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import type { TargetSecretSourcesV1 } from '@/plugins/runtime/lifecycle/contributions/targetSecretSources';
import { createSharedSavedSecretForPlugin } from './sharedSavedSecretCreation';
import { openSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createAccountPluginSecretReadCustody, type AccountPluginSecretReadCustody } from './accountPluginSecretReadCustody';

import { updateActivePluginAccountSettingsOnce } from './accountSettingsStorage';
import type {
    PluginSecretCustody,
    PluginSecretCustodyResolver,
} from './secrets';

type AccountSecretSnapshot = ActiveAccountSettingsSnapshot;

type AccountSettingsMutationOwner = Readonly<{
    readSnapshot(): AccountSecretSnapshot | null;
    /** Monotonic owner-local token for the active Account incumbent. */
    readLifetimeToken?(): number;
    updateOnce(input: Readonly<{
        expectedVersion: number;
        mutate: (
            settings: Readonly<Record<string, unknown>>,
        ) => Record<string, unknown>,
        assertCurrent(): void;
    }>): Promise<AccountSettingsMutationResult>;
    /**
     * Admits one shared Saved Secret for a new operation against the Home's
     * current authorized catalog (plan 10.08 §5.8, SECRET-05). AccountChange is
     * only a hint, so a hydrated row is not current authorization. An owner
     * without it cannot admit shared material and custody fails closed.
     */
    admitSharedSecretForOperation?(input: Readonly<{ ref: string; expectedScopeKey: string }>): Promise<void>;
    /** Reads the authoritative Account document after a submitted write lost its response. */
    rereadAfterAmbiguousWrite?(input?: Readonly<{
        expectedLifetimeToken?: number;
        expectedScopeKey?: string;
    }>): Promise<AccountSecretSnapshot | null>;
}>;

function custodyError(
    code: string,
    message: string,
    details?: Readonly<Record<string, string>>,
    retryable?: boolean,
): PluginError {
    return new PluginError({
        code,
        message,
        ...(details ? { details } : {}),
        ...(retryable === undefined ? {} : { retryable }),
    });
}

function sameAccount(
    before: AccountSecretSnapshot,
    after: AccountSecretSnapshot | null,
): boolean {
    if (!after) return false;
    if (before.scopeKey && after.scopeKey) return before.scopeKey === after.scopeKey;
    return before === after;
}

function snapshotForSettledMutation(
    before: AccountSecretSnapshot,
    result: Extract<AccountSettingsMutationResult, {
        status: 'applied' | 'satisfied' | 'unchanged';
    }>,
): AccountSecretSnapshot {
    return Object.freeze({
        ...before,
        source: 'network',
        settings: result.settings,
        settingsVersion: result.version,
    });
}

function targetFor(pluginId: string, secretId: string): PluginAccountSecretBindingTarget {
    return Object.freeze({ pluginId, localId: secretId });
}

function revisionFor(
    snapshot: AccountSecretSnapshot,
    binding: PluginAccountSecretBinding | null,
    materialFingerprint: string | null,
    materialStatus: string | null,
): string {
    const hash = createHash('sha256');
    hash.update(snapshot.scopeKey ?? 'unscoped');
    hash.update('\0');
    hash.update(String(snapshot.settingsVersion));
    hash.update('\0');
    hash.update(binding?.savedSecretId ?? 'missing');
    hash.update('\0');
    hash.update(materialFingerprint ?? materialStatus ?? 'missing');
    return `account-secret-r1:${hash.digest('hex')}`;
}

function savedSecretName(pluginId: string, secretId: string): string {
    const value = `Plugin ${pluginId} secret ${secretId}`;
    return value.length <= 100 ? value : value.slice(0, 100);
}

/**
 * Account plugin bindings point to the protocol-owned SavedSecret record
 * for precisely `(pluginId, secretId)`. Material belongs to resource custody;
 * the Protocol owner changes references through the Account Settings CAS.
 * Cleanup runs through the resource owner's live reference census after that CAS.
 */
export function createAccountPluginSecretCustodyRouter(params: Readonly<{
    operationContext?: SavedSecretOperationContextV1;
    secretSources?: TargetSecretSourcesV1;
    owner?: AccountSettingsMutationOwner;
    /** Exact authenticated Account reader selected by the enclosing runtime. */
    readCredentials?: typeof readStoredCredentials;
    /** When supplied, Account-backed custody is available only to this exact Account lifetime. */
    accountScopeKey?: string | null;
    /** Resource persistence boundary; production uses the personal SavedSecret Action owner. */
    resources?: Readonly<{
        create(input: Readonly<{ name: string; value: string; assertCurrent(): void }>): Promise<string>;
        createShared?(input: Readonly<{ name: string; value: string; audience: SharedSecretAudience;
            createdByPlugin: Readonly<{ pluginId: string; secretId: string }>;
            signal: AbortSignal; assertCurrent(): void }>): Promise<SharedSecretSaveResult>;
        delete(input: Readonly<{ ref: string; assertCurrent(): void }>): Promise<void>;
        readCensus?(assertCurrent: () => void, references: readonly string[]): Promise<NonNullable<Parameters<typeof listUnreferencedPluginCreatedSecretResources>[2]>>;
    }>;
}> = {}): Readonly<{
    resolve: PluginSecretCustodyResolver;
    /** Host-only exact-resource reads; the same custody backs declared secrets.get. */
    bindReadCustody(input: Readonly<{ signal: AbortSignal; isCurrent(): boolean }>): AccountPluginSecretReadCustody | null;
    /**
     * Host-private administration port for selecting an already-existing
     * SavedSecret. It intentionally has no raw secret-value input or result.
     */
    bindExisting(input: Readonly<{
        pluginId: string;
        secretId: string;
        savedSecretId: string;
        expectedRevision?: string;
        assertCurrent?: () => void;
    }>): Promise<Readonly<{ revision: string }>>;
    /** Removes a binding and cleans up its unused binding-created resource. */
    unbind(input: Readonly<{
        pluginId: string;
        secretId: string;
        expectedRevision?: string;
        assertCurrent?: () => void;
    }>): Promise<Readonly<{ revision: string }>>;
}> {
    const readCredentials = params.readCredentials ?? (params.operationContext
        ? async () => params.operationContext!.credentials : readStoredCredentials);
    const readBoundSnapshot = (): AccountSecretSnapshot | null => {
        if (params.accountScopeKey === null) return null;
        const snapshot = params.operationContext?.readSnapshot() ?? (params.operationContext ? null : getActiveAccountSettingsSnapshot());
        if (params.accountScopeKey === undefined) return snapshot;
        return snapshot?.scopeKey === params.accountScopeKey
            ? snapshot
            : null;
    };
    const owner: AccountSettingsMutationOwner = params.owner ?? Object.freeze({
        readSnapshot: readBoundSnapshot,
        ...(!params.operationContext ? { readLifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken } : {}),
        async admitSharedSecretForOperation(input: Readonly<{ ref: string; expectedScopeKey: string }>) {
            await refreshSavedSecretCatalogForOperation({
                expectedScopeKey: input.expectedScopeKey,
                references: [{ ref: input.ref }],
                ...(params.operationContext ? { operationContext: params.operationContext } : {}),
            });
        },
        async updateOnce(input): Promise<AccountSettingsMutationResult> {
            return await updateActivePluginAccountSettingsOnce({
                expectedVersion: input.expectedVersion,
                mutate: input.mutate,
                deps: {
                    assertCurrent: input.assertCurrent,
                    readCredentials,
                },
            });
        },
        async rereadAfterAmbiguousWrite(input: Readonly<{
            expectedLifetimeToken?: number;
            expectedScopeKey?: string;
        }> = {}): Promise<AccountSecretSnapshot | null> {
            const credentials = await readCredentials();
            if (!credentials) return null;
            const stillOwnsPublicationLifetime = () => {
                if (input.expectedLifetimeToken === undefined) return true;
                const active = getActiveAccountSettingsSnapshot();
                return !!active
                    && active.scopeKey === input.expectedScopeKey
                    && getActiveAccountSettingsSnapshotLifetimeToken() === input.expectedLifetimeToken;
            };
            await refreshAccountSettingsForMinimumVersion({
                credentials,
                forceRefresh: true,
                mode: 'blocking',
                shouldCommit: stillOwnsPublicationLifetime,
            });
            return stillOwnsPublicationLifetime()
                ? getActiveAccountSettingsSnapshot()
                : null;
        },
    });
    async function executePersonal(actionId: PersonalSavedSecretActionIdV1, input: unknown, assertCurrent: () => void) {
        assertCurrent();
        const credentials = await readCredentials();
        assertCurrent();
        if (!credentials || resolveAccountSettingsScopeKeyForToken(credentials.token) !== requireSnapshot().scopeKey) {
            throw custodyError('plugin_secret_custody_unavailable', 'Account credentials are unavailable for this custody');
        }
        const isCredentialCurrent = () => { assertCurrent(); return true; };
        const home = createAccountServerActionDeps({ token: credentials.token, credentials, isCredentialCurrent }).homeDomainAction;
        if (!home) throw custodyError('plugin_secret_custody_unavailable', 'Account resource custody is unavailable');
        const execute = createCliPersonalSavedSecretActionExecute({ credentials, home, isCredentialCurrent });
        const result = await execute({ actionId, input, context: { surface: 'cli' } });
        const failure = ActionExecuteFailureSchema.safeParse(result);
        if (failure.success) {
            if (failure.data.errorCode === 'in_use' || failure.data.errorCode === 'not_found') return result;
            throw custodyError(failure.data.errorCode === 'outcome_unknown' ? 'plugin_secret_outcome_unknown' : 'plugin_secret_custody_unavailable',
                'Account resource mutation did not complete');
        }
        return result;
    }
    const resources = params.resources ?? {
        async readCensus(assertCurrent: () => void, references: readonly string[]) {
            const snapshot = await readSavedSecretCatalogForOperation({ expectedScopeKey: requireSnapshot().scopeKey ?? '',
                refreshCatalog: true, includeReferenceCensus: true,
                ...(params.operationContext ? { operationContext: params.operationContext } : {}) });
            assertCurrent();
            const requested = new Set(references);
            return { resources: (snapshot.savedSecretResources ?? []).filter(row => row.relationship !== 'recipient'
                && requested.has(formatSharedSavedSecretRefV1(row.resourceId))).map(row => {
                const content = !row.storedContent ? null : row.encryptionMode === 'plain'
                    ? openSavedSecretResourceStoredContentV1({ resourceId: row.resourceId, mode: 'plain', storedContent: row.storedContent })
                    : row.resourceDataKey ? openSavedSecretResourceStoredContentV1({ resourceId: row.resourceId,
                        mode: 'e2ee', storedContent: row.storedContent, resourceDataKey: row.resourceDataKey }) : null;
                return { ref: formatSharedSavedSecretRefV1(row.resourceId),
                    ...(content && 'createdByPlugin' in content && content.createdByPlugin ? { createdByPlugin: content.createdByPlugin } : {}),
                    ...(row.deploymentReferenceState ? { deploymentReferenceState: row.deploymentReferenceState } : {}) };
            }) };
        },
        async createShared(input: Readonly<{ name: string; value: string; audience: SharedSecretAudience;
            createdByPlugin: Readonly<{ pluginId: string; secretId: string }>;
            signal: AbortSignal; assertCurrent(): void }>) {
            return await createSharedSavedSecretForPlugin({ ...input, readCredentials,
                expectedScopeKey: requireSnapshot().scopeKey ?? '',
                ...(params.operationContext ? { operationContext: params.operationContext } : {}),
            });
        },
        async create(input: Readonly<{ name: string; value: string; assertCurrent(): void }>) {
            return PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.create'].parse(await executePersonal('secrets.create', {
                name: input.name, kind: 'other', value: input.value,
            }, input.assertCurrent)).secretRef;
        },
        async delete(input: Readonly<{ ref: string; assertCurrent(): void }>) {
            input.assertCurrent();
            const ref = parseSavedSecretRefV1(input.ref);
            if (ref.kind !== 'shared_resource') return;
            const snapshot = await readSavedSecretCatalogForOperation({ expectedScopeKey: requireSnapshot().scopeKey ?? '',
                references: [{ ref: input.ref }], refreshCatalog: true });
            input.assertCurrent();
            const resource = snapshot.savedSecretResources?.find(row => row.resourceId === ref.resourceId);
            if (!resource) return;
            if (resource.relationship === 'recipient') throw custodyError('plugin_secret_custody_unavailable', 'Plugin-created resource is not owned');
            await executePersonal('secrets.delete', { secretId: ref.resourceId, expectedUpdatedAt: resource.revision }, input.assertCurrent);
        },
    };

    async function cleanup(before: AccountSecretSnapshot, after: AccountSecretSnapshot, assertCurrent: () => void) {
        try {
            assertCurrent();
            // This mutation authorizes retirement only of its removed binding-created refs.
            const retired = new Set(listUnreferencedPluginCreatedSecretResources(before.settings, after.settings));
            if (retired.size === 0) return;
            const census = await resources.readCensus?.(assertCurrent, [...retired]);
            for (const ref of listUnreferencedPluginCreatedSecretResources(before.settings, after.settings, census)) {
                if (!retired.has(ref)) continue;
                await resources.delete({ ref, assertCurrent });
            }
        } catch {
            // Retirement withdraws cleanup authority, not the settled binding outcome.
            try { assertCurrent(); } catch { return; }
            throw custodyError('plugin_secret_cleanup_failed', 'The binding changed but resource cleanup did not complete');
        }
    }

    function requireSnapshot(): AccountSecretSnapshot {
        const snapshot = owner.readSnapshot();
        if (!snapshot) {
            throw custodyError(
                'plugin_secret_custody_unavailable',
                'Account plugin secret custody is unavailable',
            );
        }
        return snapshot;
    }

    function assertSnapshotCurrent(snapshot: AccountSecretSnapshot): void {
        if (!sameAccount(snapshot, owner.readSnapshot())) {
            throw custodyError(
                'plugin_secret_custody_unavailable',
                'The active Account changed while resolving a plugin secret',
            );
        }
    }

    function resolveBinding(
        snapshot: AccountSecretSnapshot,
        target: PluginAccountSecretBindingTarget,
    ): PluginAccountSecretBinding | null {
        try {
            return resolveAccountSettingsPluginSecretBinding(snapshot.settings, target);
        } catch {
            throw custodyError(
                'plugin_secret_custody_unavailable',
                'Account plugin secret binding is unavailable',
            );
        }
    }

    function state(
        snapshot: AccountSecretSnapshot,
        target: PluginAccountSecretBindingTarget,
    ): Readonly<{
        binding: PluginAccountSecretBinding | null;
        revision: string;
    }> {
        const binding = resolveBinding(snapshot, target);
        const inspected = binding
            ? createSavedSecretMaterializerFromSnapshotV1(snapshot).inspect(binding.savedSecretId)
            : null;
        return Object.freeze({
            binding,
            revision: revisionFor(
                snapshot,
                binding,
                inspected?.status === 'ready' ? inspected.fingerprint : null,
                inspected?.status ?? null,
            ),
        });
    }

    function personalSecretRevision(
        snapshot: AccountSecretSnapshot,
        binding: PluginAccountSecretBinding | null,
    ): number | null {
        if (!binding || parseSavedSecretRefV1(binding.savedSecretId).kind === 'shared_resource') return null;
        return resolveAccountSettingsPluginSecret(snapshot.settings, targetFor(
            binding.pluginId,
            binding.localId,
        ))?.secret.updatedAt ?? null;
    }

    function stateForSettledMutation(
        snapshot: AccountSecretSnapshot,
        target: PluginAccountSecretBindingTarget,
        assertCurrent: () => void,
    ) {
        // Acknowledgement survives retirement; only a still-current operation
        // can borrow catalog facts refreshed by its resource cleanup.
        try { assertCurrent(); } catch { return state(snapshot, target); }
        const current = owner.readSnapshot();
        return state(current && sameAccount(snapshot, current) && current.settingsVersion === snapshot.settingsVersion
            ? current : snapshot, target);
    }

    function assertExpectedRevision(
        current: Readonly<{ revision: string }>,
        expectedRevision?: string,
    ): void {
        if (expectedRevision === undefined || expectedRevision === current.revision) return;
        throw custodyError(
            'plugin_secret_revision_conflict',
            'Plugin secret revision does not match the current Account revision',
            { currentRevision: current.revision },
        );
    }

    async function update(
        snapshot: AccountSecretSnapshot,
        mutate: (settings: Readonly<Record<string, unknown>>) => Record<string, unknown>,
        assertCurrent: () => void,
        matchesPostcondition?: (snapshot: AccountSecretSnapshot) => boolean,
    ): Promise<AccountSecretSnapshot> {
        let lifetimeTokenAtSubmission: number | undefined;
        async function rereadExactPostcondition(): Promise<AccountSecretSnapshot> {
            try {
                const reread = await owner.rereadAfterAmbiguousWrite?.({
                    expectedLifetimeToken: lifetimeTokenAtSubmission,
                    expectedScopeKey: snapshot.scopeKey,
                });
                if (
                    !reread
                    || (
                        lifetimeTokenAtSubmission !== undefined
                        && owner.readLifetimeToken?.() !== lifetimeTokenAtSubmission
                    )
                    || !sameAccount(snapshot, reread)
                    || !matchesPostcondition?.(reread)
                ) {
                    throw custodyError(
                        'plugin_secret_outcome_unknown',
                        'Account plugin secret write outcome is unknown',
                    );
                }
                return reread;
            } catch (error) {
                if (isPluginError(error)) throw error;
                throw custodyError(
                    'plugin_secret_outcome_unknown',
                    'Account plugin secret write outcome is unknown',
                );
            }
        }

        try {
            assertCurrent();
            assertSnapshotCurrent(snapshot);
            lifetimeTokenAtSubmission = owner.readLifetimeToken?.();
            const result = await owner.updateOnce({
                expectedVersion: snapshot.settingsVersion,
                mutate,
                assertCurrent: () => {
                    assertCurrent();
                    assertSnapshotCurrent(snapshot);
                },
            });
            switch (result.status) {
                case 'applied':
                case 'unchanged':
                    return snapshotForSettledMutation(snapshot, result);
                case 'satisfied':
                case 'outcomeUnknown':
                    return await rereadExactPostcondition();
                case 'conflict':
                    throw custodyError(
                        'plugin_secret_revision_conflict',
                        'Plugin secret revision does not match the current Account revision',
                        { currentVersion: String(result.currentVersion) },
                    );
                case 'cancelled':
                    throw custodyError(
                        'plugin_secret_custody_cancelled',
                        'Account plugin secret mutation was cancelled before submission',
                    );
                case 'invalid':
                    throw custodyError(
                        result.reason === 'tooLarge'
                            ? 'plugin_secret_custody_too_large'
                            : 'plugin_secret_custody_invalid',
                        'Account plugin secret mutation is invalid',
                        { reason: result.reason },
                    );
                case 'locked':
                    throw custodyError(
                        'plugin_secret_custody_locked',
                        'Account plugin secret material is locked',
                        { reason: result.reason },
                    );
                case 'unavailable':
                    throw custodyError(
                        'plugin_secret_custody_unavailable',
                        'Account plugin secret mutation is unavailable',
                        undefined,
                        result.retryable,
                    );
            }
        } catch (error) {
            if (isPluginError(error)) throw error;
            if (error instanceof AccountSettingsSavedSecretMutationError) {
                const code = error.code === 'saved_secret_conflict'
                    ? 'plugin_secret_revision_conflict'
                    : 'plugin_secret_custody_unavailable';
                throw custodyError(code, 'Account plugin secret mutation was rejected');
            }
            throw custodyError(
                'plugin_secret_custody_unavailable',
                'Account plugin secret mutation is unavailable',
            );
        }
    }

    function bindAccountSnapshotReader(): (() => AccountSecretSnapshot) | null {
        const boundAccount: AccountSecretSnapshot | null = owner.readSnapshot();
        if (!boundAccount) return null;
        const boundAccountSnapshot: AccountSecretSnapshot = boundAccount;
        const boundLifetimeToken = owner.readLifetimeToken?.();
        function requireBoundAccountSnapshot(): AccountSecretSnapshot {
            if (
                boundLifetimeToken !== undefined
                && owner.readLifetimeToken?.() !== boundLifetimeToken
            ) {
                throw custodyError(
                    'plugin_secret_custody_unavailable',
                    'The Account lifetime ended after plugin secret custody was resolved',
                );
            }
            const snapshot = requireSnapshot();
            if (!sameAccount(boundAccountSnapshot, snapshot)) {
                throw custodyError(
                    'plugin_secret_custody_unavailable',
                    'The active Account changed after plugin secret custody was resolved',
                );
            }
            return snapshot;
        }
        return requireBoundAccountSnapshot;
    }

    function createReadCustody(
        readSnapshot: () => AccountSecretSnapshot,
        admitSharedReferences: Parameters<typeof createAccountPluginSecretReadCustody>[0]['admitSharedReferences'] = async input => {
            await readSavedSecretCatalogForOperation({ ...input,
                references: input.references.map(reference => ({ ref: reference.ref, required: false })),
                ...(params.operationContext ? { operationContext: params.operationContext } : {}),
            });
        },
    ): AccountPluginSecretReadCustody {
        return createAccountPluginSecretReadCustody({ readSnapshot, admitSharedReferences,
            ...((params.secretSources ?? params.operationContext?.secretSources)
                ? { secretSources: params.secretSources ?? params.operationContext?.secretSources } : {}),
            ...(params.operationContext ? { isCurrent: (signal?: AbortSignal) => params.operationContext!.isCurrent(signal) } : {}),
            ...(params.operationContext?.machineAdmission ? { machineAdmission: params.operationContext.machineAdmission } : {}),
        });
    }

    const resolve: PluginSecretCustodyResolver = ({ pluginId, declaration, signal }) => {
        if (declaration.custody !== 'account') return null;
        const boundReader = bindAccountSnapshotReader();
        if (!boundReader) return null;
        const requireBoundAccountSnapshot = () => { signal?.throwIfAborted(); return boundReader(); };
        const admitBoundSharedReferences: Parameters<typeof createAccountPluginSecretReadCustody>[0]['admitSharedReferences'] = async input => {
            // Binding reads retain their existing legacy-import preparation;
            // that wrapper delegates admission to the same resource read owner.
            if (!owner.admitSharedSecretForOperation) throw new Error('saved_secret_admission_unavailable');
            for (const reference of input.references) {
                await owner.admitSharedSecretForOperation({ ref: reference.ref, expectedScopeKey: input.expectedScopeKey });
            }
        };

        const custody: PluginSecretCustody = Object.freeze({
            async readSavedSecret(input) {
                return await createReadCustody(requireBoundAccountSnapshot).withSecrets({
                    references: [{ ref: input.ref,
                        ...(input.resourceRevision === undefined ? {} : { revision: input.resourceRevision }) }],
                    signal: input.signal,
                }, material => material.read(input.ref));
            },
            async saveShared(input) {
                input.signal.throwIfAborted();
                input.assertCurrent();
                requireBoundAccountSnapshot();
                if (input.admission.id !== input.secretId || !input.admission.purpose) {
                    throw custodyError('plugin_secret_save_not_admitted', 'Shared save is not admitted for this id');
                }
                const normalizeAudience = (audience: SharedSecretAudience) => {
                    if (!audience || Object.keys(audience).some(key => !['accountGrants', 'teamGrants', 'groupGrants'].includes(key))) {
                        throw custodyError('plugin_secret_save_not_admitted', 'Shared save audience is invalid');
                    }
                    return {
                        accountGrants: [...new Set(SharedSavedSecretCreateInputV1Schema.shape.accountGrants.parse(audience.accountGrants) ?? [])].sort(),
                        teamGrants: [...new Set(SharedSavedSecretCreateInputV1Schema.shape.teamGrants.parse(audience.teamGrants) ?? [])].sort(),
                        groupGrants: [...new Set(SharedSavedSecretCreateInputV1Schema.shape.groupGrants.parse(audience.groupGrants) ?? [])].sort(),
                    };
                };
                const audience = normalizeAudience(input.input.audience);
                if (!isDeepStrictEqual(audience, normalizeAudience(input.admission.audience))) {
                    throw custodyError('plugin_secret_save_not_admitted', 'Shared save audience differs from the reviewed audience');
                }
                const reviewedPurpose = input.admission.purpose;
                const assertCurrent = () => {
                    input.signal.throwIfAborted();
                    input.assertCurrent();
                    requireBoundAccountSnapshot();
                    if (input.admission.id !== input.secretId || input.admission.purpose !== reviewedPurpose
                        || !isDeepStrictEqual(audience, normalizeAudience(input.admission.audience))
                        || !isDeepStrictEqual(audience, normalizeAudience(input.input.audience))) {
                        throw custodyError('plugin_secret_save_not_admitted', 'Shared save admission changed before creation');
                    }
                };
                if (!resources.createShared) throw custodyError('plugin_secret_custody_unavailable', 'Shared resource creation is unavailable');
                const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.input.bytes);
                assertCurrent();
                const result = await resources.createShared({ name: input.input.label, value, audience,
                    createdByPlugin: { pluginId, secretId: input.secretId }, signal: input.signal, assertCurrent });
                const ref = parseSavedSecretRefV1(result.ref);
                if (ref.kind !== 'shared_resource' || !Number.isSafeInteger(result.resourceRevision) || result.resourceRevision <= 0) {
                    throw custodyError('plugin_secret_outcome_unknown', 'Shared resource creation returned no usable reference');
                }
                return Object.freeze({ ref: result.ref, resourceRevision: result.resourceRevision });
            },
            async status(secretId) {
                const target = targetFor(pluginId, secretId);
                const snapshot = requireBoundAccountSnapshot();
                const current = state(snapshot, target);
                return Object.freeze({
                    state: current.binding ? 'configured' as const : 'missing' as const,
                    revision: current.revision,
                });
            },
            async get(secretId, options) {
                const target = targetFor(pluginId, secretId);
                const snapshot = requireBoundAccountSnapshot();
                const current = state(snapshot, target);
                if (!current.binding) return null;
                const boundSecretId = current.binding.savedSecretId;
                const readCustody = createReadCustody(() => {
                    const admitted = requireBoundAccountSnapshot();
                    if (resolveBinding(admitted, target)?.savedSecretId !== boundSecretId) {
                        throw custodyError('plugin_secret_custody_unavailable', 'The plugin secret binding changed during admission');
                    }
                    return admitted;
                }, admitBoundSharedReferences);
                try {
                    return await readCustody.withSecrets({ references: [{ ref: boundSecretId }],
                        ...(options?.sourceKind ? { sourceKind: options.sourceKind } : {}),
                        ...(options?.signal ? { signal: options.signal } : {}) }, material => {
                        const admitted = state(requireBoundAccountSnapshot(), target);
                        return Object.freeze({ value: material.read(boundSecretId), revision: admitted.revision });
                    });
                } catch (error) {
                    const details = isPluginError(error) ? error.details : undefined;
                    const materialStatus = details && typeof details === 'object' && !Array.isArray(details)
                        && 'materialStatus' in details && typeof details.materialStatus === 'string' ? details.materialStatus : undefined;
                    throw custodyError(
                        'plugin_secret_custody_unavailable',
                        'Account plugin secret material is unavailable',
                        materialStatus ? { materialStatus } : undefined,
                        isPluginError(error) ? error.retryable : true,
                    );
                }
            },
            async set(input) {
                const target = targetFor(pluginId, input.secretId);
                if (params.operationContext && !params.owner) {
                    throw custodyError('plugin_secret_custody_unavailable', 'This invocation has no scoped plugin binding writer');
                }
                input.assertCurrent?.();
                const snapshot = requireBoundAccountSnapshot();
                const current = state(snapshot, target);
                assertExpectedRevision(current, input.expectedRevision);
                const existing = current.binding;
                const assertCurrent = () => { input.assertCurrent?.(); requireBoundAccountSnapshot(); };
                let savedSecretId: string;
                try {
                    savedSecretId = await resources.create({ name: savedSecretName(pluginId, input.secretId), value: input.value, assertCurrent });
                } catch (error) {
                    if (isPluginError(error)) throw error;
                    throw custodyError('plugin_secret_custody_unavailable', 'Account resource creation is unavailable');
                }
                let after: AccountSecretSnapshot;
                try {
                    after = await update(
                        snapshot,
                        (settings) => ({
                            ...applyAccountSettingsSavedSecretMutation(settings, {
                                kind: 'replacePluginSecret',
                                target,
                                expectedSecretId: existing?.savedSecretId ?? null,
                                expectedSecretUpdatedAt: personalSecretRevision(snapshot, existing),
                                secretId: savedSecretId,
                            }).settings,
                        }),
                        assertCurrent,
                        (reread) => {
                            const binding = resolveBinding(reread, target);
                            return binding?.savedSecretId === savedSecretId && binding.createdForBinding;
                        },
                    );
                } catch (error) {
                    // An unknown binding outcome may still reference this resource.
                    if (!isPluginError(error) || error.code !== 'plugin_secret_outcome_unknown') {
                        try {
                            await resources.delete({ ref: savedSecretId, assertCurrent });
                        } catch {
                            try { assertCurrent(); } catch { throw error; }
                            throw custodyError('plugin_secret_cleanup_failed', 'The binding was rejected but resource cleanup did not complete',
                                { bindingErrorCode: isPluginError(error) ? error.code : 'plugin_secret_custody_unavailable' });
                        }
                    }
                    throw error;
                }
                await cleanup(snapshot, after, assertCurrent);
                const next = stateForSettledMutation(after, target, assertCurrent);
                if (!next.binding) {
                    throw custodyError(
                        'plugin_secret_custody_unavailable',
                        'Account plugin secret mutation did not produce a binding',
                    );
                }
                return Object.freeze({ revision: next.revision });
            },
            async delete(input) {
                const target = targetFor(pluginId, input.secretId);
                if (params.operationContext && !params.owner) {
                    throw custodyError('plugin_secret_custody_unavailable', 'This invocation has no scoped plugin binding writer');
                }
                input.assertCurrent?.();
                const snapshot = requireBoundAccountSnapshot();
                const current = state(snapshot, target);
                assertExpectedRevision(current, input.expectedRevision);
                const existing = current.binding;
                if (!existing) return Object.freeze({ revision: current.revision });
                const assertCurrent = () => { input.assertCurrent?.(); requireBoundAccountSnapshot(); };
                const after = await update(
                    snapshot,
                    (settings) => ({
                        ...applyAccountSettingsSavedSecretMutation(settings, {
                            kind: 'removePluginSecret',
                            target,
                            expectedSecretId: existing.savedSecretId,
                            expectedSecretUpdatedAt: personalSecretRevision(snapshot, existing),
                        }).settings,
                    }),
                    assertCurrent,
                    (reread) => resolveBinding(reread, target) === null,
                );
                await cleanup(snapshot, after, assertCurrent);
                return Object.freeze({ revision: stateForSettledMutation(after, target, assertCurrent).revision });
            },
        });
        return custody;
    };

    async function bindExisting(input: Readonly<{
        pluginId: string;
        secretId: string;
        savedSecretId: string;
        expectedRevision?: string;
        assertCurrent?: () => void;
    }>): Promise<Readonly<{ revision: string }>> {
        const snapshot = requireSnapshot();
        const lifetimeToken = owner.readLifetimeToken?.();
        const target = targetFor(input.pluginId, input.secretId);
        const assertCurrent = (): void => {
            input.assertCurrent?.();
            if (
                lifetimeToken !== undefined
                && owner.readLifetimeToken?.() !== lifetimeToken
            ) {
                throw custodyError(
                    'plugin_secret_custody_unavailable',
                    'The active Account lifetime ended during plugin secret administration',
                );
            }
            assertSnapshotCurrent(snapshot);
        };

        assertCurrent();
        const current = state(snapshot, target);
        assertExpectedRevision(current, input.expectedRevision);
        const selected = createSavedSecretMaterializerFromSnapshotV1(snapshot)
            .inspect(input.savedSecretId);
        if (selected.status !== 'ready') {
            throw custodyError(
                'plugin_secret_custody_unavailable',
                'The selected Account SavedSecret is unavailable',
                { materialStatus: selected.status },
                selected.status === 'temporarily_unavailable',
            );
        }
        const existing = current.binding;
        const after = await update(
            snapshot,
            (settings) => ({
                ...applyAccountSettingsSavedSecretMutation(settings, {
                    kind: 'bindPluginSecret',
                    target,
                    expectedSecretId: existing?.savedSecretId ?? null,
                    expectedSecretUpdatedAt: personalSecretRevision(snapshot, existing),
                    secretId: input.savedSecretId,
                }).settings,
            }),
            assertCurrent,
            (reread) => {
                const binding = resolveBinding(reread, target);
                return binding?.savedSecretId === input.savedSecretId
                    && binding.createdForBinding === false;
            },
        );
        await cleanup(snapshot, after, assertCurrent);
        const next = stateForSettledMutation(after, target, assertCurrent);
        if (
            next.binding?.savedSecretId !== input.savedSecretId
            || next.binding.createdForBinding !== false
        ) {
            throw custodyError(
                'plugin_secret_custody_unavailable',
                'Account plugin secret mutation did not produce the selected binding',
            );
        }
        return Object.freeze({ revision: next.revision });
    }

    async function unbind(input: Readonly<{
        pluginId: string;
        secretId: string;
        expectedRevision?: string;
        assertCurrent?: () => void;
    }>): Promise<Readonly<{ revision: string }>> {
        const snapshot = requireSnapshot();
        const lifetimeToken = owner.readLifetimeToken?.();
        const target = targetFor(input.pluginId, input.secretId);
        const assertCurrent = (): void => {
            input.assertCurrent?.();
            if (
                lifetimeToken !== undefined
                && owner.readLifetimeToken?.() !== lifetimeToken
            ) {
                throw custodyError(
                    'plugin_secret_custody_unavailable',
                    'The active Account lifetime ended during plugin secret administration',
                );
            }
            assertSnapshotCurrent(snapshot);
        };

        assertCurrent();
        const current = state(snapshot, target);
        assertExpectedRevision(current, input.expectedRevision);
        const existing = current.binding;
        if (!existing) return Object.freeze({ revision: current.revision });
        const after = await update(
            snapshot,
            (settings) => ({
                ...applyAccountSettingsSavedSecretMutation(settings, {
                    kind: 'unbindPluginSecret',
                    target,
                    expectedSecretId: existing.savedSecretId,
                    expectedSecretUpdatedAt: personalSecretRevision(snapshot, existing),
                }).settings,
            }),
            assertCurrent,
            (reread) => resolveBinding(reread, target) === null,
        );
        await cleanup(snapshot, after, assertCurrent);
        return Object.freeze({ revision: stateForSettledMutation(after, target, assertCurrent).revision });
    }

    return Object.freeze({ resolve, bindExisting, unbind,
        bindReadCustody(input: Readonly<{ signal: AbortSignal; isCurrent(): boolean }>) {
            const reader = bindAccountSnapshotReader();
            if (!reader) return null;
            return createReadCustody(() => {
                if (input.signal.aborted || !input.isCurrent()) {
                    throw custodyError('plugin_generation_stale', 'Plugin secret invocation retired');
                }
                return reader();
            });
        },
    });
}
