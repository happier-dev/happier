import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { collectHostText, renderScreen, standardCleanup } from '@/dev/testkit';
import { installToolShellCommonModuleMocks } from '../ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installToolShellCommonModuleMocks();

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {},
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

// Load the real owner after boundary setup so cold module evaluation is outside a test and its act lifetime.
const { ToolTimelinePreviewRow } = await import('./ToolTimelinePreviewRow');

describe('ToolTimelinePreviewRow (error indicator)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('shows an inline error badge when tool_use_result contains an Error: prefix', async () => {
        const message = makeToolMessage({
            result: {
                tool_use_result: 'Error: Ripgrep search timed out after 20 seconds.\nTry searching a more specific path.',
            },
        });

        const screen = await renderScreen(<ToolTimelinePreviewRow toolMessage={message as any} metadata={null} />);
        expect(collectHostText(screen.tree)).toContain('Ripgrep search timed out after 20 seconds.');
        const errorStatus = screen.findByTestId('tool-timeline-preview-row-error');
        expect(errorStatus?.props.accessible).toBe(true);
        expect(errorStatus?.props.accessibilityLabel).toBe('Ripgrep search timed out after 20 seconds.');
    });

    it('does not show the inline error badge for successful completed tools', async () => {
        const message = makeToolMessage({
            result: {
                tool_use_result: 'OK',
            },
        });

        const screen = await renderScreen(<ToolTimelinePreviewRow toolMessage={message as any} metadata={null} />);
        expect(collectHostText(screen.tree)).not.toContain('Ripgrep search timed out');
    });

    it.each(['denied', 'canceled'] as const)('presents a person’s Shell %s decision quietly in the collapsed preview', async (status) => {
        const { createToolCallMessageFixture } = await import('@/dev/testkit/fixtures/transcriptFixtures');
        const base = createToolCallMessageFixture();
        const message = createToolCallMessageFixture({ tool: { ...base.tool, name: 'Bash', state: 'error', result: null,
            permission: { id: 'shell-permission', status, decision: status === 'denied' ? 'denied' : 'abort',
                ...(status === 'denied' ? { decisionActor: { kind: 'accountUser', accountId: 'owner', relationship: 'owner' } } : {}) },
        } });
        const screen = await renderScreen(<ToolTimelinePreviewRow toolMessage={message} metadata={null} />);
        expect(screen.findByTestId('tool-timeline-preview-row-permission-blocked')?.props.accessibilityLabel)
            .toBe(`approvals.status.${status === 'denied' ? 'rejected' : 'canceled'}`);
        const outcome = screen.tree.root.findAll(node => node.props.testID === 'tool-timeline-preview-row-permission-blocked'
            && typeof node.props.tone === 'string')[0];
        expect(outcome?.props.tone).toBe('quiet');
    });

    it('shows a visible and accessible denied status in collapsed previews', async () => {
        const message = makeToolMessage({
            state: 'error',
            result: null,
            permission: { id: 'permission-1', kind: 'filesystem', status: 'denied' },
        });

        const screen = await renderScreen(<ToolTimelinePreviewRow toolMessage={message as any} metadata={null} />);

        expect(collectHostText(screen.tree)).toContain('errors.permissionDenied');
        expect(screen.findByTestId('tool-timeline-preview-row-permission-blocked')).toMatchObject({
            props: {
                accessible: true,
                accessibilityLabel: 'errors.permissionDenied',
            },
        });
    });
});
