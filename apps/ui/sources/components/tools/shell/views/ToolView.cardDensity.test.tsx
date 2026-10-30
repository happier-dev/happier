import { renderWithSessionTranscriptSource } from '@/dev/testkit';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    standardCleanup,
} from '@/dev/testkit';

import { installToolShellCommonModuleMocks, makeToolCall } from './ToolView.testHelpers';
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const toolViewDetailLevelDefaultSetting = vi.hoisted(() => ({
    value: 'summary' as 'summary' | 'compact',
}));

installToolShellCommonModuleMocks({
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        // A distinctive part radius proves the component reads the theme's part token, not a constant.
        return createUnistylesMock({ theme: { parts: { toolCard: { radius: 37 } } } });
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios', select: (value: any) => value?.ios ?? value?.default ?? value?.web ?? null },
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: createUseSettingMock({ fallback: (key) => {
                    if (key === 'toolViewDetailLevelDefault') return toolViewDetailLevelDefaultSetting.value;
                    if (key === 'toolViewDetailLevelDefaultLocalControl') return 'title';
                    if (key === 'toolViewDetailLevelByToolName') return {};
                    if (key === 'toolViewShowDebugByDefault') return false;
                    if (key === 'toolViewTapAction') return 'expand';
                    if (key === 'toolViewExpandedDetailLevelDefault') return 'summary';
                    if (key === 'toolViewExpandedDetailLevelByToolName') return {};
                    if (key === 'permissionPromptSurface') return 'transcript';
                    return null;
                } }),
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key) => key,
        });
    },
});

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        edit: {
            title: 'Edit',
            extractSubtitle: () => 'file.ts',
        },
    },
}));

vi.mock('@/components/tools/renderers/system/MCPToolView', () => ({
    formatMCPTitle: () => 'MCP',
    formatMCPSubtitle: () => '',
}));

vi.mock('@/utils/errors/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: () => null,
}));

vi.mock('../presentation/ToolSectionView', async (importOriginal) => {
    const { installToolSectionViewModuleMock } = await import('@/dev/testkit/mocks/toolSectionView');
    return installToolSectionViewModuleMock('fragment')(importOriginal);
});

vi.mock('../presentation/ToolError', () => ({
    ToolError: () => null,
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => React.createElement('PermissionFooter', null),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptCollapsible', () => ({
    TranscriptCollapsible: ({ expanded, children }: any) =>
        expanded ? React.createElement(React.Fragment, null, children) : null,
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['claude', 'codex', 'gemini', 'opencode'],
    DEFAULT_AGENT_ID: 'claude',
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
    resolveAgentIdFromFlavor: () => null,
}));

// Load the real owner after boundary setup so cold module evaluation is outside a test and its act lifetime.
const { ToolView } = await import('./ToolView');

describe('ToolView (card density)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders a separate subtitle line in comfortable density', async () => {
        toolViewDetailLevelDefaultSetting.value = 'summary';
        const tool = makeToolCall({ name: 'edit', state: 'running', input: {}, description: null, result: null });

        const screen = await renderWithSessionTranscriptSource(React.createElement(ToolView, { tool, metadata: null, messages: [] }));

        expect(screen.findAllByTestId('tool-card-subtitle').length).toBeGreaterThan(0);
    });

    it('rounds the card with the theme tool card radius', async () => {
        toolViewDetailLevelDefaultSetting.value = 'summary';
        const tool = makeToolCall({ name: 'edit', state: 'running', input: {}, description: null, result: null });

        const screen = await renderWithSessionTranscriptSource(React.createElement(ToolView, { tool, metadata: null, messages: [] }));

        expect(findStyledNodes(screen.tree.root, 'borderRadius', 37).length).toBeGreaterThan(0);
    });
});

function findStyledNodes(root: { findAll: (predicate: (node: any) => boolean) => any[] }, key: string, value: unknown) {
    const flatten = (style: unknown): Record<string, unknown> => {
        if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
        return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
    };
    return root.findAll((node) => typeof node.type === 'string' && flatten(node.props?.style)[key] === value);
}
