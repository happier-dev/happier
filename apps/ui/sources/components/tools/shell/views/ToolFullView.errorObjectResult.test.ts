import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { collectHostText, installToolShellCommonModuleMocks, makeToolCall } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ensureSidechainMessagesLoadedMock = vi.fn();

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: ensureSidechainMessagesLoadedMock,
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

installToolShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
            Dimensions: { get: () => ({ width: 800, height: 600, scale: 2, fontScale: 2 }) },
            Platform: { OS: 'ios', select: (value: any) => value?.ios ?? value?.default ?? value?.web ?? null },
            useWindowDimensions: () => ({ width: 800, height: 600 }),
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'toolViewShowDebugByDefault') return false;
                    return null;
                },
            },
        });
    },
});

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {},
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: () => null,
}));

vi.mock('@/components/tools/renderers/system/StructuredResultView', () => ({
    StructuredResultView: () => null,
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

describe('ToolFullView (error message formatting)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders JSON for object-shaped tool errors', async () => {
        let ToolFullView: any;
        try {
            ({ ToolFullView } = await import('./ToolFullView'));
        } catch (e: any) {
            throw new Error(e?.stack ? String(e.stack) : String(e));
        }

        const tool = makeToolCall({
            name: 'UnknownTool',
            state: 'error',
            input: { anything: true },
            result: { error: 'Tool call failed', status: 'failed' },
        });

        const screen = await renderScreen(
            React.createElement(ToolFullView, { tool, sessionId: 's1', metadata: null, messages: [] }),
        );

        const flattened = collectHostText(screen.tree);
        expect(flattened.join('\n')).toContain('"error"');
        expect(flattened.join('\n')).toContain('"status"');
        expect(flattened.join('\n')).toContain('Tool call failed');
    });
});
