import { afterEach, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowMutationRequestV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';

const announce = vi.hoisted(() => vi.fn());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock(
    { platformOS: 'ios' }, { AccessibilityInfo: { announceForAccessibility: announce } },
));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { useProjectSessionDefaultsEditor } = await import('./useProjectSessionDefaults');

afterEach(async () => {
    standardCleanup();
    announce.mockClear();
    await homes.reset();
});

it('announces a saved model once after Project defaults settle', async () => {
    const accountId = 'account-owner';
    const serverId = await homes.addHome({
        name: 'Project defaults Home', serverUrl: 'https://project-defaults.test', accountId,
        currentAccount: true, accountEncryptionMode: 'plain',
    });
    const projectRef = { serverId, projectKey: 'project-app' };
    const agentTargetKey = 'agent:happier.agent.muse/muse';
    const current = { modelByAgentTargetKey: { [agentTargetKey]: {
        v: 2 as const, updatedAt: 1, ref: { source: 'native' as const, agentTargetKey, modelId: 'meta/muse-spark-1.2-contributor' },
    } } };
    const next = { modelByAgentTargetKey: { [agentTargetKey]: {
        v: 2 as const, updatedAt: 2, ref: { source: 'native' as const, agentTargetKey, modelId: 'meta/muse-spark-1.3-contributor' },
    } } };
    const row = { revision: 25, defaults: next };
    const receipt = vi.fn();
    const hook = await renderHook(() => useProjectSessionDefaultsEditor({ scope: 'personal-project', read: {
        scope: { serverId, accountId }, input: { projectRef }, status: 'ready', error: null,
        data: { context: {}, personalDefaultsRow: { revision: 24, defaults: current }, sourceDefaultsRow: null,
            source: null, canManageSource: false, repairRequired: false },
        refresh: async () => {},
        applyDefaultsReceipt: receipt,
    } }));
    const path = `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`;
    homes.answer(serverId, `POST ${path}`, { status: 503, body: {} });
    await act(async () => { await hook.getCurrent().save(current); });
    expect(homes.requestsFor(path)).toHaveLength(0);
    await act(async () => { await expect(hook.getCurrent().save(next)).rejects.toThrow(); });
    expect(homes.requestsFor(path)).toHaveLength(1);
    expect(announce).not.toHaveBeenCalled();
    homes.answer(serverId, `POST ${path}`, { select: input => {
        const [mutation] = ProjectAccountRowMutationRequestV1Schema.parse(input).mutations;
        if (!mutation) throw new Error('Missing the Project defaults mutation');
        expect(mutation).toMatchObject({ key: { kind: 'project-session-defaults', ...projectRef },
            expectedRevision: 24, content: { t: 'plain', v: { value: next } } });
        expect(announce).not.toHaveBeenCalled();
        return { body: { status: 'updated', rows: [{ key: mutation.key, content: mutation.content, revision: 25 }], cursor: 25 } };
    } });
    await act(async () => { await hook.getCurrent().save(next); });
    expect(receipt).toHaveBeenCalledExactlyOnceWith('personal-project', row);
    expect(announce).toHaveBeenCalledExactlyOnceWith(expect.any(String));
});
