import React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { FocusReturnProvider, useFocusReturnFallbackRef } from '@/keyboard/focusReturn';
import type { NewSessionDraftProjection } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import {
    NewSessionDraftsSectionView,
    buildNewSessionDraftRowPresentation,
    deleteNewSessionDraftAfterConfirmation,
    resolveNewSessionDraftMachineUnavailable,
} from './NewSessionDraftsSection';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const base = await createReactNativeWebMock({ Pressable: 'Pressable' });
    const MockView = React.forwardRef((props: Record<string, unknown> & { children?: React.ReactNode }, ref) => {
        React.useImperativeHandle(ref, () => ({
            isConnected: true,
            focus: () => focusState.calls.push(String(props.testID)),
        }), [props.testID]);
        return React.createElement('View', props, props.children);
    });
    return { ...base, View: MockView };
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', () => ({ t: (key: string) => key }));
const focusState = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('@/components/ui/lists/Item', async () => {
    const ReactModule = await import('react');
    return {
        Item: (props: any) => {
            ReactModule.useEffect(() => {
                const assign = (value: unknown) => {
                    if (typeof props.pressableRef === 'function') props.pressableRef(value);
                    else if (props.pressableRef) props.pressableRef.current = value;
                };
                assign({ focus: () => focusState.calls.push(props.testID) });
                return () => assign(null);
            }, [props.pressableRef, props.testID]);
            return ReactModule.createElement('Item', props, props.rightElement);
        },
    };
});
vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useAppShellPluginUiProjection: () => ({ phase: 'unavailable', pluginUiProjection: null }),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children) }));
vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: any) => React.createElement('Icon', props),
    ICON_SIZE: { xs: 14, sm: 16, md: 20, lg: 24, xl: 29 },
}));
vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: any) => React.createElement('AgentIcon', props),
}));
vi.mock('@/agents/catalog/catalog', () => ({
    DEFAULT_AGENT_ID: 'claude',
    getAgentPickerIconScale: () => 1,
    resolveAgentIdFromFlavor: (value: unknown) => value === 'codex' || value === 'claude' ? value : null,
}));

