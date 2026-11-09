import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionDefinition, PluginAccountCollection } from '@happier-dev/plugin-sdk/collections';
import type { PluginUiDataClient, PluginUiAccountCollectionForDefinition } from '@happier-dev/plugin-ui/data';
import type { AccountKvService } from '@happier-dev/plugin-sdk/storage';
import {
    PluginAccountKvRowError, createEmptyPluginAccountKvRowV1, clonePluginAccountKvRowV1,
    readPluginAccountKvEntryV1, projectPluginAccountKvEntryV1, normalizePluginAccountKvLogicalKeyV1,
    assertPluginAccountKvExpectedVersionV1, setPluginAccountKvEntryV1, deletePluginAccountKvEntryV1,
    listPluginAccountKvEntriesV1, commitPluginAccountKvMutationV1,
} from '@happier-dev/protocol/plugins/data/accountKvV1';
import { createInMemoryAccountCollection } from '../../../../../packages/plugins/triage/src/corpus/collections/inMemoryAccountCollection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

type Value = Readonly<Record<string, JsonValue>>;
type Collection = Omit<PluginAccountCollection<Value>, 'watch'>;

const unavailable = async (): Promise<never> => { throw new PluginError({ code: 'unavailable', message: 'This operation has no demo transport.' }); };

/** A demo-lifetime replacement for the remote Account Data boundary, never an authenticated client. */
export function createDemoPluginDataClient(input: Readonly<{
    pluginId: string;
    accountLifetime: ActiveServerAccountScopeLifetime;
}>): PluginUiDataClient {
    const collections = new Map<string, Collection>();
    let kvRow = createEmptyPluginAccountKvRowV1();
    let kvRevision = 0;
    function assertCurrent() {
        if (!input.accountLifetime.isCurrent()) throw new PluginError({ code: 'plugin_account_storage_unavailable', message: 'The demo mount has retired.' });
    }
    input.accountLifetime.onRetire(() => {
        collections.clear();
        kvRow = createEmptyPluginAccountKvRowV1();
    });
    async function kvOperation<T>(operation: () => T | Promise<T>): Promise<T> {
        assertCurrent();
        try { return await operation(); }
        catch (error) {
            if (error instanceof PluginAccountKvRowError) throw new PluginError({ code: error.code, message: error.message });
            throw error;
        }
    }
    function kvTransaction(row: typeof kvRow) {
        return {
            async get<T extends JsonValue = JsonValue>(key: string) {
                return kvOperation(() => {
                    const entry = readPluginAccountKvEntryV1(row, normalizePluginAccountKvLogicalKeyV1(key));
                    return entry === undefined ? null : projectPluginAccountKvEntryV1<T>(entry);
                });
            },
            async set(key: string, value: JsonValue, options: Readonly<{ expectedVersion: number | 'absent' }>) {
                return kvOperation(() => {
                    const normalized = normalizePluginAccountKvLogicalKeyV1(key);
                    const previous = assertPluginAccountKvExpectedVersionV1(row, normalized, options.expectedVersion);
                    return { version: setPluginAccountKvEntryV1(row, normalized, value, previous) };
                });
            },
            async delete(key: string, options: Readonly<{ expectedVersion: number }>) {
                return kvOperation(() => {
                    const normalized = normalizePluginAccountKvLogicalKeyV1(key);
                    const previous = assertPluginAccountKvExpectedVersionV1(row, normalized, options.expectedVersion);
                    if (previous === undefined) throw new PluginAccountKvRowError('plugin_account_kv_conflict', 'Key is absent.');
                    return { version: deletePluginAccountKvEntryV1(row, normalized, previous), deleted: true as const };
                });
            },
        };
    }
    const accountKv: AccountKvService = {
        get: <T extends JsonValue = JsonValue>(key: string) => kvTransaction(kvRow).get<T>(key),
        async set(key, value, options) { const result = await kvTransaction(kvRow).set(key, value, options); kvRevision++; return result; },
        async delete(key, options) { const result = await kvTransaction(kvRow).delete(key, options); kvRevision++; return result; },
        list: options => kvOperation(() => listPluginAccountKvEntriesV1({ row: kvRow, revision: kvRevision, ...options })),
        transaction: operation => kvOperation(async () => {
            const snapshot = { row: kvRow, revision: kvRevision };
            const pendingRow = clonePluginAccountKvRowV1(kvRow);
            const result = await operation(kvTransaction(pendingRow));
            await commitPluginAccountKvMutationV1({ snapshot, pendingRow, assertCurrent,
                async write(observed, pending) {
                    if (kvRevision !== observed.revision) return 'conflict';
                    kvRow = pending; kvRevision++;
                    return 'updated';
                } });
            return result;
        }),
    };

    function collection<TDefinition extends PluginAccountCollectionDefinition>(definition: TDefinition): PluginUiAccountCollectionForDefinition<TDefinition> {
        assertCurrent();
        let existing = collections.get(definition.id);
        if (!existing) {
            // Reuse the package's schema-backed Account boundary fixture. All corpus
            // decisions remain real; this adapter adds only the existing demo lifetime.
            const fixture = createInMemoryAccountCollection({ definition, pluginId: input.pluginId,
                accountEncryptionMode: 'plain', material: null }).collection;
            existing = {
                sharing: fixture.sharing,
                async identityTag(request) { assertCurrent(); return fixture.identityTag(request); },
                async get(id) { assertCurrent(); return fixture.get(id); },
                async put(value, options) { assertCurrent(); return fixture.put(value, options); },
                async delete(id, options) { assertCurrent(); return fixture.delete(id, options); },
                async forget(id, options) { assertCurrent(); return fixture.forget(id, options); },
                async query(request) { assertCurrent(); return fixture.query(request); },
                async batch(operations) { assertCurrent(); return fixture.batch(operations); },
                async limits() { assertCurrent(); return fixture.limits(); },
                async measureBatch(operations) { assertCurrent(); return fixture.measureBatch(operations); },
            } satisfies Collection;
            collections.set(definition.id, existing);
        }
        // The generic UI carrier crosses the package fixture's genuine persistence boundary; writes use its declared schema.
        return existing as PluginUiAccountCollectionForDefinition<TDefinition>;
    }
    return { collection, accountKv, openCollectionQuery: unavailable };
}
