import { afterEach, describe, expect, it } from 'vitest';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { createMachineFixture, createPlainMachineRowFixture, createReadyMachineAgentInventoryFixture, createSessionFixture, standardCleanup } from '@/dev/testkit';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';

installSessionFilesViewBoundaries();
await prepareSessionFilesViewTestkit();
const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { listReviewEngines } = await import('@/sync/ops/reviews/reviewWalkthrough');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

describe('daemon-owned Review engine inventory', () => {
    it.each([{ detached: false, cold: false }, { detached: true, cold: false }, { detached: false, cold: true }])(
        'reads exact launch models from the captured Machine (detached=$detached, cold=$cold)', async ({ detached, cold }) => {
        const requests: unknown[] = [];
        let sessionStatus = 200;
        let sessionReads = 0;
        const items = [{ engineId: 'claude', value: 'claude', label: 'Claude', backendId: 'claude', enabled: true,
            capabilities: { structuredNarration: true }, launchModelId: 'account-review-model' },
        { engineId: 'codex', value: 'codex', label: 'Codex', backendId: 'codex', enabled: true,
            capabilities: { structuredNarration: true } }];
        const profileSelections = [{ engineId: 'claude', profileId: 'review:focused' }];
        const selectionItems = [{ ...items[0], profileId: 'review:focused', enabled: false, available: false,
            readiness: 'needsSignIn', unavailableCode: 'needsSignIn' }];
        const inventoryBoundary = await createExternalActionAccountHttpBoundary({
            serverUrl: 'https://session-file-views.test', serverIdentityId: 'srv_review_inventory', accountId: 'alice',
            machineId: 'm1', tokenEpoch: 0, actionId: 'review.engines.list', requesterInvocation: 'none',
            execute: (input: unknown, { target }) => {
                requests.push({ input, target });
                return { sessionId: detached ? null : 's1', items,
                    ...(input && typeof input === 'object' && 'profileSelections' in input ? { selectionItems } : {}) };
            },
        });
        const machineInventory = createReadyMachineAgentInventoryFixture(items.map(item => ({ agentId: item.engineId, title: item.label })));
        const sessionReadBoundary = createSessionReadBatchFetchBoundary(async (url, init) => {
            if (new URL(String(url)).pathname === '/v2/sessions/s1') {
                return sessionStatus === 200
                    ? Response.json(createPlainSessionByIdResponseFixture(createSessionFixture({ id: 's1', encryptionMode: 'plain',
                        metadata: { path: '/repo', machineId: 'm1', host: 'tester.local' } })))
                    : Response.json({ error: sessionStatus === 404 ? 'Session not found' : 'Forbidden' }, { status: sessionStatus });
            }
            if (new URL(String(url)).pathname === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(AcpCatalogRowReadResponseV1Schema.parse({
                status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } },
            }));
            return await inventoryBoundary.handle(new URL(String(url)), init) ?? Response.json({}, { status: 404 });
        });
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo',
            credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, serverIdentityId: 'srv_review_inventory',
            machine: createMachineFixture({ id: 'm1', kind: 'persistent', revokedAt: null, replacedByMachineId: null,
                installationId: 'test-installation', storageMode: 'plain', access: createPlainMachineRowFixture({ id: 'm1', accountId: 'alice' }).access }),
            rpc: async ({ method }) => method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
                ? { protocolVersion: 1, projection: machineInventory.projection }
                : method === RPC_METHODS.CAPABILITIES_DETECT ? machineInventory.capabilities
                : { success: false, error: 'RPC method not available', errorCode: 'METHOD_NOT_AVAILABLE' },
            request: async (url, init) => {
                if (new URL(String(url)).pathname === '/v2/sessions/read-batch') sessionReads += 1;
                return await sessionReadBoundary(url, init);
            },
        });
        // The owning Session target selects transport; it cannot supply a competing model default.
        fixture.storage.getState().applySessions([createSessionFixture({ ...fixture.session, id: 's1',
            metadata: { ...fixture.session.metadata!, machineId: 'm1' } })]);
        if (cold) fixture.storage.setState({ sessions: {}, sessionListRowsByServerId: {} });
        const inventoryInput = { sessionId: detached ? null : 's1',
            ...(detached ? { machineId: 'm1' } : {}), serverId: fixture.home.id, scope: 'paths' as const };
        const executor = createDefaultActionExecutor({ resolveServerIdForSessionId: () => fixture.home.id });
        expect(await executor.execute('review.engines.list', inventoryInput, { serverId: fixture.home.id }))
            .toMatchObject({ ok: true, result: { sessionId: detached ? null : 's1', items } });
        expect(requests).toEqual([expect.objectContaining({ target: { kind: 'machine', machineId: 'm1' },
            input: { sessionId: null, machineId: 'm1', scope: 'paths' } })]);
        const selected = await executor.execute('review.engines.list', { ...inventoryInput, profileSelections }, {
            serverId: fixture.home.id,
            ...(detached ? { executionRunTargetMachineId: 'm1', externalActionTarget: { kind: 'machine', machineId: 'm1' } }
                : { defaultSessionId: 's1' }),
        });
        expect(requests.at(-1)).toMatchObject({ input: { sessionId: null, machineId: 'm1', scope: 'paths', profileSelections } });
        expect(selected).toMatchObject({ ok: true, result: { items, selectionItems } });
        expect(await listReviewEnginesForVoiceTool({ sessionId: null, machineId: '', serverId: fixture.home.id }))
            .toMatchObject({ ok: false, errorCode: 'machine_not_selected' });
        expect(await listReviewEnginesForVoiceTool({ sessionId: null, machineId: 'm1' }))
            .toMatchObject({ ok: false, errorCode: 'server_not_selected' });
        if (!cold) {
            expect(await listReviewEnginesForVoiceTool({ sessionId: 's1', machineId: 'm1', serverId: 'another-home' }))
                .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        }
        const listed = await listReviewEngines({ sessionId: detached ? null : 's1', machineId: 'm1', serverId: fixture.home.id });
        if (!listed.ok) throw new Error(`Review Action inventory refused: ${JSON.stringify(listed)}`);
        expect(listed.inventory.items).toEqual([
            expect.objectContaining({ engineId: 'claude', launchModelId: 'account-review-model' }),
            expect.objectContaining({ engineId: 'codex' }),
        ]);
        expect(sessionReads).toBe(cold ? 3 : 0);
        if (cold) {
            for (const [status, errorCode] of [[404, 'not_found'], [403, 'forbidden']] as const) {
                sessionStatus = status;
                const before = requests.length;
                expect(await executor.execute('review.engines.list', inventoryInput, { serverId: fixture.home.id }))
                    .toMatchObject({ ok: false, errorCode });
                expect(requests).toHaveLength(before);
            }
        }
    });
});
