import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { createVisibleMessagesResolverFromDescriptor } from './visibleMessageDescriptors';

function message(id: string, text: string): Message {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt: 1,
        text,
        meta: undefined,
    };
}

describe('createVisibleMessagesResolverFromDescriptor', () => {
    it('filters JSON lifecycle event text for matching subagent kinds', () => {
        const { resolveVisibleMessages, diagnostics } = createVisibleMessagesResolverFromDescriptor({
            kind: 'plugin.ui.v1',
            pluginId: 'claude',
            agentId: 'claude',
            version: 1,
            display: {},
            session: {
                visibleMessages: {
                    kind: 'session.visibleMessages.v1',
                    subagentKinds: ['agent_team_member'],
                    fallbackToolNames: ['Agent', 'Task'],
                    excludeJsonEventTypes: ['idle_notification', 'shutdown_approved'],
                },
            },
            message: {},
            components: { slots: [] },
        });

        const focusedMessages = [
            message('m1', 'useful output'),
            message('m2', '{"type":"idle_notification"}'),
            message('m3', '"{\\"type\\":\\"shutdown_approved\\"}"'),
        ];

        expect(diagnostics).toEqual([]);
        expect(resolveVisibleMessages({
            session: {} as any,
            tool: {} as any,
            messages: [],
            focusedMessages,
            subagents: [],
            subagent: { kind: 'agent_team_member' } as any,
        })).toEqual([focusedMessages[0]]);
    });

    it('does not materialize legacy descriptor ids without inline descriptor data', () => {
        const { resolveVisibleMessages, diagnostics } = createVisibleMessagesResolverFromDescriptor({
            kind: 'plugin.ui.v1',
            pluginId: 'claude',
            agentId: 'claude',
            version: 1,
            display: {},
            session: {
                visibleMessageFilterDescriptorId: 'claude.visibleMessages.v1',
            },
            message: {},
            components: { slots: [] },
        });

        const focusedMessages = [message('m1', '{"type":"idle_notification"}')];
        expect(resolveVisibleMessages({
            session: {} as any,
            tool: {} as any,
            messages: [],
            focusedMessages,
            subagents: [],
            subagent: { kind: 'agent_team_member' } as any,
        })).toBeNull();
        expect(diagnostics).toContainEqual(expect.objectContaining({
            code: 'A16X1_UNSUPPORTED_DESCRIPTOR_ADAPTER',
            path: 'session.visibleMessageFilterDescriptorId',
        }));
    });

    it('fails closed for unsupported descriptor kinds', () => {
        const { resolveVisibleMessages, diagnostics } = createVisibleMessagesResolverFromDescriptor({
            kind: 'plugin.ui.v1',
            pluginId: 'claude',
            agentId: 'claude',
            version: 1,
            display: {},
            session: {
                visibleMessageFilterDescriptorId: 'claude.unknownVisibleMessages.v1',
            },
            message: {},
            components: { slots: [] },
        });

        const focusedMessages = [message('m1', 'keep me')];
        expect(resolveVisibleMessages({
            session: {} as any,
            tool: {} as any,
            messages: [],
            focusedMessages,
            subagents: [],
            subagent: { kind: 'agent_team_member' } as any,
        })).toBeNull();
        expect(diagnostics).toContainEqual(expect.objectContaining({
            code: 'A16X1_UNSUPPORTED_DESCRIPTOR_ADAPTER',
            path: 'session.visibleMessageFilterDescriptorId',
        }));
    });
});