function draft(
    overrides: Partial<NewSessionDraftProjection> = {},
    prompt = 'Fix login\nwith tests',
): NewSessionDraftProjection {
    return {
        draftId: '00000000-0000-4000-8000-000000000001',
        document: {
            v: 1,
            composer: {
                text: { mutationId: 'm-text', value: prompt },
                mentions: { mutationId: 'm-mentions', value: [] },
                attachments: { mutationId: 'm-attachments', value: [] },
            },
            target: {
                kind: 'newSession',
                authoring: {
                    directory: { mutationId: 'm-dir', value: '/Users/alice/private-project' },
                    machineId: { mutationId: 'm-machine', value: 'machine-a' },
                    agentId: { mutationId: 'm-agent', value: 'codex' },
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
    afterEach(() => {
        focusState.calls = [];
        standardCleanup();
    });

    it('derives a prompt-first title without routine machine, folder, agent, or model metadata', () => {
        const presentation = buildNewSessionDraftRowPresentation(draft());
        expect(presentation).toEqual({ title: 'Fix login', statusKey: 'sessionDrafts.status.syncing' });
        expect(JSON.stringify(presentation)).not.toContain('machine-a');
        expect(JSON.stringify(presentation)).not.toContain('private-project');
        expect(JSON.stringify(presentation)).not.toContain('codex');
        expect(JSON.stringify(presentation)).not.toContain('/Users/alice');
    });

    it('uses the first nonblank prompt line instead of treating leading whitespace as an empty prompt', () => {
        const withLeadingBlankLine = draft({}, '\n  Keep the second line  \nthird');
        expect(buildNewSessionDraftRowPresentation(withLeadingBlankLine).title).toBe('Keep the second line');
    });

    it('does not infer a user-facing interrupted state from local launch-attempt metadata', () => {
        const projection = draft({
            status: 'clean',
            localSupplement: { launchUserAttemptId: 'attempt-a' },
        });

        expect(buildNewSessionDraftRowPresentation(projection).statusKey).toBeNull();
    });

    it('presents exactly one prioritized safe problem label supplied by current owners', () => {
        const presentation = buildNewSessionDraftRowPresentation(draft(), {
            machineUnavailable: true,
            pluginUnavailable: true,
            attachmentNeedsAttention: true,
        });
        expect(presentation.statusKey).toBe('sessionDrafts.availability.machineUnavailable');
        expect(JSON.stringify(presentation)).not.toContain('sessionDrafts.availability.pluginUnavailable');
        expect(JSON.stringify(presentation)).not.toContain('sessionDrafts.availability.attachmentNeedsAttention');
        expect(JSON.stringify(presentation)).not.toContain('/private/daemon/socket');
    });

    it('marks a selected visible-but-offline machine unavailable only from a current inventory', () => {
        expect(resolveNewSessionDraftMachineUnavailable({
            machineId: 'machine-a',
            inventoryCurrent: true,
            onlineMachineIds: new Set(),
        })).toBe(true);
        expect(resolveNewSessionDraftMachineUnavailable({
            machineId: '  machine-a  ',
            inventoryCurrent: true,
            onlineMachineIds: new Set(['machine-a']),
        })).toBe(false);
        expect(resolveNewSessionDraftMachineUnavailable({
            machineId: 'machine-a',
            inventoryCurrent: false,
            onlineMachineIds: new Set(),
        })).toBe(false);
    });

    it('does not delete or restore focus when launch custody begins while confirmation is open', async () => {
        let confirmDeletion!: (confirmed: boolean) => void;
        let deletionDisposition: 'deletable' | 'launch-custody' = 'deletable';
        const deleteDraft = vi.fn(async () => undefined);
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
        expect(focusState.calls).toEqual([]);
    });

    it('renders saved drafts with a direct delete action outside row activation', async () => {
        const projection = draft();
        const onContinue = vi.fn();
        const onDelete = vi.fn(async () => true);
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                onContinue={onContinue}
                onDelete={onDelete}
            />,
        );
        const row = screen.findByTestId(`session-draft-row:new-session:${projection.draftId}`);
        row?.props.onPress();
        const deleteButton = screen.findByTestId(`session-draft-delete:new-session:${projection.draftId}`);
        const stopPropagation = vi.fn();
        await act(async () => deleteButton?.props.onPress({ stopPropagation }));
        expect(onContinue).toHaveBeenCalledWith(projection.draftId);
        expect(onDelete).toHaveBeenCalledWith(projection.draftId);
        expect(stopPropagation).toHaveBeenCalledOnce();
        expect(screen.findByTestId('session-draft-new')).toBeNull();
        expect(row?.props).toMatchObject({
            subtitle: 'sessionDrafts.status.syncing',
            subtitleTestID: `session-draft-status:new-session:${projection.draftId}`,
            rightElementOutsidePressable: true,
        });
        expect(String(row?.props.accessibilityLabel)).not.toContain('sessionDrafts.badge');
        expect(Object.assign({}, ...([] as any[]).concat(deleteButton?.props.style ?? []))).toMatchObject({
            width: 24,
            height: 24,
        });
        expect(deleteButton?.props.hitSlop).toEqual({ top: 10, bottom: 10, left: 10, right: 10 });
        expect(deleteButton?.props.accessibilityLabel).toBe('sessionDrafts.delete.action');
        expect(screen.findByTestId(`session-draft-menu:new-session:${projection.draftId}`)).toBeNull();
        await screen.unmount();
    });

    it('matches Session-list density while preserving an edge-aligned direct action target', async () => {
        const projection = draft();
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                density="minimal"
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
            />,
        );
        const row = screen.findByTestId(`session-draft-row:new-session:${projection.draftId}`);
        expect(row?.props).toMatchObject({
            density: 'tight',
            titleLines: 1,
            subtitle: undefined,
            rightElementOutsidePressable: true,
            style: { height: 34, minHeight: 34, paddingVertical: 0 },
            titleStyle: { fontSize: 12, lineHeight: 16 },
        });
        expect(row?.props.leftElement?.props).toMatchObject({
            agentId: 'codex',
            size: 14,
            testID: `session-draft-agent-logo:new-session:${projection.draftId}`,
        });
        expect(String(row?.props.accessibilityLabel)).toContain('sessionDrafts.status.syncing');
        expect(screen.findByTestId(`session-draft-action-slot:new-session:${projection.draftId}`)?.props.style).toMatchObject({
            alignItems: 'flex-end',
            width: 24,
        });
        expect(Object.assign({}, ...([] as any[]).concat(
            screen.findByTestId(`session-draft-delete:new-session:${projection.draftId}`)?.props.style ?? [],
        ))).toMatchObject({
            width: 24,
            height: 24,
        });
        await screen.unmount();

        const detailed = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                density="default"
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
            />,
        );
        expect(detailed.findByTestId(`session-draft-row:new-session:${projection.draftId}`)?.props).toMatchObject({
            density: 'comfortable',
            titleLines: 2,
            subtitle: 'sessionDrafts.status.syncing',
            style: { height: 84, minHeight: 84, paddingVertical: 0 },
            titleStyle: { fontSize: 14, lineHeight: 18 },
            subtitleStyle: { fontSize: 12, lineHeight: 16 },
        });
        expect(detailed.findByTestId(`session-draft-row:new-session:${projection.draftId}`)?.props.leftElement).toBeUndefined();
        await detailed.unmount();
    });

    it('renders nothing when the repository has no saved new-session drafts', async () => {
        const screen = await renderScreen(
            <NewSessionDraftsSectionView drafts={[]} onContinue={vi.fn()} onDelete={vi.fn(async () => false)} />,
        );
        expect(screen.findByTestId('session-drafts-section')).toBeNull();
        await screen.unmount();
    });

    it('disables deletion while launch custody is retained', async () => {
        const projection = draft();
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
                deleteDisabledDraftIds={new Set([projection.draftId])}
            />,
        );
        expect(screen.findByTestId(`session-draft-delete:new-session:${projection.draftId}`)?.props).toMatchObject({
            disabled: true,
            accessibilityState: { disabled: true },
        });
        await screen.unmount();
    });

    it('restores focus to the nearest surviving row, then the canonical list fallback', async () => {
        const first = draft();
        const second = { ...draft(), draftId: '00000000-0000-4000-8000-000000000002', updatedAt: 19 };

        function Harness() {
            const [drafts, setDrafts] = React.useState<readonly NewSessionDraftProjection[]>([first, second]);
            const fallbackRef = useFocusReturnFallbackRef<React.ElementRef<typeof View> | null>();
            return (
                <View ref={fallbackRef} testID="session-list-focus-fallback">
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
        await act(async () => screen.findByTestId(`session-draft-delete:new-session:${first.draftId}`)?.props.onPress({
            stopPropagation: vi.fn(),
        }));
        await vi.waitFor(() => expect(focusState.calls).toContain(
            `session-draft-row:new-session:${second.draftId}`,
        ));

        await act(async () => screen.findByTestId(`session-draft-delete:new-session:${second.draftId}`)?.props.onPress({
            stopPropagation: vi.fn(),
        }));
        await vi.waitFor(() => expect(focusState.calls).toContain('session-list-focus-fallback'));
        await screen.unmount();
    });
});
