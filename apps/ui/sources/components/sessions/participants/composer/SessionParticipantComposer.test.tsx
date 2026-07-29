import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { renderScreen } from '@/dev/testkit';
import {
    attachBrowserContextToComposer,
    captureBrowserPageReference,
    createBrowserContextState,
    markBrowserContextViewNavigation,
    type BrowserContextState,
} from '@/sync/domains/browser/context';
import type { BrowserAdapterCapabilitiesV1, BrowserContextCapabilities } from '@happier-dev/protocol';
import {
    installSessionActionsCommonModuleMocks,
    resetSessionActionsCommonModuleMockState,
} from '../../actions/sessionActionsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const agentInputSpy = vi.fn();
const modalAlertSpy = vi.fn();
const syncSubmitMessageSpy = vi.fn(async () => undefined);
const sessionExecutionRunSendSpy = vi.fn<
    (sessionId: string, request: { runId: string; message: string; delivery?: 'prompt' | 'steer_if_supported' | 'interrupt' }) => Promise<{ ok: boolean; error?: string }>
>(async () => ({ ok: true }));
const isExecutionRunNotRunningSendErrorSpy = vi.fn(() => false);

vi.mock('@/theme', () => ({
    lightTheme: {
        colors: {
            feed: {
                card: {
                    background: '#fff',
                },
            },
        },
    },
    darkTheme: {
        colors: {
            feed: {
                card: {
                    background: '#000',
                },
            },
        },
    },
}));

const contextCapabilities = {
    enabled: true,
    available: true,
    supportedContextKinds: ['browserPageReference'],
    supportedAdapterKinds: ['localPreview'],
    screenshot: {
        supported: false,
        requiresAttachmentUploads: true,
    },
    text: {
        maxSelectionChars: 2048,
        maxSummaryChars: 8192,
    },
    disabledReasons: [],
    policyDeniedReasons: [],
} satisfies BrowserContextCapabilities;

const adapterCapabilities = {
    adapterKind: 'localPreview',
    supportedTargetKinds: ['localServicePreview'],
    supportedRenderEngines: ['webIframe'],
    navigation: {
        canNavigate: true,
        canGoBack: false,
        canGoForward: false,
        canReload: true,
        canStop: false,
    },
    diagnosticsFidelityByFamily: {
        pageInfo: 'previewProxy',
    },
    contextKinds: ['browserPageReference'],
    inputRouting: 'none',
    supportsDownloads: false,
    supportsUploads: false,
    supportsPopups: false,
    supportsPermissions: false,
    supportsStreamingDisplay: false,
    disabledReasons: [],
} satisfies BrowserAdapterCapabilitiesV1;

function createAttachedBrowserContextState(options: Readonly<{ stale?: boolean }> = {}): BrowserContextState {
    const captured = captureBrowserPageReference({
        state: createBrowserContextState(),
        browserContextEnabled: true,
        contextCapabilities,
        adapterCapabilities,
        viewId: 'view_1',
        target: {
            kind: 'localServicePreview',
            targetId: 'preview_1',
            sessionId: 's1',
            machineId: 'machine_1',
            display: {
                title: 'Dashboard',
                addressLabel: 'localhost:5173',
            },
        },
        page: {
            url: 'https://preview.localhost.test/dashboard?token=secret#panel',
            title: 'Dashboard',
            navigationGeneration: 2,
            capturedAtMs: 4_000,
        },
    });
    if (captured.status !== 'captured') throw new Error('failed to build browser context fixture');

    const attached = attachBrowserContextToComposer(captured.state, {
        attachmentId: 'attachment_1',
        contextId: captured.itemId,
    });
    if (attached.status !== 'attached') throw new Error('failed to attach browser context fixture');

    return options.stale === true
        ? markBrowserContextViewNavigation(attached.state, {
            viewId: 'view_1',
            navigationGeneration: 3,
        })
        : attached.state;
}

installSessionActionsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('View', props, children),
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: (...args: unknown[]) => modalAlertSpy(...args),
            },
        }).module;
    },
});

vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: unknown) => {
        agentInputSpy(props);
        return React.createElement('AgentInput', props as Record<string, unknown>);
    },
}));

vi.mock('@/components/autocomplete/suggestions', () => ({
    getSuggestions: vi.fn(async () => []),
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunSend: (...args: Parameters<typeof sessionExecutionRunSendSpy>) => sessionExecutionRunSendSpy(...args),
    isExecutionRunNotRunningSendError: (...args: Parameters<typeof isExecutionRunNotRunningSendErrorSpy>) => isExecutionRunNotRunningSendErrorSpy(...args),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        submitMessage: (...args: Parameters<typeof syncSubmitMessageSpy>) => syncSubmitMessageSpy(...args),
    },
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => void promise,
}));

