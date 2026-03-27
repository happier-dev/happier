import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installToolShellCommonModuleMocks, makeToolCall } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installToolShellCommonModuleMocks({
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'toolViewDetailLevelDefault') return 'summary';
                    if (key === 'toolViewDetailLevelDefaultLocalControl') return 'summary';
                    if (key === 'toolViewDetailLevelByToolName') return {};
                    if (key === 'toolViewExpandedDetailLevelDefault') return 'summary';
                    if (key === 'toolViewExpandedDetailLevelByToolName') return {};
                    if (key === 'toolViewTapAction') return 'expand';
                    if (key === 'permissionPromptSurface') return 'transcript';
                    return null;
                },
            },
        }),
    text: async () =>
        (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
            translate: (key) => key,
        }),
    unistyles: async () =>
        (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
            theme: {
                colors: {
                    text: '#000',
                    textSecondary: '#666',
                    warning: '#f90',
                    surfaceHigh: '#eee',
                    surfaceHighest: '#eee',
                },
            },
        }),
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: [],
    DEFAULT_AGENT_ID: 'claude',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {},
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: vi.fn(),
    },
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/utils/errors/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

describe('ToolView (secondary action touch target)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders a secondary action button with a stable touch target style', async () => {
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            id: 't1',
            name: 'mcp__playwright__browser_close',
            state: 'completed',
            input: {},
            result: { ok: true },
        });

        const screen = await renderScreen(
            <ToolView tool={tool} metadata={null} messages={[]} sessionId="s1" messageId="m1" />,
        );

        const secondary = screen.findByTestId('tool-view-header-secondary');
        expect(secondary).toBeTruthy();
        if (!secondary) {
            throw new Error('Expected secondary action button to be rendered');
        }
        expect(secondary.props.hitSlop).toBe(15);

        expect(secondary.props.style).toMatchObject({
            width: 34,
            height: 34,
        });
    });
});
