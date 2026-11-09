import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionListItem } from '@/components/ui/lists/ActionListSection';

import { buildSessionAgentInputActionChips } from './buildSessionAgentInputActionChips';

const createSessionActionDraftMock = vi.hoisted(() => vi.fn());
const actionIdsState = vi.hoisted(() => ({
    value: [] as string[],
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                    Pressable: 'Pressable',
                                    View: 'View',
                                }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: React.ReactNode) => node,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
        getState: () => ({
            createSessionActionDraft: createSessionActionDraftMock,
        }),
    },
});
});

vi.mock('@/components/sessions/agentInput/sessionActions/listAgentInputActionChipActionIds', () => ({
    listAgentInputActionChipActionIds: () => actionIdsState.value,
}));

function expectSingleCollapsedAction(
    action: ActionListItem | readonly ActionListItem[] | undefined,
): ActionListItem {
    expect(Array.isArray(action)).toBe(false);
    if (!action || Array.isArray(action)) {
        throw new Error('expected a single collapsed action');
    }
    return action as ActionListItem;
}

describe('buildSessionAgentInputActionChips', () => {
    beforeEach(() => {
        createSessionActionDraftMock.mockReset();
        actionIdsState.value = [];
    });

    it('seeds UI-normalized permission defaults for execution-run action chips', () => {
        actionIdsState.value = ['review.start', 'subagents.delegate.start'];
        let composerText = '';

        const chips = buildSessionAgentInputActionChips({
            accountScope: { serverId: 'server-a', accountId: 'account-a' },
            openExecutionRunDraft: seed => createSessionActionDraftMock(seed.scope, { serverId: seed.scope.serverId, sessionId: seed.sessionId }, { actionId: seed.actionId, input: seed.input }),
            address: { serverId: 'server-a', sessionId: 'session-1' },
            defaultBackendTarget: { kind: 'builtInAgent', agentId: 'claude' } as const,
            defaultBackendId: 'claude',
            readInstructionsText: () => composerText,
        });
        // The chips are built once; the draft carries the composer text as it is at the press.
        composerText = 'Check the retry path';

        const expectations = [
            { key: 'session-action:review.start', actionId: 'review.start', permissionMode: 'read_only' },
            { key: 'session-action:subagents.delegate.start', actionId: 'subagents.delegate.start', permissionMode: 'workspace_write' },
        ] as const;

        for (const expectation of expectations) {
            const chip = chips.find((entry) => entry.key === expectation.key);
            expect(chip).toBeTruthy();
            expect(chip?.controlId).toBe('shortcuts');
            const collapsedAction = expectSingleCollapsedAction(chip?.collapsedAction?.({
                tint: '#000',
                dismiss: () => {},
                blurInput: () => {},
                openCollapsedPopover: () => {},
            }));
            expect(collapsedAction.id).toBe(expectation.key);

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
                { serverId: 'server-a', accountId: 'account-a' },
                { serverId: 'server-a', sessionId: 'session-1' },
                expect.objectContaining({
                    actionId: expectation.actionId,
                    input: expect.objectContaining({
                        permissionMode: expectation.permissionMode,
                        instructions: 'Check the retry path',
                    }),
                }),
            );
        }
    });

    it('does not let a retired exact Account owner create an action draft', () => {
        actionIdsState.value = ['review.start'];
        let current = true;
        const chips = buildSessionAgentInputActionChips({
            accountScope: { serverId: 'server-a', accountId: 'account-a' },
            openExecutionRunDraft: seed => createSessionActionDraftMock(seed.scope, { serverId: seed.scope.serverId, sessionId: seed.sessionId }, { actionId: seed.actionId, input: seed.input }),
            accountScopeIsCurrent: () => current,
            address: { serverId: 'server-a', sessionId: 'session-1' },
            defaultBackendId: 'claude',
            readInstructionsText: () => '',
        });
        const rendered = chips[0]?.render({
            chipStyle: () => null,
            showLabel: true,
            iconColor: '#000',
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: { current: null },
        }) as React.ReactElement<{ onPress?: () => void }>;

        current = false;
        rendered.props.onPress?.();

        expect(createSessionActionDraftMock).not.toHaveBeenCalled();
    });
});
