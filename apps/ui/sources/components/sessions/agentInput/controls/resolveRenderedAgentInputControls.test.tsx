import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { resolveRenderedAgentInputControls } from './resolveRenderedAgentInputControls';
import type { AgentInputResolvedControlLines } from './agentInputControlTypes';
import { resolveRenderedExtraActionChipNodes } from './resolveRenderedExtraActionChipNodes';
import type { AgentInputExtraActionChipRenderContext } from '../agentInputContracts';

const resolved = (primary: readonly string[], secondary: readonly string[] = [], collapsed: readonly string[] = []): AgentInputResolvedControlLines => ({
    primary, secondary, collapsed, accessories: [], hidden: [], controls: [], effectivePlacements: {},
});
const node = (key: string) => <React.Fragment key={key}>{key}</React.Fragment>;
const keys = (nodes: readonly React.ReactNode[]) => nodes.map((chip) => (chip as React.ReactElement).key);

describe('resolveRenderedAgentInputControls', () => {
    it('does not construct hidden or overflow chip nodes and keeps individual siblings distinct', () => {
        const render = vi.fn(() => null);
        const context = {
            chipStyle: () => ({}), showLabel: true, iconColor: 'currentColor', textStyle: {}, countTextStyle: {},
            popoverAnchorRef: React.createRef(),
        } satisfies AgentInputExtraActionChipRenderContext;
        const nodes = resolveRenderedExtraActionChipNodes({
            placementIds: ['providerOption:second'],
            chips: ['first', 'second', 'hidden'].map((key) => ({
                key, controlId: 'providerOption', placement: { id: `providerOption:${key}`, title: key }, render,
            })),
            renderContext: context, autoHideRenderContext: context,
        });
        expect(render).toHaveBeenCalledOnce();
        expect(Object.keys(nodes.extraControlNodesById)).toEqual(['providerOption:second']);
        expect(Object.keys(nodes.extraChipAnchorRefsByKey)).toEqual(['second']);
    });

    it('uses supplied individual membership and ordering, with fixed menu and stop outside placement', () => {
        const controls = resolveRenderedAgentInputControls({
            resolvedControls: resolved(['providerOption:second', 'permission', 'providerOption:first'], ['resume', 'path'], ['machine']),
            coreControlNodesById: {
                engine: [node('engine')], permission: [node('permission')], actionMenu: [node('actionMenu')],
                machine: [node('machine')], path: [node('path')], resume: [node('resume')], stop: [node('stop')],
            },
            extraControlNodesById: { 'providerOption:first': [node('first')], 'providerOption:second': [node('second')] },
        });
        expect(keys(controls.chips)).toEqual(['actionMenu', 'second', 'permission', 'first', 'stop']);
        expect(keys(controls.secondaryLeadingControls)).toEqual(['resume', 'path']);
        expect(controls.secondaryTrailingControls).toEqual([]);
        expect(controls.hasPermissionControl).toBe(true);
    });

    it('has no row copy of overflow resume or hidden controls and reports overflow permission accurately', () => {
        const controls = resolveRenderedAgentInputControls({
            resolvedControls: resolved(['engine'], [], ['resume', 'permission']),
            coreControlNodesById: { engine: [node('engine')], permission: [node('permission')], path: [node('path')], resume: [node('resume')] },
            extraControlNodesById: { 'plugin:action:acme/run': [node('plugin')] },
        });
        expect(keys(controls.chips)).toEqual(['engine']);
        expect(controls.secondaryLeadingControls).toEqual([]);
        expect(controls.secondaryTrailingControls).toEqual([]);
        expect(controls.hasPermissionControl).toBe(false);
    });
});
