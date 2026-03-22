import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { collectHostText, makeToolCall } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: vi.fn(),
    },
}));

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: [],
    DEFAULT_AGENT_ID: 'claude',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        Read: { title: 'Read' },
        edit: {
            title: 'Edit',
            extractSubtitle: () => 'file.ts',
        },
    },
}));

const renderedToolViewSpy = vi.fn();

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => (props: any) => {
        renderedToolViewSpy(props);
        return React.createElement('SpecificToolView', null);
    },
}));

const renderedStructuredSpy = vi.fn();
vi.mock('@/components/tools/renderers/system/StructuredResultView', () => ({
    StructuredResultView: (props: any) => {
        renderedStructuredSpy(props);
        return React.createElement('StructuredResultView', null);
    },
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

// Force the default tool detail level to "title" so the body is hidden.
vi.mock('@/sync/domains/state/storage', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
        importOriginal,
        overrides: {
            useSetting: (key: string) => {
                if (key === 'toolViewDetailLevelDefault') return 'title';
                if (key === 'toolViewDetailLevelDefaultLocalControl') return 'title';
                if (key === 'toolViewDetailLevelByToolName') return {};
                return null;
            },
        },
    }));

vi.mock('@/utils/errors/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

vi.mock('@/components/tools/renderers/system/MCPToolView', () => ({
    formatMCPTitle: (t: string) => t,
    formatMCPSubtitle: () => '',
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: () => null,
}));

vi.mock('../presentation/ToolSectionView', () => ({
    ToolSectionView: () => null,
}));

vi.mock('@/hooks/ui/useElapsedTime', () => ({
    useElapsedTime: () => 0,
}));

describe('ToolView (detail level: title)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('hides the tool body even when a tool renderer exists', async () => {
        renderedToolViewSpy.mockReset();
        renderedStructuredSpy.mockReset();

        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'edit',
            input: { file_path: '/tmp/a.txt' },
            result: { file: { content: 'hello' } },
        });

        const screen = await renderScreen(React.createElement(ToolView, { tool, metadata: null }));

        // Header still renders (baseline sanity).
        expect(collectHostText(screen.tree).length).toBeGreaterThan(0);

        // Title-only should not render subtitles/status text (only title + icon chrome).
        expect(screen.findAllByTestId('tool-card-subtitle')).toHaveLength(0);

        // Body renderers should not run at title-level.
        expect(renderedToolViewSpy).not.toHaveBeenCalled();
        expect(renderedStructuredSpy).not.toHaveBeenCalled();
        expect(screen.findAllByType('SpecificToolView' as any)).toHaveLength(0);
        expect(screen.findAllByType('StructuredResultView' as any)).toHaveLength(0);
    });
});
