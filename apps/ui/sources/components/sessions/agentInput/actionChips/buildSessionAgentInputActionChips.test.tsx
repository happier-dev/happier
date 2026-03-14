import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSessionAgentInputActionChips } from './buildSessionAgentInputActionChips';

const createSessionActionDraftMock = vi.hoisted(() => vi.fn());
const actionIdsState = vi.hoisted(() => ({
    value: [] as string[],
}));

vi.mock('react-native', () => ({
    Pressable: 'Pressable',
    View: 'View',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: React.ReactNode) => node,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            createSessionActionDraft: createSessionActionDraftMock,
        }),
    },
}));

vi.mock('@/components/sessions/agentInput/actionChips/listAgentInputActionChipActionIds', () => ({
    listAgentInputActionChipActionIds: () => actionIdsState.value,
}));

describe('buildSessionAgentInputActionChips', () => {
    beforeEach(() => {
        createSessionActionDraftMock.mockReset();
        actionIdsState.value = [];
    });

    it('seeds UI-normalized permission defaults for execution-run action chips', () => {
        actionIdsState.value = ['review.start', 'subagents.delegate.start'];

        const chips = buildSessionAgentInputActionChips({
            sessionId: 'session-1',
            defaultBackendTarget: { kind: 'builtInAgent', agentId: 'claude' } as const,
            defaultBackendId: 'claude',
            instructionsText: '',
        });

        const expectations = [
            { key: 'session-action:review.start', actionId: 'review.start', permissionMode: 'read-only' },
            { key: 'session-action:subagents.delegate.start', actionId: 'subagents.delegate.start', permissionMode: 'safe-yolo' },
        ] as const;

        for (const expectation of expectations) {
            const chip = chips.find((entry) => entry.key === expectation.key);
            expect(chip).toBeTruthy();

            const rendered = chip!.render({
                chipStyle: () => null,
                showLabel: true,
                iconColor: '#000',
                textStyle: {},
                countTextStyle: {},
                popoverAnchorRef: { current: null },
            }) as React.ReactElement<{ onPress?: () => void }>;

            rendered.props.onPress?.();

            expect(createSessionActionDraftMock).toHaveBeenLastCalledWith(
                'session-1',
                expect.objectContaining({
                    actionId: expectation.actionId,
                    input: expect.objectContaining({
                        permissionMode: expectation.permissionMode,
                    }),
                }),
            );
        }
    });
});
