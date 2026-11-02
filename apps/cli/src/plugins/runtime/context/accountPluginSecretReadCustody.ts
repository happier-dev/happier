import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import type { SavedSecretOperationReferenceV1 } from '@/settings/secrets/savedSecretCatalogRead';



type Reference = Readonly<Pick<SavedSecretOperationReferenceV1, 'ref' | 'revision'>>;
type Material = Readonly<{ read(ref: string): string; assertCurrent(): void }>;
type ReadInput = Readonly<{ references: readonly Reference[]; signal?: AbortSignal; sourceKind?: 'inline' }>;

/** Host-private, operation-scoped custody shared by declared get and HTTP use. */
export type AccountPluginSecretReadCustody = Readonly<{
    withSecrets<T>(input: ReadInput,
        consume: (material: Material) => T | Promise<T>): Promise<T>;
}>;

export function createAccountPluginSecretReadCustody(params: Readonly<{
    /** Already bound by the Account router; throws after its captured lifetime retires. */
    readSnapshot(): ActiveAccountSettingsSnapshot;

    /** The requester's Machine access; acquisition owns the native-source Manage rule. */

    isCurrent?(signal?: AbortSignal): Promise<boolean>;
    admitSharedReferences(input: Readonly<{
        references: readonly Reference[]; expectedScopeKey: string; signal?: AbortSignal;
    }>): Promise<void>;
}>): AccountPluginSecretReadCustody {
    return Object.freeze({
        async withSecrets<T>(input: ReadInput,
            consume: (material: Material) => T | Promise<T>): Promise<T> {
            const selected = new Map<string, Readonly<{ value: string; fingerprint: string; revision?: number }>>();
            const currentSnapshot = () => { input.signal?.throwIfAborted(); return params.readSnapshot(); };
            const assertAsyncCurrent = async () => {
                currentSnapshot();
                if (params.isCurrent && !await params.isCurrent(input.signal)) {
                    throw new PluginError({ code: 'plugin_secret_custody_unavailable', message: 'Account secret custody retired' });
                }
                return currentSnapshot();
            };
            try {
                const before = await assertAsyncCurrent();
                const references = new Map<string, Reference>();
                for (const reference of input.references) {
                    const previous = references.get(reference.ref);
                    if (previous && previous.revision !== reference.revision) {
                        throw new PluginError({ code: 'secret_missing', message: 'Secret revisions conflict' });
                    }
                    references.set(reference.ref, reference);
                }
                const shared = [...references.values()].filter(reference => parseSavedSecretRefV1(reference.ref).kind === 'shared_resource');
                if (shared.length > 0) {
                    await params.admitSharedReferences({ references: shared, expectedScopeKey: before.scopeKey ?? '',
                        ...(input.signal ? { signal: input.signal } : {}) });
                }
                const snapshot = await assertAsyncCurrent();
                const isCurrent = () => { try { currentSnapshot(); return true; } catch { return false; } };
                const materializer = createSavedSecretMaterializerFromSnapshotV1(snapshot, { isCurrent });
                for (const [ref, reference] of references) {
                    if (reference.revision !== undefined && !materializer.matchesSharedResourceRevision(ref, reference.revision)) {
                        throw new PluginError({ code: 'secret_missing', message: 'Secret revision is no longer current' });
                    }
                    const resolved = materializer.resolve(ref);
                    if (resolved.status !== 'ready') {
                        const parsed = parseSavedSecretRefV1(ref);
                        const resource = parsed.kind === 'shared_resource'
                            ? snapshot.savedSecretResources?.find(row => row.resourceId === parsed.resourceId) : undefined;
                        const needsClient = resolved.status === 'temporarily_unavailable' && resource?.encryptionMode === 'e2ee'
                            && !resource.resourceDataKey && resource.materialStatus === 'ready';
                        throw new PluginError({ code: needsClient ? 'secret_use_client_required' : 'secret_missing',
                            message: 'Account secret material is unavailable', details: { materialStatus: resolved.status,
                                 },
                            retryable: resolved.status === 'temporarily_unavailable' });
                    }
                    selected.set(ref, { value: resolved.value, fingerprint: resolved.fingerprint,
                        ...(reference.revision === undefined ? {} : { revision: reference.revision }) });
                }
                const material: Material = Object.freeze({
                    read(ref) {
                        const value = selected.get(ref);
                        if (!value) throw new PluginError({ code: 'secret_missing', message: 'Secret was not admitted for this operation' });
                        return value.value;
                    },
                    assertCurrent() {
                        const latest = createSavedSecretMaterializerFromSnapshotV1(currentSnapshot(), { isCurrent });
                        for (const [ref, value] of selected) {
                            const inspection = latest.inspect(ref);
                            if ((value.revision !== undefined && !latest.matchesSharedResourceRevision(ref, value.revision))
                                || inspection.status !== 'ready' || inspection.fingerprint !== value.fingerprint
                                || materializer.recheck(ref, value.fingerprint).status !== 'ready') {
                                throw new PluginError({ code: 'secret_missing', message: 'Admitted secret material changed' });
                            }
                        }
                    },
                });
                material.assertCurrent();
                return await consume(material);
            } finally {
                selected.clear();
            }
        },
    });
}
