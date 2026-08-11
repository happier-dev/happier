import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ToolCall } from '@/sync/domains/messages/messageTypes';

import { buildToolHeaderModel } from './buildToolHeaderModel';
import { installToolShellPresentationCommonModuleMocks } from './toolShellPresentationTestHelpers';

installToolShellPresentationCommonModuleMocks();

// The renderer registry is a heavy module graph and is not what this test decides; with no specific
// view, `isUnknownTool` and the header icon are driven purely by catalog membership — which is
// exactly the condition that produces the `wrench` fallback.
vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
        ...actual,
        resolveAgentIdFromFlavor: () => null,
        getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
    };
});

function makeTool(overrides: Partial<ToolCall>): ToolCall {
    return {
        name: 'Unknown',
        state: 'completed',
        input: {},
        result: null,
        createdAt: 1,
        startedAt: 1,
        completedAt: 1,
        description: null,
        permission: undefined,
        ...overrides,
    };
}

function buildHeader(tool: ToolCall) {
    return buildToolHeaderModel({
        tool,
        metadata: null,
        iconSize: 18,
        iconColorPrimary: '#111',
        iconColorSecondary: '#555',
    });
}

function iconName(icon: React.ReactNode): unknown {
    return React.isValidElement(icon) ? (icon.props as { name?: unknown }).name : null;
}

describe('buildToolHeaderModel (background task tools)', () => {
    it('gives TaskOutput and TaskStop real glyphs instead of the unknown-tool wrench', () => {
        const taskOutput = buildHeader(makeTool({ name: 'TaskOutput', input: { task_id: 'task_1' } }));
        const taskStop = buildHeader(makeTool({ name: 'TaskStop', input: { task_id: 'task_1' } }));

        expect(taskOutput.isUnknownTool).toBe(false);
        expect(taskStop.isUnknownTool).toBe(false);
        expect(iconName(taskOutput.icon)).toBe('tray');
        expect(iconName(taskStop.icon)).toBe('stop');
        // One meaning per glyph: the two must not share one, and neither may reuse `stop-circle`,
        // which the agent-activity status table owns for `cancelled`.
        expect(iconName(taskOutput.icon)).not.toBe(iconName(taskStop.icon));
        expect(iconName(taskStop.icon)).not.toBe('stop-circle');
    });

    it('still falls back to the wrench for a tool nobody has catalogued', () => {
        const model = buildHeader(makeTool({ name: 'SomeToolWeHaveNeverSeen' }));
        expect(model.isUnknownTool).toBe(true);
        expect(iconName(model.icon)).toBe('wrench');
    });
});
