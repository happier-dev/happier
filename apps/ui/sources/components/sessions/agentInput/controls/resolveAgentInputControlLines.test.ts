import { describe, expect, it, vi } from 'vitest';

import { resolveAgentInputControlLines } from './resolveAgentInputControlLines';
import { buildAgentInputPlacementDescriptors } from './buildAgentInputPlacementDescriptors';
import { isAgentInputPluginControlId, type AgentInputControlId, type AgentInputHostControlId, type AgentInputPlacementDescriptor } from './agentInputControlTypes';
import type { AgentInputExtraActionChip } from '../agentInputContracts';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

describe('composer placement projection', () => {
    const controls: readonly AgentInputPlacementDescriptor[] = [
        { id: 'engine', controlId: 'engine', title: 'Model', line: 'primary', slot: 'chip', defaultPlacement: 'pinned', pending: false },
        { id: 'permission', controlId: 'permission', title: 'Permissions', line: 'primary', slot: 'chip', defaultPlacement: 'pinned', allowedPlacements: ['pinned', 'overflow'], pending: false },
        { id: 'delivery:first', controlId: 'delivery', title: 'Delivery', line: 'primary', slot: 'chip', defaultPlacement: 'overflow', pending: false },
        { id: 'delivery:second', controlId: 'delivery', title: 'Delivery', line: 'primary', slot: 'chip', defaultPlacement: 'overflow', pending: true },
        { id: 'path', controlId: 'path', title: 'Folder', line: 'secondary', slot: 'chip', defaultPlacement: 'pinned', pending: false },
        { id: 'resume', controlId: 'resume', title: 'Resume', line: 'secondary', slot: 'chip', defaultPlacement: 'overflow', pending: false },
        { id: 'promptLibrary', controlId: 'shortcuts', title: 'Prompts', line: 'primary', slot: 'fieldAccessory', defaultPlacement: 'pinned', pending: false },
    ];
    it('resolves individual order and pending membership for every physical slot', () => {
        const preferences = { orderedIds: ['removed', 'resume', 'delivery:second', 'path'], placements: {
            'delivery:first': 'hidden' as const, 'delivery:second': 'hidden' as const,
            permission: 'hidden' as const, promptLibrary: 'overflow' as const,
        } };
        const lines = resolveAgentInputControlLines({ controls, preferences, layout: 'wrap' });
        expect(lines.primary).toEqual(['delivery:second', 'engine', 'permission']);
        expect(lines.secondary).toEqual(['path']);
        expect(lines.collapsed).toEqual(['resume', 'promptLibrary']);
        expect(lines.hidden).toEqual(['delivery:first']);
        expect(lines.accessories).toEqual([]);
        expect(lines.effectivePlacements.permission).toBe('pinned');
        expect(resolveAgentInputControlLines({ controls: controls.map(c => ({ ...c, pending: false })), preferences }).hidden)
            .toEqual(['delivery:second', 'delivery:first']);
        expect(preferences.placements['delivery:second']).toBe('hidden');
    });
    it('keeps wrap and scroll membership identical and combines only pinned session rails', () => {
        const wrap = resolveAgentInputControlLines({ controls, layout: 'wrap' });
        const scroll = resolveAgentInputControlLines({ controls, layout: 'scroll' });
        expect(scroll.primary).toEqual(wrap.primary);
        expect(scroll.collapsed).toEqual(wrap.collapsed);
        expect(wrap.accessories).toEqual(['promptLibrary']);
        expect(resolveAgentInputControlLines({ controls, singleRow: true }).secondary).toEqual([]);
        expect(resolveAgentInputControlLines({ controls, singleRow: true }).primary).toContain('path');
    });
});

