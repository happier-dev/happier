import { renderWithSessionTranscriptSource } from '@/dev/testkit';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flattenTestStyle, standardCleanup } from '@/dev/testkit';
import { resolveGlassPaint } from '@/dev/testkit/glass/resolveGlassPaint';

import { installToolShellCommonModuleMocks, makeToolCall } from './ToolView.testHelpers';
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installToolShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web', select: (value: any) => value?.web ?? value?.default ?? null },
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: createUseSettingMock({ fallback: (key) => {
                    if (key === 'toolViewDetailLevelDefault') return 'summary';
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

const { ToolView } = await import('./ToolView');
const { resolveGlassPresentationVariables } = await import('@/components/ui/glass/glassDocumentPresentation');
const { useUnistyles } = await import('react-native-unistyles');

// A Picture behind Sessions clears the content plane (`--happier-glass-content-nested-plane-opacity: 0%`).
const glassOn = resolveGlassPresentationVariables({ glassBlurEnabled: true, glassSurfaceMaterials: null, glassBlurIntensity: 'regular' }, { atmosphereBehind: 'wallpaper' });
const glassOff = resolveGlassPresentationVariables({ glassBlurEnabled: false }, {});

async function renderCardFill(embedded: boolean): Promise<string> {
    const tool = makeToolCall({ name: 'edit', state: 'running', input: {}, description: null, result: null });
    const screen = await renderWithSessionTranscriptSource(React.createElement(ToolView, { tool, metadata: null, messages: [], embedded }));
    return String(flattenTestStyle((screen.findByTestId('tool-view-container') as any)?.props.style).backgroundColor);
}

describe('ToolView card material', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('is working content over glass: a translucent fill instead of an opaque slab, its own fill when solid', async () => {
        const { theme } = useUnistyles();
        const fill = await renderCardFill(false);
        expect(resolveGlassPaint(fill, glassOn)).toBe(theme.colors.surface.selected);
        expect(resolveGlassPaint(fill, glassOff)).toBe(theme.colors.surface.inset);
    });

    it('clears over glass inside a tool-calls group card, so the group tint is not stacked', async () => {
        const { theme } = useUnistyles();
        const fill = await renderCardFill(true);
        expect(resolveGlassPaint(fill, glassOn)).toBe('transparent');
        expect(resolveGlassPaint(fill, glassOff)).toBe(theme.colors.surface.inset);
    });
});
