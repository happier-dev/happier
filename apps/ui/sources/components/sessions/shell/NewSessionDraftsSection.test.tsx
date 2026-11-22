import React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { NewSessionDraftProjection } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { FocusReturnProvider, useFocusReturnFallbackRef } from '@/keyboard/focusReturn';

import {
    NewSessionDraftsSectionView,
    buildNewSessionDraftRowPresentation,
    deleteNewSessionDraftAfterConfirmation,
    resolveNewSessionDraftLaunchState,
} from './NewSessionDraftsSection';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const base = await createReactNativeWebMock({ Pressable: 'Pressable' });
    const View = React.forwardRef((props: any, ref) => {
        React.useImperativeHandle(ref, () => ({
            isConnected: true,
            focus: () => {
                (globalThis as any).__sessionDraftFocusedTarget = props.testID ?? null;
            },
        }), [props.testID]);
        return React.createElement('View', props, props.children);
    });
    return { ...base, View };
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', () => ({
    t: (key: string, params?: Record<string, string>) => params
        ? `${key}:${Object.values(params).join('|')}`
        : key,
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => {
        React.useImperativeHandle(props.focusRef, () => ({
            isConnected: true,
            focus: () => {
                (globalThis as any).__sessionDraftFocusedTarget = props.testID ?? null;
            },
        }), [props.focusRef, props.testID]);
        return React.createElement('Item', props, props.rightElement);
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: any) => React.createElement('Icon', props),
    ICON_SIZE: { sm: 14, md: 16, lg: 18, xl: 20 },
}));

vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({
    ActivitySpinner: (props: any) => React.createElement('ActivitySpinner', props),
    iconMatchedSpinnerSize: (size: number) => size,
}));

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: any) => React.createElement('AgentIcon', props),
}));
vi.mock('@/agents/catalog/catalog', () => ({
    DEFAULT_AGENT_ID: 'claude',
    getAgentPickerIconScale: () => 1,
    resolveAgentIdFromFlavor: (value: unknown) => value === 'codex' || value === 'claude' ? value : null,
}));

function draft(overrides: Partial<NewSessionDraftProjection> = {}): NewSessionDraftProjection {
    return {
        draftId: '00000000-0000-4000-8000-000000000001',
        document: {
            v: 1,
            composer: {
                text: { mutationId: 'm-text', value: 'Fix login\nwith tests' },
                mentions: { mutationId: 'm-mentions', value: [] },
                attachments: { mutationId: 'm-attachments', value: [] },
            },
            target: {
                kind: 'newSession',
                authoring: {
                    directory: { mutationId: 'm-dir', value: '/Users/alice/private-project' },
                    machineId: { mutationId: 'm-machine', value: 'machine-a' },
                    agentId: { mutationId: 'm-agent', value: 'codex' },
                    modelId: { mutationId: 'm-model', value: 'gpt-5' },
                },
            },
            extensions: {},
        },
        status: 'pending',
        conflict: null,
        createdAt: 10,
        updatedAt: 20,
        localSupplement: {},
        ...overrides,
    };
}

