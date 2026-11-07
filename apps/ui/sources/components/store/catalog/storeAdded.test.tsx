import { afterEach, expect, it, vi } from 'vitest';
import { act, createMachineFixture, createRenderCommitCounter, flushHookEffects, renderHook,
    standardCleanup, useRenderCommitCounter } from '@/dev/testkit';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';
import { createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { createSeededSkillsHome } from '@/dev/testkit/harness/skillsSurfaceHarness';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';

installPromptRegistriesCommonModuleMocks({ storage: original => original() });
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const { storage } = await import('@/sync/domains/state/storage');
const { useSkillAdded } = await import('./storeAdded');

afterEach(() => { standardCleanup(); rpc.reset(); });

it('publishes a Skill Added fact only for library changes, with zero renders or reads for Machine arrivals', async () => {
    const item: RegistryCatalogItemSummary = { kind: 'skill', sourceId: 'test:skills', itemId: 'review', title: 'Review', version: '1' };
    const home = await createSeededSkillsHome('https://store-added-membership.test', { skills: [{ id: 'held-review', header: {
        skillLock: { provenance: { kind: 'registry', registry: { sourceId: item.sourceId, itemId: item.itemId,
            format: 'skills-sh', sourceUrl: 'https://skills.sh', importedAt: 1,
            ref: { kind: 'gitTree', repo: 'https://example.com/skills.git', commit: 'pinned', treeSha: 'tree', path: 'review' } } }, updatePolicy: 'manual' },
    } }] });
    const scope = storage.getState().settingsScope!;
    // The Home seed is not a client inventory receipt. Publish this known row
    // through the real admission writer before testing its later removal.
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(home.home.id);
    try {
        const current = await account.fetchArtifact('held-review');
        if (!current?.isDecrypted) throw new Error('Expected admitted Skill');
        storage.getState().applyArtifacts([current], storage.getState().artifacts, 'browserListed');
    } finally { account.dispose(); }
    const machines = Array.from({ length: 101 }, (_, index) => createMachineFixture({ id: `store-added-${index}`,
        metadata: { ...createMachineFixture().metadata!, agentInventory: { checkedAt: 1, installedAgentIds: ['codex'] } } }));
    await act(async () => { storage.getState().applyMachines(machines, true,
        { sourceServerId: scope.serverId, sourceAccountId: scope.accountId }); });
    const count = createRenderCommitCounter();
    const hook = await renderHook(() => { const added = useSkillAdded(true); useRenderCommitCounter(count); return added; });
    try {
        await vi.waitFor(() => expect(hook.getCurrent()(item)).toBe(true));
        await flushHookEffects();
        count.reset();
        const reads = home.requests.length;
        for (let arrival = 0; arrival < 3; arrival++) {
            await act(async () => { storage.getState().applyMachines(machines.map(machine => ({ ...machine,
                activeAt: Date.now() + arrival, metadata: { ...machine.metadata!, displayName: `Arrival ${arrival}` } })), true,
            { sourceServerId: scope.serverId, sourceAccountId: scope.accountId }); });
        }
        expect(count.read()).toEqual({ renders: 0, commits: 0 });
        expect(home.requests.length - reads).toBe(0);
        expect(rpc.state.requests).toHaveLength(0);
        expect(hook.getCurrent()(item)).toBe(true);
        // A remote deletion followed by its ordinary local arrival, with real library revalidation.
        home.boundary.clear();
        await act(async () => { storage.getState().deleteArtifact('held-review'); });
        await vi.waitFor(() => expect(hook.getCurrent()(item)).toBe(false));
        expect(count.read().commits).toBeGreaterThan(0);
    } finally { await hook.unmount(); await home.dispose(); }
});
