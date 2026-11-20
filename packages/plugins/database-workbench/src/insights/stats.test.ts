import { expect, it } from 'vitest';
import { createDatabaseDescriptorV1Fixture } from '@happier-dev/database-protocol/testing/v1';
import { createWorkbenchInstance, workbenchTargetKey } from '../ui/workbench.js';
import type { WorkbenchClient, WorkbenchLocation } from '../ui/models.js';
import { createNativeFindingFixture, target } from './nativeFixture.testkit.js';

it('keeps selected insight demand pending, shares its native read, and distinguishes unavailable statistics', async () => {
    const native = await createNativeFindingFixture();
    const descriptor = { ...createDatabaseDescriptorV1Fixture(), target, engine: 'sqlite' as const };
    const targetKey = workbenchTargetKey(target);
    let release: () => void = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const unexpected = async (): Promise<never> => { throw new Error('Insights must use the selected stats Action only'); };
    // Genuine Action transport boundary; the production SQLite query/decoder remains real.
    const client: WorkbenchClient = { targets: unexpected, access: unexpected, saveExport: unexpected,
        async operation(input) {
            await held;
            const { connection } = await native.resolve();
            try { return await connection.execute(input); } finally { await connection.close(); }
        }, subscribeOwnWrites: () => () => {}, navigate: async () => {}, openRoot: async () => {}, setUnsavedChanges: async () => {},
        presentDeviceStorageError(error) { throw error; } };
    const location: WorkbenchLocation = { targetKey, mode: 'overview', sort: [], columns: [], page: { rows: 20, offset: 0 }, fkTrail: [] };
    const instance = createWorkbenchInstance({ client, selectedTarget: descriptor, location, cataloguePageRows: 20,
        scope: { kind: 'worktree', accountId: target.accountId, installationId: target.installationId,
            projectKey: target.projectKey, workspace: target.workspace },
        consoleStorage: () => ({ read: async () => null, write: async () => {} }), statementRanges: () => [] });
    try {
        const request = { kind: 'stats.read', group: 'tables', selection: { schema: 'main', page: { rows: 20 } } } as const;
        const resource = instance.stats(targetKey, request);
        expect(native.sqlReads()).toBe(0);
        const pending = resource.demand();
        expect(instance.stats(targetKey, request)).toBe(resource);
        expect(resource.get()).toEqual({ status: 'loading' });
        release();
        await pending;
        expect(resource.get()).toMatchObject({ status: 'ready', data: { status: 'available', group: 'tables',
            completeness: { complete: true }, data: [{ relation: { name: 'first' } }, { relation: { name: 'second' } }] } });
        await instance.stats(targetKey, request).demand();
        expect(native.sqlReads()).toBe(1);
        const statements = instance.stats(targetKey, { kind: 'stats.read', group: 'statements', selection: { order: 'totalTime', page: { rows: 20 } } });
        await statements.demand();
        expect(statements.get()).toMatchObject({ status: 'ready', data: { status: 'unavailable', group: 'statements', reason: 'unsupported_group' } });
    } finally { instance.close(); await native.dispose(); }
});
