import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { makeToolCall } from './ToolView.testHelpers';
import type { Message } from '@/sync/domains/messages/messageTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: () => false,
    useSetting: () => false,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: () => null,
}));

const renderedSpecificTaskViewSpy = vi.fn();

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: (toolName: string) => {
        if (toolName === 'Task') {
            return (props: any) => {
                renderedSpecificTaskViewSpy(props);
                return React.createElement('TaskSpecificView', null);
            };
        }
        return null;
    },
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        Task: { title: 'Task' },
    },
}));

vi.mock('@/components/tools/renderers/system/StructuredResultView', () => ({
    StructuredResultView: () => null,
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

const renderedMessageViewSpy = vi.fn();

vi.mock('@/components/sessions/transcript/MessageView', () => ({
    MessageView: (props: any) => {
        renderedMessageViewSpy(props);
        return React.createElement('MessageView', null);
    },
}));

describe('ToolFullView (Task transcript reuse)', () => {
    it('renders Task sidechain messages through MessageView instead of Task renderer in full view', async () => {
        renderedSpecificTaskViewSpy.mockReset();
        renderedMessageViewSpy.mockReset();
        const { ToolFullView } = await import('./ToolFullView');

        const tool = makeToolCall({
            name: 'Task',
            input: { operation: 'run', description: 'Explore' },
            result: null,
        });
        const child: Message = {
            kind: 'agent-text',
            id: 'child-msg-1',
            localId: null,
            createdAt: 1000,
            text: 'Working...',
            isThinking: false,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ToolFullView, {
                    tool,
                    metadata: null,
                    messages: [child],
                    sessionId: 's1',
                    interaction: { canSendMessages: true, canApprovePermissions: true },
                }),
            );
        });

        expect(tree.root.findAllByType('MessageView' as any)).toHaveLength(1);
        expect(renderedMessageViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                message: child,
                sessionId: 's1',
                interaction: expect.objectContaining({ disableToolNavigation: true }),
            }),
        );
        expect(renderedSpecificTaskViewSpy).not.toHaveBeenCalled();
    });
});
