import { describe, expect, it, vi } from 'vitest';
import {
    PluginUiJsonObjectV1Schema,
    type PluginUiJsonObjectV1,
    type PluginUiSessionPlacementCandidateV1,
} from '@happier-dev/protocol/plugins/ui';
import type { SessionServerStartSpawnDraftV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';

import {
    composeSessionServerStartDraft,
    type SessionServerStartDraftPresentation,
    type SessionServerStartDraftTarget,
} from '@/components/sessions/new/serverStartDraftComposer';
import { createPluginActionInputSelector } from './pluginActionInputSelectionHostApi';

const accountLifetime = {
    scope: { serverId: 'server-a', accountId: 'account-a' },
    isCurrent: () => true,
    onRetire: () => ({ dispose() {} }),
};
const selectedDraft: SessionServerStartSpawnDraftV1 = {
    executionTarget: { serverId: 'server-a', machineId: 'destination-machine' },
    directory: { kind: 'path', path: '/checkout' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
};
const hostAction = { action: 'session.spawn_new', projection: 'serverStartDraft' } as const;
const candidates: readonly PluginUiSessionPlacementCandidateV1[] = [
    { projectKey: { id: 'other-project' }, serverId: 'server-a', machineId: 'other-machine', rootPath: '/other', reachable: true, worktrees: [] },
    { projectKey: { id: 'chosen-project' }, ...selectedDraft.executionTarget, rootPath: '/checkout', reachable: true, worktrees: [] },
];

function mount(serverId = 'server-a', selectTarget?: () => SessionServerStartDraftPresentation<SessionServerStartDraftTarget>) {
    // Presentation is the person/platform boundary. The selector, seed reader,
    // target resolution and strict settlement all use the production owners.
    const present = vi.fn(() => ({ result: Promise.resolve(selectedDraft), close() {} }));
    const selectPlacement = vi.fn((offered: readonly PluginUiSessionPlacementCandidateV1[]) => ({
        result: Promise.resolve(offered[1] ?? null), close() {},
    }));
    const select = createPluginActionInputSelector({
        host: { serverId, targetPluginId: 'acme.caller', accountLifetime },
        isCurrent: () => true,
        composeSessionServerStartDraft: params => composeSessionServerStartDraft({ ...params, present, selectPlacement, selectTarget }),
    });
    return { select, present, selectPlacement };
}

describe('Account-scoped Session draft selection', () => {
    it.each([
        ['resolved placement', { executionTarget: selectedDraft.executionTarget, directory: '/checkout', checkoutIntent: 'reuseWorkspace' }],
        ['existing recipe', { existingDraft: selectedDraft }],
    ] as const)('composes the %s target without requiring a mounted Machine', async (_label, seed) => {
        const mounted = mount();
        const draft = PluginUiJsonObjectV1Schema.parse({ ...seed, candidates });

        await expect(mounted.select({ hostAction, draft }))
            .resolves.toEqual({ kind: 'serverStartDraft', draft: selectedDraft });
        expect(mounted.present).toHaveBeenCalledWith(expect.objectContaining({ target: selectedDraft.executionTarget }));
        expect(mounted.selectPlacement).not.toHaveBeenCalled();
    });

    it('asks for an initial saved project when an Account seed only offers candidates', async () => {
        const mounted = mount();

        await expect(mounted.select({ hostAction, draft: PluginUiJsonObjectV1Schema.parse({ candidates, checkoutIntent: 'ask' }) }))
            .resolves.toEqual({ kind: 'serverStartDraft', draft: selectedDraft });
        expect(mounted.selectPlacement).toHaveBeenCalledWith(candidates);
        expect(mounted.present).toHaveBeenCalledWith({
            target: selectedDraft.executionTarget,
            seed: { candidates, checkoutIntent: 'ask', directory: '/checkout' },
        });
    });

    it('asks the person for a Machine when the actual bulk seed only carries checkout intent', async () => {
        const selectTarget = vi.fn(() => ({ result: Promise.resolve(selectedDraft.executionTarget), close() {} }));
        const mounted = mount('server-a', selectTarget);

        await expect(mounted.select({ hostAction, draft: { checkoutIntent: 'none' } }))
            .resolves.toEqual({ kind: 'serverStartDraft', draft: selectedDraft });
        expect(selectTarget).toHaveBeenCalledOnce();
        expect(mounted.selectPlacement).not.toHaveBeenCalled();
        expect(mounted.present).toHaveBeenCalledWith({ target: selectedDraft.executionTarget, seed: { checkoutIntent: 'none' } });
    });

    it('does not open the recipe when the person dismisses the Machine picker', async () => {
        const mounted = mount('server-a', () => ({ result: Promise.resolve(null), close() {} }));

        await expect(mounted.select({ hostAction, draft: { checkoutIntent: 'none' } }))
            .resolves.toEqual({ kind: 'cancelled' });
        expect(mounted.present).not.toHaveBeenCalled();
    });

    it('does not open a draft when the person dismisses the initial placement picker', async () => {
        const mounted = mount();
        mounted.selectPlacement.mockReturnValueOnce({ result: Promise.resolve(null), close() {} });

        await expect(mounted.select({ hostAction, draft: PluginUiJsonObjectV1Schema.parse({ candidates }) }))
            .resolves.toEqual({ kind: 'cancelled' });
        expect(mounted.present).not.toHaveBeenCalled();
    });

    it('closes an initial placement picker when selection is aborted', async () => {
        const mounted = mount();
        const controller = new AbortController();
        let resolve!: (value: PluginUiSessionPlacementCandidateV1 | null) => void;
        const result = new Promise<PluginUiSessionPlacementCandidateV1 | null>(settle => { resolve = settle; });
        const close = vi.fn(() => resolve(null));
        mounted.selectPlacement.mockReturnValueOnce({ result, close });

        const selection = mounted.select({ hostAction, draft: PluginUiJsonObjectV1Schema.parse({ candidates }) }, { signal: controller.signal });
        controller.abort();

        await expect(selection).resolves.toEqual({ code: 'unavailable', diagnostics: ['select_action_input_aborted'] });
        expect(close).toHaveBeenCalledOnce();
        expect(mounted.present).not.toHaveBeenCalled();
    });

    it('keeps seed validation in the Session composer for Account surfaces', async () => {
        const mounted = mount();

        await expect(mounted.select({ hostAction, draft: { executionTarget: { machineId: 'destination-machine' } } }))
            .resolves.toEqual({ code: 'invalid_payload', diagnostics: ['draft_invalid'] });
        expect(mounted.present).not.toHaveBeenCalled();
    });

    it('refuses an Account request when no target or Machine picker is available', async () => {
        const mounted = mount();

        await expect(mounted.select({ hostAction }))
            .resolves.toEqual({ code: 'unavailable', diagnostics: ['host_unavailable'] });
        expect(mounted.present).not.toHaveBeenCalled();
    });

    it('retains the captured Account binding when the seed supplies a complete target', async () => {
        const mounted = mount('server-b');
        const draft: PluginUiJsonObjectV1 = { executionTarget: selectedDraft.executionTarget };

        await expect(mounted.select({ hostAction, draft }))
            .resolves.toEqual({ code: 'unavailable', diagnostics: ['host_unavailable'] });
        expect(mounted.present).not.toHaveBeenCalled();
    });
});
