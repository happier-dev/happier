import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { collectHostText, makeToolCall } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    ScrollView: 'ScrollView',
    Dimensions: { get: () => ({ width: 800, height: 600, scale: 2, fontScale: 2 }) },
    Platform: { OS: 'ios', select: (v: any) => v.ios },
    useWindowDimensions: () => ({ width: 800, height: 600 }),
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('./views/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/knownTools', () => ({
    knownTools: {},
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'toolViewShowDebugByDefault') return false;
        return null;
    },
}));

vi.mock('../CodeView', () => ({
    CodeView: () => null,
}));

vi.mock('@/components/CodeView', () => ({
    CodeView: () => null,
}));

vi.mock('./views/StructuredResultView', () => ({
    StructuredResultView: () => null,
}));

vi.mock('./PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

describe('ToolFullView (error message formatting)', () => {
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

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(ToolFullView, { tool, sessionId: 's1', metadata: null, messages: [] }));
        });

        const flattened = collectHostText(tree!);
        expect(flattened.join('\n')).toContain('"error"');
        expect(flattened.join('\n')).toContain('"status"');
        expect(flattened.join('\n')).toContain('Tool call failed');
    });
});
