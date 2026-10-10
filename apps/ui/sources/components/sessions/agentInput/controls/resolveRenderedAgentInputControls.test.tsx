import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { resolveRenderedAgentInputControls } from './resolveRenderedAgentInputControls';

describe('resolveRenderedAgentInputControls', () => {
    it('keeps document controls in one wrapping row without hiding controls outside the collapsed bar', () => {
        const node = (key: string) => <React.Fragment key={key}>{key}</React.Fragment>;
        const controls = resolveRenderedAgentInputControls({
            layout: 'wrap', singleRow: true,
            coreControlNodesById: { machine: [node('machine')] },
            extraControlNodesById: { workflow: [node('workflow')], workflowInputs: [node('inputs')], workflowRoles: [node('roles')] },
            extraChips: [node('unregistered')], barControlIds: ['workflow'],
        });
        expect(controls.chips.map((chip) => (chip as React.ReactElement).key)).toEqual(['workflow', 'inputs', 'roles', 'machine', 'unregistered']);
        expect(controls.secondaryLeadingControls).toEqual([]);
    });
    it('renders admitted plugin controls at the one plugin insertion point and keeps them in collapsed overflow', () => {
        const pluginControl = <React.Fragment key="plugin-control">Plugin control</React.Fragment>;
        const coreControl = <React.Fragment key="engine-control">Engine control</React.Fragment>;

        const expanded = resolveRenderedAgentInputControls({
            layout: 'wrap',
            coreControlNodesById: { engine: [coreControl] },
            extraControlNodesById: { 'plugin:acme.compose/attach': [pluginControl] },
            extraChips: [],
        });
        expect(expanded.chips).toEqual([coreControl, pluginControl]);

        const collapsed = resolveRenderedAgentInputControls({
            layout: 'collapsed',
            coreControlNodesById: { engine: [coreControl] },
            extraControlNodesById: { 'plugin:acme.compose/attach': [pluginControl] },
            extraChips: [],
        });
        expect(collapsed.chips).toEqual([coreControl, pluginControl]);
    });

    it('shows only the host\'s bar controls, in the host\'s order, when collapsed', () => {
        const node = (key: string) => <React.Fragment key={key}>{key}</React.Fragment>;
        const nodes = { engine: [node('engine')], permission: [node('permission')], actionMenu: [node('actionMenu')], machine: [node('machine')], path: [node('path')], resume: [node('resume')] };
        const collapsed = resolveRenderedAgentInputControls({
            layout: 'collapsed',
            coreControlNodesById: nodes,
            extraControlNodesById: { mcp: [node('mcp')], automation: [node('automation')] },
            extraChips: [],
            barControlIds: ['machine', 'path', 'engine', 'permission', 'actionMenu'],
        });
        expect(collapsed.chips.map((chip) => (chip as React.ReactElement).key)).toEqual(['machine', 'path', 'engine', 'permission', 'actionMenu']);

        // Other layouts are unchanged by the host's bar set.
        const wrap = resolveRenderedAgentInputControls({
            layout: 'wrap',
            coreControlNodesById: nodes,
            extraControlNodesById: { mcp: [node('mcp')] },
            extraChips: [],
            barControlIds: ['machine'],
        });
        expect(wrap.chips.map((chip) => (chip as React.ReactElement).key)).toContain('mcp');
    });
});
