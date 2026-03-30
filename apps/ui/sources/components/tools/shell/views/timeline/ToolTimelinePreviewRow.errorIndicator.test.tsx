import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { collectHostText, renderScreen, standardCleanup } from '@/dev/testkit';
import { installToolShellCommonModuleMocks } from '../ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installToolShellCommonModuleMocks();

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {},
}));

vi.mock('@/components/tools/renderers/system/MCPToolView', () => ({
    formatMCPTitle: (name: string) => name,
    formatMCPSubtitle: () => null,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

function makeToolMessage(overrides: Partial<any> = {}) {
    const now = Date.now();
    return {
        kind: 'tool-call',
        id: 'tool-1',
        localId: null,
        createdAt: now,
        tool: {
            name: 'grep',
            state: 'completed',
            input: {},
            createdAt: now,
            startedAt: now,
            completedAt: now + 1,
            description: null,
            result: {},
            ...overrides,
        },
        children: [],
    };
}

describe('ToolTimelinePreviewRow (error indicator)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('shows an inline error badge when tool_use_result contains an Error: prefix', async () => {
        const { ToolTimelinePreviewRow } = await import('./ToolTimelinePreviewRow');
        const message = makeToolMessage({
            result: {
                tool_use_result: 'Error: Ripgrep search timed out after 20 seconds.\nTry searching a more specific path.',
            },
        });

        const screen = await renderScreen(<ToolTimelinePreviewRow toolMessage={message as any} metadata={null} />);
        expect(collectHostText(screen.tree)).toContain('Ripgrep search timed out after 20 seconds.');
    });

    it('does not show the inline error badge for successful completed tools', async () => {
        const { ToolTimelinePreviewRow } = await import('./ToolTimelinePreviewRow');
        const message = makeToolMessage({
            result: {
                tool_use_result: 'OK',
            },
        });

        const screen = await renderScreen(<ToolTimelinePreviewRow toolMessage={message as any} metadata={null} />);
        expect(collectHostText(screen.tree)).not.toContain('Ripgrep search timed out');
    });
});
