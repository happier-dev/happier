import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { makeToolCall } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/sessions/transcript/motion/TranscriptCollapsible', () => ({
    TranscriptCollapsible: ({ expanded, children }: any) =>
        expanded ? React.createElement(React.Fragment, null, children) : null,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    ScrollView: 'ScrollView',
    Pressable: 'Pressable',
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
    Dimensions: { get: () => ({ width: 800, height: 600, scale: 2, fontScale: 2 }) },
    Platform: { OS: 'ios', select: (v: any) => v.ios },
    useWindowDimensions: () => ({ width: 800, height: 600 }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: () => false,
    useSetting: (key: string) => {
        if (key === 'permissionPromptSurface') return 'composer';
        return false;
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        edit: { title: 'Edit' },
    },
}));

vi.mock('@/components/tools/renderers/system/StructuredResultView', () => ({
    StructuredResultView: () => null,
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: () => null,
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: (props: any) => React.createElement('PermissionFooter', props),
}));

describe('ToolFullView (permission pending)', () => {
    it('renders PermissionFooter so users can approve/deny from the full view', async () => {
        const { ToolFullView } = await import('./ToolFullView');

        const tool = makeToolCall({
            name: 'edit',
            state: 'running',
            input: {},
            result: null,
            completedAt: null,
            description: 'edit',
            permission: { id: 'perm1', status: 'pending' },
        });

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ToolFullView, { tool, metadata: null, messages: [], sessionId: 's1' }),
            );
        });

        expect(tree!.root.findAllByType('PermissionFooter' as any).length).toBe(1);
    });

    it('does not render PermissionFooter for tools that have custom permission UIs', async () => {
        const { ToolFullView } = await import('./ToolFullView');

        const tool = makeToolCall({
            name: 'AskUserQuestion',
            state: 'running',
            input: {},
            result: null,
            completedAt: null,
            description: 'question',
            permission: { id: 'perm1', status: 'pending' },
        });

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ToolFullView, { tool, metadata: null, messages: [], sessionId: 's1' }),
            );
        });

        expect(tree!.root.findAllByType('PermissionFooter' as any).length).toBe(0);
    });
});
