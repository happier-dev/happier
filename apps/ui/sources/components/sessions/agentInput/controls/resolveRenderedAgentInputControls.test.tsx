import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { resolveRenderedAgentInputControls } from './resolveRenderedAgentInputControls';

describe('resolveRenderedAgentInputControls', () => {
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
});
