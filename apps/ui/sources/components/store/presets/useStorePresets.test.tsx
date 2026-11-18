import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import type { PresetMutationResultV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { createPlainManagedMachinePresetFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { MachinePresetActionInputSchemasV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { useStorePresets } = await import('./useStorePresets');
const { useStorePresetEditor } = await import('./useStorePresetEditor');
beforeEach(async () => { await home.reset();
    (await import('@/sync/ops/actions/scopedHomeActionExecutor')).resetScopedHomeActionExecutorsForTests(); });
afterEach(() => { vi.useRealTimers(); return standardCleanup(); });

it('reads a shelf once, counts saved items, reads one editor without history, and saves without installing', async () => {
    const serverId = await home.addHome({ name: 'Presets', serverUrl: 'https://store-presets.test',
        serverIdentityId: 'srv_store_presets', accountId: 'owner', currentAccount: true, accountEncryptionMode: 'plain' });
    const item = { kind: 'softwareRecipe' as const, selection: { ref: { pluginId: 'tools.example', recipeId: 'editor', revision: '1' }, inputs: {} } };
    let wire = createPlainManagedMachinePresetFixture({ homeId: 'srv_store_presets', id: 'tools', revision: 3, name: 'Tools',
        owner: { kind: 'account', accountId: 'owner' }, setup: { items: [item], scripts: [{ body: 'echo ready' }] } });
    let preset = wire.opened;
    home.answer(serverId, '/v1/machines/presets/list', { select: () => ({ body: { kind: 'listed', presets: [wire] } }) });
    home.answer(serverId, '/v1/machines/presets/get', { select: () => ({ body: { kind: 'found', preset: wire } }) });
    home.answer(serverId, '/v1/machines/presets/recipient-census', { body: { kind: 'ready', contentEncryptionMode: 'plain', recipients: [] } });
    home.answer(serverId, '/v1/machines/presets/update', { select: value => {
        const input = MachinePresetActionInputSchemasV1['machines.presets.update'].parse(value);
        expect(input.expectedRevision).toBe(3);
        const nextName = input.patch.content?.t === 'plain' ? input.patch.content.v.name : preset.name;
        wire = createPlainManagedMachinePresetFixture({ homeId: preset.homeId, id: preset.id, revision: 4,
            name: nextName, owner: preset.owner, setup: preset.setup });
        preset = wire.opened;
        return { body: { kind: 'saved', preset: wire } };
    } });
    const shelf = await renderHook(() => useStorePresets([serverId]));
    await waitForHomeGovernance(() => expect(shelf.getCurrent().rows).toHaveLength(1));
    expect(shelf.getCurrent().rows[0]?.counts).toEqual({ apps: 0, software: 1, setupRecipes: 0, scripts: 1 });
    expect(home.requestsFor('/v1/machines/presets/list')).toHaveLength(1);
    const editor = await renderHook(() => useStorePresetEditor({ serverId, presetId: preset.id }));
    await waitForHomeGovernance(() => expect(editor.getCurrent().state.value?.id).toBe(preset.id));
    expect(home.requestsFor('/v1/machines/presets/get')).toHaveLength(1);
    expect(home.requestsFor('/v1/machines/managed/actions/list')).toHaveLength(0);
    await act(async () => {
        let settled: PresetMutationResultV1 | undefined;
        const result = await editor.getCurrent().client!.saveDraft({ preset: { ...preset, id: preset.id, revision: preset.revision }, draft: { name: 'Renamed', setup: preset.setup } },
            { onApprovalSucceeded: value => { settled = value; } });
        if (result.kind === 'approval_pending') {
            await expect(decideApprovalAsInbox(serverId, result.approval.artifactId, 'approve')).resolves.toMatchObject({ ok: true });
            await waitForHomeGovernance(() => expect(settled?.kind).toBe('saved'));
        } else {
            expect(result).toMatchObject({ kind: 'succeeded', value: { kind: 'saved' } });
            if (result.kind === 'succeeded') preset = result.value.preset;
        }
    });
    expect(preset.name).toBe('Renamed');
    expect(home.requests.filter(row => /\/setup\/|\/templates\/instantiate/.test(row.path))).toEqual([]);
    const reads = home.requestsFor('/v1/machines/presets/list').length + home.requestsFor('/v1/machines/presets/get').length;
    vi.useFakeTimers();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(home.requestsFor('/v1/machines/presets/list').length + home.requestsFor('/v1/machines/presets/get').length).toBe(reads);
    await shelf.unmount(); await editor.unmount();
});
