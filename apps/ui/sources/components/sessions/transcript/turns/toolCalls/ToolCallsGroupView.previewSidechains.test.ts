import { describe, expect, it } from 'vitest';

import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';

import { resolveGroupedPreviewSidechainIds } from '@/components/sessions/transcript/toolCalls/units/groupedToolCallRowContent';

function makeToolMessage(overrides?: Partial<ToolCallMessage>): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: 'tool-msg-1',
        localId: null,
        createdAt: 1,
        tool: {
            id: 'subagent_run_1',
            name: 'SubAgentRun',
            state: 'running',
            input: { sidechainId: 'sidechain_run_1', intent: 'review' },
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            description: null,
        },
        children: [],
        ...overrides,
    };
}

describe('resolveGroupedPreviewSidechainIds', () => {
    it('eager-loads running subagent sidechains for grouped activity-feed previews', () => {
        expect(resolveGroupedPreviewSidechainIds({
            chromeMode: 'activity_feed',
            previewMessages: [makeToolMessage()],
        })).toEqual(['sidechain_run_1']);
    });

    it('ignores non-subagent tool previews', () => {
        expect(resolveGroupedPreviewSidechainIds({
            chromeMode: 'activity_feed',
            previewMessages: [
                makeToolMessage({
                    tool: {
                        ...makeToolMessage().tool,
                        name: 'edit',
                    },
                }),
            ],
        })).toEqual([]);
    });

    it('does not eager-load sidechains for cards mode previews', () => {
        expect(resolveGroupedPreviewSidechainIds({
            chromeMode: 'cards',
            previewMessages: [makeToolMessage()],
        })).toEqual([]);
    });
});