/** Exercise physical rail order with explicit placement through the real owners. */
function resolveFixtureLines(params: Readonly<{
    controlIds: readonly AgentInputControlId[];
    layout?: 'wrap' | 'scroll';
    placement?: 'pinned' | 'overflow';
}>) {
    const coreControls: { id: AgentInputHostControlId; title: string }[] = [];
    const chips: AgentInputExtraActionChip[] = [];
    for (const controlId of params.controlIds) {
        if (isAgentInputPluginControlId(controlId) || controlId === 'reviewComments' || controlId === 'shortcuts') {
            const id = isAgentInputPluginControlId(controlId) ? controlId : `${controlId}:fixture`;
            chips.push({ key: id, controlId, placement: { id, title: id }, render: () => null });
        } else {
            coreControls.push({ id: controlId, title: controlId });
        }
    }
    const controls = buildAgentInputPlacementDescriptors({ coreControls, chips });
    return resolveAgentInputControlLines({
        layout: params.layout ?? 'wrap',
        controls,
        preferences: { orderedIds: [], placements: Object.fromEntries(controls.map(control => [control.id, params.placement ?? 'pinned'] as const)) },
    });
}

describe('resolveAgentInputControlLines', () => {
    it('reads rail 1 as setup and rail 2 as location (owner 2026-10-12)', () => {
        const lines = resolveFixtureLines({
            layout: 'scroll',
            controlIds: ['workflow', 'capabilities', 'checkout', 'automation', 'env', 'profile', 'connectedServices', 'mode',
                'permission', 'engine', 'files', 'attachments', 'resume', 'path', 'machine', 'organization', 'tags', 'sessionAccess'],
        });

        expect(lines.primary).toEqual(['attachments', 'engine', 'permission', 'mode', 'connectedServices',
            'profile', 'env', 'workflow', 'capabilities', 'sessionAccess', 'tags']);
        expect(lines.secondary).toEqual(['machine', 'path', 'resume', 'checkout', 'organization', 'automation']);
        expect(lines.collapsed).toEqual(['files']);
    });

    it('preserves Session access independently from recipient routing in the pinned composer and explicit overflow', () => {
        const controlIds = ['recipient', 'sessionAccess'] as const;
        expect(resolveFixtureLines({ layout: 'wrap', controlIds }).primary)
            .toEqual(['sessionAccess', 'recipient']);
        expect(resolveFixtureLines({ placement: 'overflow', controlIds }).collapsed)
            .toEqual(['sessionAccess', 'recipient']);
    });
    it('keeps primary and secondary controls on separate lines in wrap layout', () => {
        const lines = resolveFixtureLines({
            layout: 'wrap',
            controlIds: ['engine', 'permission', 'stop', 'files', 'reviewComments', 'machine', 'path', 'resume'],
        });

        expect(lines.primary).toEqual(['engine', 'permission', 'reviewComments:fixture']);
        expect(lines.secondary).toEqual(['machine', 'path', 'resume']);
        expect(lines.collapsed).toEqual(['files']);
    });

    it('keeps primary and secondary controls on separate lines in scroll layout', () => {
        const lines = resolveFixtureLines({
            layout: 'scroll',
            controlIds: ['engine', 'permission', 'stop', 'files', 'reviewComments', 'machine', 'path', 'resume'],
        });

        expect(lines.primary).toEqual(['engine', 'permission', 'reviewComments:fixture']);
        expect(lines.secondary).toEqual(['machine', 'path', 'resume']);
        expect(lines.collapsed).toEqual(['files']);
    });

    it('places an explicitly overflowed inventory in the action menu', () => {
        const lines = resolveFixtureLines({
            placement: 'overflow',
            controlIds: ['engine', 'permission', 'stop', 'files', 'reviewComments', 'machine', 'path', 'resume'],
        });

        expect(lines.primary).toEqual([]);
        expect(lines.secondary).toEqual([]);
        expect(lines.collapsed).toEqual(['files', 'engine', 'permission', 'reviewComments:fixture', 'machine', 'path', 'resume']);
    });

    it('keeps connected services on the primary line ahead of secondary machine/path controls', () => {
        const lines = resolveFixtureLines({
            layout: 'wrap',
            controlIds: ['engine', 'connectedServices', 'machine', 'path'],
        });

        expect(lines.primary).toEqual(['engine', 'connectedServices']);
        expect(lines.secondary).toEqual(['machine', 'path']);
    });

    it('keeps storage on the primary line ahead of secondary machine/path controls', () => {
        const lines = resolveFixtureLines({
            layout: 'wrap',
            controlIds: ['engine', 'storage', 'machine', 'path'],
        });

        expect(lines.primary).toEqual(['engine', 'storage']);
        expect(lines.secondary).toEqual(['machine', 'path']);
    });

    it('keeps linked files on the primary line ahead of secondary machine/path controls', () => {
        const lines = resolveFixtureLines({
            layout: 'wrap',
            controlIds: ['engine', 'linkedFiles', 'machine', 'path'],
        });

        expect(lines.primary).toEqual(['linkedFiles', 'engine']);
        expect(lines.secondary).toEqual(['machine', 'path']);
    });

    it('keeps shortcuts on the primary line ahead of secondary machine/path controls', () => {
        const lines = resolveFixtureLines({
            layout: 'wrap',
            controlIds: ['engine', 'shortcuts', 'machine', 'path'],
        });

        expect(lines.primary).toEqual(['engine', 'shortcuts:fixture']);
        expect(lines.secondary).toEqual(['machine', 'path']);
    });

    it('keeps capabilities on the primary line ahead of secondary machine/path controls', () => {
        const lines = resolveFixtureLines({
            layout: 'wrap',
            controlIds: ['engine', 'capabilities', 'machine', 'path'],
        });

        expect(lines.primary).toEqual(['engine', 'capabilities']);
        expect(lines.secondary).toEqual(['machine', 'path']);
    });

    it('puts automation on the location rail after machine and folder', () => {
        const lines = resolveFixtureLines({
            layout: 'wrap',
            controlIds: ['engine', 'automation', 'machine', 'path'],
        });

        expect(lines.primary).toEqual(['engine']);
        expect(lines.secondary).toEqual(['machine', 'path', 'automation']);
    });

    it('keeps admitted plugin controls in supplied normalized contribution order after host controls', () => {
        const lines = resolveFixtureLines({
            layout: 'wrap',
            controlIds: ['plugin:control:fixture/second', 'engine', 'plugin:control:fixture/first', 'machine'],
        });

        expect(lines.primary).toEqual([
            'engine',
            'plugin:control:fixture/second',
            'plugin:control:fixture/first',
        ]);
        expect(lines.secondary).toEqual(['machine']);
        expect(lines.collapsed).toEqual([]);
    });

    it('keeps admitted plugin controls in the same canonical order with explicit overflow placement', () => {
        const lines = resolveFixtureLines({
            placement: 'overflow',
            controlIds: ['plugin:control:fixture/second', 'engine', 'plugin:control:fixture/first', 'machine'],
        });

        expect(lines.primary).toEqual([]);
        expect(lines.secondary).toEqual([]);
        expect(lines.collapsed).toEqual([
            'engine',
            'machine',
            'plugin:control:fixture/second',
            'plugin:control:fixture/first',
        ]);
    });

    it('leaves stop and + outside placement while preserving workflow group order', () => {
        const lines = resolveFixtureLines({ placement: 'overflow', controlIds: [
            'path', 'workflowTargets', 'sessionAccess', 'stop', 'actionMenu', 'workflowInputs', 'machine', 'automation', 'workflowRoles', 'workflow',
        ] });
        expect(lines.collapsed).toEqual([
            'workflow', 'workflowInputs', 'workflowRoles', 'workflowTargets', 'sessionAccess', 'machine', 'path', 'automation',
        ]);
        expect(lines.controls.map(control => control.id)).not.toContain('stop');
        expect(lines.controls.map(control => control.id)).not.toContain('actionMenu');
    });
});