describe('SessionParticipantComposer', () => {
    beforeEach(() => {
        resetSessionActionsCommonModuleMockState();
        agentInputSpy.mockClear();
        modalAlertSpy.mockClear();
        syncSubmitMessageSpy.mockClear();
        sessionExecutionRunSendSpy.mockClear();
        isExecutionRunNotRunningSendErrorSpy.mockClear();
    });

    it('routes execution-run sends through sessionExecutionRunSend', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{ kind: 'execution_run', runId: 'run_1' }}
            executionRunDelivery="interrupt"
        />);

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onChangeText('Refine the current review');
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(sessionExecutionRunSendSpy).toHaveBeenCalledWith('s1', {
            runId: 'run_1',
            message: 'Refine the current review',
            delivery: 'interrupt',
        });
        expect(syncSubmitMessageSpy).not.toHaveBeenCalled();
    });

    it('routes agent-team sends through sync.submitMessage with participant meta', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{
                kind: 'agent_team_member',
                teamId: 'qa-team',
                memberId: 'alpha@qa-team',
                memberLabel: 'alpha',
            }}
        />);

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onChangeText('Please focus on regressions only');
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(syncSubmitMessageSpy).toHaveBeenCalledWith(
            's1',
            'Please focus on regressions only',
            undefined,
            expect.objectContaining({
                happier: expect.objectContaining({
                    kind: 'participant_message.v1',
                    payload: expect.objectContaining({
                        recipient: expect.objectContaining({
                            kind: 'agent_team_member',
                            teamId: 'qa-team',
                            memberId: 'alpha@qa-team',
                        }),
                    }),
                }),
            }),
            expect.objectContaining({
                callerSurface: 'participant_composer',
            }),
        );
        expect(sessionExecutionRunSendSpy).not.toHaveBeenCalled();
    });

    it('merges attached browser context metadata into participant message sends', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{
                kind: 'agent_team_member',
                teamId: 'qa-team',
                memberId: 'alpha@qa-team',
                memberLabel: 'alpha',
            }}
            browserContextState={createAttachedBrowserContextState()}
        />);

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onChangeText('Use the attached browser page');
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(syncSubmitMessageSpy).toHaveBeenCalledWith(
            's1',
            'Use the attached browser page',
            undefined,
            expect.objectContaining({
                happier: expect.objectContaining({
                    kind: 'participant_message.v1',
                }),
                happierBrowserContext: expect.objectContaining({
                    kind: 'browser_context.v1',
                    payload: expect.objectContaining({
                        contexts: [expect.objectContaining({
                            kind: 'browserPageReference',
                            url: 'https://preview.localhost.test/dashboard',
                        })],
                        attachments: [expect.objectContaining({
                            attachmentId: 'attachment_1',
                            state: 'available',
                        })],
                    }),
                }),
            }),
            expect.objectContaining({
                callerSurface: 'participant_composer',
            }),
        );
        expect(JSON.stringify(syncSubmitMessageSpy.mock.calls)).not.toContain('secret');
    });

    it('blocks participant sends when attached browser context is stale', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={null}
            browserContextState={createAttachedBrowserContextState({ stale: true })}
        />);

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onChangeText('This should wait for fresh context');
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(syncSubmitMessageSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'browserContext.composer.contextUnavailable');
    });

    it('blocks execution-run sends when browser context is attached because execution-run messages have no metadata channel', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{ kind: 'execution_run', runId: 'run_1' }}
            browserContextState={createAttachedBrowserContextState()}
        />);

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onChangeText('Use the browser page');
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(sessionExecutionRunSendSpy).not.toHaveBeenCalled();
        expect(syncSubmitMessageSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'browserContext.composer.contextUnavailable');
    });

    it('clears the focused execution-run recipient when the run is no longer running', async () => {
        sessionExecutionRunSendSpy.mockResolvedValueOnce({ ok: false, error: 'execution_run_not_running' });
        isExecutionRunNotRunningSendErrorSpy.mockReturnValueOnce(true);

        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');
        const onExecutionRunUnavailable = vi.fn();

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{ kind: 'execution_run', runId: 'run_1' }}
            onExecutionRunUnavailable={onExecutionRunUnavailable}
        />);

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onChangeText('Ping');
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(onExecutionRunUnavailable).toHaveBeenCalledTimes(1);
        expect(modalAlertSpy).toHaveBeenCalled();
    });

    it('passes extra action chips through to AgentInput', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');
        const extraActionChips = [{
            key: 'recipient',
            render: () => null,
        }] satisfies readonly AgentInputExtraActionChip[];

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{ kind: 'execution_run', runId: 'run_1' }}
            extraActionChips={extraActionChips}
        />);

        expect(agentInputSpy).toHaveBeenCalledWith(expect.objectContaining({
            extraActionChips,
        }));
    });
});