describe('NewSessionDraftsSection', () => {
    afterEach(() => standardCleanup());

    it('derives a prompt-first title without routine machine, folder, agent, or model metadata', () => {
        const presentation = buildNewSessionDraftRowPresentation(draft(), {});

        expect(presentation.title).toBe('Fix login');
        expect(JSON.stringify(presentation)).not.toContain('Mac Studio');
        expect(JSON.stringify(presentation)).not.toContain('private-project');
        expect(JSON.stringify(presentation)).not.toContain('Codex');
        expect(JSON.stringify(presentation)).not.toContain('gpt-5');
        expect(JSON.stringify(presentation)).not.toContain('/Users/alice');
        expect(presentation.statusKey).toBe('sessionDrafts.status.syncing');
    });

    it('does not infer a user-facing interrupted state from local launch-attempt metadata', () => {
        const presentation = buildNewSessionDraftRowPresentation(draft({
            status: 'clean',
            localSupplement: { launchUserAttemptId: 'attempt-a' },
        }), {});

        expect(presentation.statusKey).toBeNull();
    });

    it('reports the launch the action-operation owner is actually running, ahead of routine sync status', () => {
        const launching = buildNewSessionDraftRowPresentation(draft(), {
            launchStateByDraftId: new Map([['00000000-0000-4000-8000-000000000001', 'launching' as const]]),
        });

        expect(launching.statusKey).toBe('sessionDrafts.status.starting');
        expect(launching.statusTone).toBeNull();
    });

    it('reports a failed launch as a danger status that outranks every other draft status', () => {
        const failed = buildNewSessionDraftRowPresentation(draft({ status: 'conflict' }), {
            launchStateByDraftId: new Map([['00000000-0000-4000-8000-000000000001', 'failed' as const]]),
        });

        expect(failed.statusKey).toBe('sessionDrafts.status.startFailed');
        expect(failed.statusTone).toBe('danger');
    });

    it('says nothing extra while a settled launch still holds draft custody', () => {
        const settled = buildNewSessionDraftRowPresentation(draft({ status: 'clean' }), {
            launchStateByDraftId: new Map([['00000000-0000-4000-8000-000000000001', 'settled' as const]]),
        });

        expect(settled.statusKey).toBeNull();
    });

    it('derives the draft launch state from the action-operation owner rather than local launch metadata', () => {
        const operation = {
            version: 1 as const,
            operationId: 'op-1',
            requestId: 'nonce-1',
            revision: 1,
            actionId: 'session.spawn_new',
            state: 'running' as const,
            scope: { accountId: 'account-a', machineId: 'machine-a' },
            title: 'Start session',
            createdAt: 1,
            cancellation: 'unsupported' as const,
        };
        const identity = {
            operation,
            custody: {} as any,
            launchCurrentness: null,
        };

        expect(resolveNewSessionDraftLaunchState(null)).toBeNull();
        expect(resolveNewSessionDraftLaunchState(identity)).toBe('launching');
        expect(resolveNewSessionDraftLaunchState({
            ...identity,
            operation: { ...operation, state: 'failed' as const, error: { errorCode: 'E', error: 'boom' } },
        })).toBe('failed');
        expect(resolveNewSessionDraftLaunchState({
            ...identity,
            operation: { ...operation, state: 'succeeded' as const },
        })).toBe('settled');
    });

    it('surfaces current machine and local attachment problems without exposing their raw state', () => {
        const unavailableMachine = buildNewSessionDraftRowPresentation(draft({ status: 'clean' }), {
            unavailableMachineIds: new Set(['machine-a']),
        });
        const attachmentProblem = buildNewSessionDraftRowPresentation(draft({ status: 'clean' }), {
            attachmentNeedsAttentionDraftIds: new Set(['00000000-0000-4000-8000-000000000001']),
        });

        expect(unavailableMachine.statusKey).toBe('sessionDrafts.status.machineUnavailable');
        expect(attachmentProblem.statusKey).toBe('sessionDrafts.status.attachmentNeedsAttention');
        expect(JSON.stringify(attachmentProblem)).not.toContain('/Users/alice');
    });

    it('does not delete or restore focus when launch custody begins while confirmation is open', async () => {
        let confirmDeletion!: (confirmed: boolean) => void;
        let deletionDisposition: 'deletable' | 'launch-custody' = 'deletable';
        const deleteDraft = vi.fn(async () => true);
        const attempt = deleteNewSessionDraftAfterConfirmation({
            confirm: () => new Promise<boolean>((resolve) => {
                confirmDeletion = resolve;
            }),
            readCurrentDraftDeletionDisposition: () => deletionDisposition,
            deleteDraft,
        });

        deletionDisposition = 'launch-custody';
        confirmDeletion(true);

        await expect(attempt).resolves.toBe(false);
        expect(deleteDraft).not.toHaveBeenCalled();
    });

    it('does not issue another deletion or restore focus when the confirmed draft is already missing', async () => {
        const deleteDraft = vi.fn(async () => true);

        await expect(deleteNewSessionDraftAfterConfirmation({
            confirm: async () => true,
            readCurrentDraftDeletionDisposition: () => 'missing',
            deleteDraft,
        })).resolves.toBe(false);
        expect(deleteDraft).not.toHaveBeenCalled();
    });

    it('does not report deletion when the canonical draft owner cannot acknowledge the tombstone', async () => {
        await expect(deleteNewSessionDraftAfterConfirmation({
            confirm: async () => true,
            readCurrentDraftDeletionDisposition: () => 'deletable',
            deleteDraft: async () => false,
        })).resolves.toBe(false);
    });

    it('renders a direct delete action and routes continue/delete by identity', async () => {
        const onContinue = vi.fn();
        const onDelete = vi.fn(async () => true);
        const projection = draft();
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                onContinue={onContinue}
                onDelete={onDelete}
            />,
        );

        expect(screen.findByTestId('session-drafts-section')).toBeTruthy();
        expect(screen.findByTestId(`session-draft-row:new-session:${projection.draftId}`)).toBeTruthy();
        const deleteButton = screen.findByTestId(`session-draft-delete:new-session:${projection.draftId}`);
        expect(deleteButton).toBeTruthy();
        expect(Object.assign({}, ...([] as any[]).concat(deleteButton?.props.style ?? []))).toMatchObject({ width: 24, height: 24 });
        expect(deleteButton?.props.hitSlop).toEqual({ top: 10, bottom: 10, left: 10, right: 10 });
        expect(deleteButton?.props.accessibilityLabel).toBe('sessionDrafts.delete.action');
        expect(screen.findByTestId(`session-draft-menu:new-session:${projection.draftId}`)).toBeNull();
        expect(screen.findByTestId('session-draft-new')).toBeNull();

        const draftRow = screen.findByTestId(`session-draft-row:new-session:${projection.draftId}`);
        await act(async () => {
            draftRow?.props.onPress();
        });
        expect(onContinue).toHaveBeenCalledWith(projection.draftId);
        expect(draftRow?.props.subtitle).toBe('sessionDrafts.status.syncing');
        expect(draftRow?.props.subtitleTestID).toBe(`session-draft-status:new-session:${projection.draftId}`);

        const stopPropagation = vi.fn();
        await act(async () => {
            deleteButton?.props.onPress({ stopPropagation });
        });
        expect(stopPropagation).toHaveBeenCalledOnce();
        expect(onDelete).toHaveBeenCalledWith(projection.draftId);

        await screen.unmount();
    });

    it('matches the selected Session-row density and keeps minimal rows to one visual line', async () => {
        const projection = draft();
        const minimal = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                density="minimal"
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
            />,
        );
        const minimalRow = minimal.findByTestId(`session-draft-row:new-session:${projection.draftId}`);
        expect(minimalRow?.props.density).toBe('tight');
        expect(minimalRow?.props.titleLines).toBe(1);
        expect(minimalRow?.props.subtitle).toBeUndefined();
        expect(minimalRow?.props.style).toMatchObject({
            height: 34,
            minHeight: 34,
            paddingVertical: 0,
        });
        expect(minimalRow?.props.titleStyle).toMatchObject({ fontSize: 12, lineHeight: 16 });
        expect(minimalRow?.props.leftElement?.props).toMatchObject({
            agentId: 'codex',
            size: 14,
            testID: `session-draft-agent-logo:new-session:${projection.draftId}`,
        });
        expect(minimalRow?.props.accessibilityLabel).toContain('sessionDrafts.status.syncing');
        const minimalDelete = minimal.findByTestId(`session-draft-delete:new-session:${projection.draftId}`);
        expect(Object.assign({}, ...([] as any[]).concat(minimalDelete?.props.style ?? []))).not.toHaveProperty('marginRight');
        await minimal.unmount();

        const compact = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                density="compact"
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
            />,
        );
        const compactRow = compact.findByTestId(`session-draft-row:new-session:${projection.draftId}`);
        expect(compactRow?.props.density).toBe('compact');
        expect(compactRow?.props.titleLines).toBe(2);
        expect(compactRow?.props.subtitle).toBe('sessionDrafts.status.syncing');
        expect(compactRow?.props.style).toMatchObject({
            height: 58,
            minHeight: 58,
            paddingVertical: 0,
        });
        expect(compactRow?.props.titleStyle).toMatchObject({ fontSize: 14, lineHeight: 18 });
        expect(compactRow?.props.subtitleStyle).toMatchObject({ fontSize: 11, lineHeight: 11 });
        expect(compactRow?.props.leftElement).toBeUndefined();
        await compact.unmount();
    });

    it('renders nothing when the repository has no new-session drafts', async () => {
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[]}
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
            />,
        );
        expect(screen.root.findAllByProps({ testID: 'session-drafts-section' })).toHaveLength(0);
        await screen.unmount();
    });

    it('disables raw deletion while the action-operation owner retains launch custody', async () => {
        const projection = draft();
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
                launchStateByDraftId={new Map([[projection.draftId, 'settled' as const]])}
            />,
        );

        expect(screen.findByTestId(`session-draft-delete:new-session:${projection.draftId}`)?.props).toMatchObject({
            disabled: true,
            accessibilityState: { disabled: true },
        });
        await screen.unmount();
    });

    it('shows the running launch as a spinner on its own draft row, in every density', async () => {
        const projection = draft();
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                density="minimal"
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
                launchStateByDraftId={new Map([[projection.draftId, 'launching' as const]])}
            />,
        );

        expect(screen.findByTestId(`session-draft-launching:new-session:${projection.draftId}`)).toBeTruthy();
        expect(screen.findByTestId(`session-draft-delete:new-session:${projection.draftId}`)).toBeNull();
        expect(screen.findByTestId(`session-draft-row:new-session:${projection.draftId}`)?.props.accessibilityLabel)
            .toContain('sessionDrafts.status.starting');
        await screen.unmount();
    });

    it('keeps a failed launch visible on its draft row even where the row has no status line', async () => {
        const projection = draft();
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                density="minimal"
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
                launchStateByDraftId={new Map([[projection.draftId, 'failed' as const]])}
            />,
        );

        expect(screen.findByTestId(`session-draft-start-failed:new-session:${projection.draftId}`)).toBeTruthy();
        expect(screen.findByTestId(`session-draft-launching:new-session:${projection.draftId}`)).toBeNull();
        expect(screen.findByTestId(`session-draft-delete:new-session:${projection.draftId}`)).toBeNull();
        expect(screen.findByTestId(`session-draft-row:new-session:${projection.draftId}`)?.props.accessibilityLabel)
            .toContain('sessionDrafts.status.startFailed');
        await screen.unmount();
    });

    it('restores focus to the nearest surviving row after confirmed deletion', async () => {
        (globalThis as any).__sessionDraftFocusedTarget = null;
        const first = draft();
        const second = draft({ draftId: '00000000-0000-4000-8000-000000000002', updatedAt: 19 });

        function Harness() {
            const [drafts, setDrafts] = React.useState<readonly NewSessionDraftProjection[]>([first, second]);
            const listFocusFallbackRef = useFocusReturnFallbackRef<React.ElementRef<typeof View> | null>();
            return (
                <View ref={listFocusFallbackRef} testID="session-list-focus-fallback">
                    <NewSessionDraftsSectionView
                        drafts={drafts}
                        onContinue={vi.fn()}
                        onDelete={async (draftId) => {
                            setDrafts((current) => current.filter((candidate) => candidate.draftId !== draftId));
                            return true;
                        }}
                    />
                </View>
            );
        }

        const screen = await renderScreen(<FocusReturnProvider><Harness /></FocusReturnProvider>);
        const firstDelete = screen.findByTestId(`session-draft-delete:new-session:${first.draftId}`);
        await act(async () => {
            firstDelete?.props.onPress({ stopPropagation: vi.fn() });
        });

        await vi.waitFor(() => expect((globalThis as any).__sessionDraftFocusedTarget).toBe(
            `session-draft-row:new-session:${second.draftId}`,
        ));

        const lastDelete = screen.findByTestId(`session-draft-delete:new-session:${second.draftId}`);
        await act(async () => {
            lastDelete?.props.onPress({ stopPropagation: vi.fn() });
        });
        await vi.waitFor(() => expect((globalThis as any).__sessionDraftFocusedTarget).toBe('session-list-focus-fallback'));
        await screen.unmount();
    });
});
