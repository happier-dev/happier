import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { flattenTestStyle, renderScreen } from '@/dev/testkit';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { installSessionExecutionRunDetailsCommonModuleMocks } from './sessionExecutionRunDetailsTestHelpers';
import { ExecutionRunPublicStateSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionExecutionRunDetailsCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => ({
                    settings: {
                        acpCatalogSettingsV1: { v: 2, backends: [] },
                    },
                }),
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key, values) => {
                if (key.endsWith('.readOnly')) return 'Read only';
                if (key === 'session.subagents.intent.review') return 'Review';
                if (key === 'executionRuns.details.labels.backend' && values?.value) return `Backend: ${String(values.value)}`;
                if (key === 'executionRuns.details.labels.permissions' && values?.value) {
                    return `Permissions: ${String(values.value)}`;
                }
                if (key === 'executionRuns.details.labels.mode' && values?.value) return `Mode: ${String(values.value)}`;
                if (key === 'executionRuns.details.labels.runId' && values?.value) return `Run ID: ${String(values.value)}`;
                if (key === 'executionRuns.details.labels.statusValue' && values?.value) return `Status: ${String(values.value)}`;
                if (key === 'executionRuns.details.launchOrigin.discussion' && values?.discussionId) {
                    return `Started from discussion ${String(values.discussionId)}`;
                }
                if (key === 'executionRuns.details.titles.executionRunWithIntent' && values?.intent) {
                    return `${String(values.intent)} Subagent`;
                }
                return key;
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));
const clipboardWrites = vi.hoisted(() => [] as string[]);
vi.mock('expo-clipboard', () => ({
    setStringAsync: async (value: string) => { clipboardWrites.push(value); },
}));
vi.mock('@/components/ui/popover', () => ({
    Popover: (props: { open: boolean; children: React.ReactNode | ((input: { maxHeight: number; maxWidth: number }) => React.ReactNode) }) => {
        if (!props.open) return null;
        return React.createElement('Popover', null, typeof props.children === 'function'
            ? props.children({ maxHeight: 560, maxWidth: 400 })
            : props.children);
    },
}));
vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: { children: React.ReactNode }) => React.createElement('FloatingOverlay', null, props.children),
}));

const { SessionExecutionRunInfoCard } = await import('./SessionExecutionRunInfoCard');

/** The run's facts live behind ⋯ → Run details; open the menu and read the whole card. */
async function openRunMenu(screen: Awaited<ReturnType<typeof renderScreen>>): Promise<string> {
    await screen.pressByTestIdAsync('session-run-details-actions-menu');
    return JSON.stringify(screen.tree.toJSON());
}

describe('SessionExecutionRunInfoCard', () => {
    it('shows the host-resolved model instead of requested intent in the child summary', async () => {
        const screen = await renderScreen(<SessionExecutionRunInfoCard run={ExecutionRunPublicStateSchema.parse({
            runId: 'run_1', callId: 'call_1', sidechainId: 'side_1', intent: 'delegate',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived',
            ioMode: 'streaming', status: 'running', startedAtMs: 1,
            requestedConfiguration: { modelId: 'pending-model' },
            resolvedSelection: { source: 'inherited', modelSelection: {
                agentTargetKey: 'agent:codex', providerConnectionId: 'connection-parent', modelId: 'applied-model',
            } },
        })} />);
        expect(screen.getTextContent()).toContain('applied-model');
        expect(screen.getTextContent()).not.toContain('pending-model');
    });

    it('titles the conversation by its intent, with its status and the time it has been running', async () => {
        const startedAtMs = Date.now() - 72_000;
        {
            const screen = await renderScreen(<SessionExecutionRunInfoCard
                run={{
                    runId: 'run_1',
                    intent: 'delegate',
                    display: { title: 'Is 5 attempts enough during a deploy?' },
                    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                    requestedConfiguration: { modelId: 'gpt-6-luna' },
                    runClass: 'long_lived',
                    status: 'running',
                    startedAtMs,
                } as any}
                originTitle="Relay retry plan"
                hostSessionId="session_1"
            />);

            const text = screen.getTextContent();
            expect(screen.findByTestId('session-run-header.title')?.props.children).toBe('Is 5 attempts enough during a deploy?');
            expect(screen.findByTestId('session-run-header-mark')).not.toBeNull();
            expect(text).toContain('sessionAgentActivity.status.running');
            expect(screen.findByTestId('session-run-header-elapsed')?.props.children).toBe('1:12');
            expect(text).toContain('gpt-6-luna');
            expect(text).not.toContain('Run ID: run_1');
        }
    });

    it('says the conversation is waiting on you, in the roster words, instead of Running', async () => {
        const screen = await renderScreen(<SessionExecutionRunInfoCard
            run={{
                runId: 'run_1',
                intent: 'delegate',
                display: { title: 'Why does the sheet remount on rotate?' },
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                runClass: 'long_lived',
                status: 'running',
                startedAtMs: Date.now() - 6_000,
            } as any}
            attention={{ label: 'Needs your answer', variant: 'warning', description: 'Needs your answer' }}
        />);

        const text = screen.getTextContent();
        expect(text).toContain('Needs your answer');
        expect(text).not.toContain('sessionAgentActivity.status.running');
        // A person is the blocker, so no clock claims the agent is working.
        expect(screen.findByTestId('session-run-header-elapsed')).toBeNull();
    });

    it('puts Cancel run, the rare actions and the run facts, in words, under ⋯ (lab convo-C1)', async () => {
        const onStop = vi.fn();
        const onCancel = vi.fn();
        const onShowInTranscript = vi.fn();
        const screen = await renderScreen(<SessionExecutionRunInfoCard
            run={{
                runId: 'run_1',
                intent: 'review',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                permissionMode: 'read-only',
                runClass: 'bounded',
                ioMode: 'streaming',
                status: 'running',
                startedAtMs: 1,
            } as any}
            stopAction={{ stopping: false, onStop }}
            cancelResponseAction={{ pending: false, onCancel }}
            copyResultText="The fix is right for desktop."
            onShowInTranscript={onShowInTranscript}
        />);

        // The header carries no Stop of its own: cancelling is one of the menu's actions.
        expect(screen.findByTestId('session-run-details-stop')).toBeNull();
        await openRunMenu(screen);
        await screen.pressByTestIdAsync('session-run-details-stop');
        expect(onStop).toHaveBeenCalledTimes(1);
        const actionTarget = screen.findByTestId('session-run-details-actions-menu');
        expect(flattenTestStyle(actionTarget?.props.style)).toEqual(expect.objectContaining({
            minWidth: resolveMinimumInteractiveTargetSize('web'),
            minHeight: resolveMinimumInteractiveTargetSize('web'),
        }));
        // Nothing of the run's plumbing leads the page.
        expect(screen.getTextContent()).not.toContain('run_1');

        const menu = await openRunMenu(screen);
        // The run facts read as words, never as the wire's tokens.
        expect(menu).toContain('runPage.menu.finishesOnItsOwn');
        expect(menu).not.toContain('bounded');
        expect(menu).not.toContain('streaming');
        expect(screen.findByTestId('session-run-menu-fact-run')).not.toBeNull();
        expect(menu.indexOf('runPage.menu.kind')).toBeLessThan(menu.indexOf('run_1'));

        await screen.pressByTestIdAsync('session-run-details-cancel-turn');
        expect(onCancel).toHaveBeenCalledTimes(1);
        await openRunMenu(screen);
        await screen.pressByTestIdAsync('session-run-menu-copy-result');
        expect(clipboardWrites.at(-1)).toBe('The fix is right for desktop.');
        await openRunMenu(screen);
        await screen.pressByTestIdAsync('session-run-menu-show-in-transcript');
        expect(onShowInTranscript).toHaveBeenCalledTimes(1);
    });

    it('offers only the actions this run really has', async () => {
        const screen = await renderScreen(<SessionExecutionRunInfoCard
            run={{
                runId: 'run_1',
                intent: 'delegate',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                permissionMode: 'default',
                runClass: 'long_lived',
                ioMode: 'streaming',
                status: 'succeeded',
                startedAtMs: 1,
            } as any}
        />);
        const menu = await openRunMenu(screen);
        expect(screen.findByTestId('session-run-details-cancel-turn')).toBeNull();
        expect(screen.findByTestId('session-run-menu-copy-result')).toBeNull();
        expect(screen.findByTestId('session-run-menu-show-in-transcript')).toBeNull();
        expect(menu).toContain('runPage.menu.staysOpen');
    });

    it('offers Copy result and Send to the lead only once the run has finished', async () => {
        const onSend = vi.fn();
        const running = await renderScreen(<SessionExecutionRunInfoCard
            run={{
                runId: 'run_1', intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                runClass: 'bounded', status: 'running', startedAtMs: 1,
            } as any}
            sendToSession={{ sessionTitle: 'Payments v2 rollout', onSend }}
        />);
        await openRunMenu(running);
        // Named, but waiting: the result does not exist yet, so neither row acts.
        expect(running.findByTestId('session-run-menu-copy-result')).not.toBeNull();
        expect(running.findByTestId('session-run-menu-send-to-session')).not.toBeNull();
        expect(running.getTextContent()).toContain('agentStart.pane.whenItFinishes');
        await running.pressByTestIdAsync('session-run-menu-send-to-session');
        expect(onSend).not.toHaveBeenCalled();

        const finished = await renderScreen(<SessionExecutionRunInfoCard
            run={{
                runId: 'run_2', intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                runClass: 'bounded', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2,
            } as any}
            copyResultText="Checkpoint per batch; resume from the last one."
            sendToSession={{ sessionTitle: 'Payments v2 rollout', onSend }}
        />);
        await openRunMenu(finished);
        await finished.pressByTestIdAsync('session-run-menu-send-to-session');
        expect(onSend).toHaveBeenCalledWith('Checkpoint per batch; resume from the last one.');
    });

    it('says how long a finished run took and its permissions in words', async () => {
        const screen = await renderScreen(<SessionExecutionRunInfoCard
            run={{
                runId: 'run_1',
                intent: 'review',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                permissionMode: 'read-only',
                runClass: 'bounded',
                ioMode: 'request_response',
                status: 'succeeded',
                startedAtMs: 1_700_000_000_000,
                finishedAtMs: 1_700_000_400_000,
            } as any}
        />);
        expect(screen.findByTestId('session-run-header-elapsed')?.props.children).toBe('6:40');
        const facts = screen.findByTestId('session-run-header.subtitle');
        expect(facts).not.toBeNull();
        expect(screen.getTextContent()).toContain('Read only');
        expect(screen.getTextContent()).not.toContain('read-only');
    });

    it('renders a user-facing title and labeled facts instead of a raw run-id header', async () => {
        const screen = await renderScreen(
            <SessionExecutionRunInfoCard
                run={{
                    runId: 'run_1',
                    callId: 'toolu_1',
                    sidechainId: 'toolu_1',
                    intent: 'review',
                    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                    permissionMode: 'safe_yolo',
                    runClass: 'bounded',
                    ioMode: 'streaming',
                    status: 'running',
                    startedAtMs: 1,
                } as any}
                daemonProcessLine="pid 123"
            />,
        );

        // Titled by what it is for, never by its id.
        expect(screen.findByTestId('session-run-header.title')?.props.children).toBe('runPage.intentTitles.review');
        const menu = await openRunMenu(screen);
        expect(menu).toContain('run_1');
        expect(menu).toContain('pid 123');
    });

    it('labels canonical V2 backend targets in the same user-facing way', async () => {
        const tree = (await renderScreen(
            <SessionExecutionRunInfoCard
                run={{
                    runId: 'run_2',
                    callId: 'toolu_2',
                    sidechainId: 'toolu_2',
                    intent: 'review',
                    backendTarget: {
                        kind: 'backend',
                        backendId: 'review-bot',
                        configuredBackendId: 'review-bot',
                        sourceKind: 'configured',
                    } as any,
                    permissionMode: 'safe_yolo',
                    runClass: 'bounded',
                    ioMode: 'streaming',
                    status: 'running',
                    startedAtMs: 1,
                } as any}
                daemonProcessLine="pid 123"
            />,
        )).tree;

        const text = JSON.stringify(tree!.toJSON());
        expect(text).toContain('runPage.intentTitles.review');
        expect(text).toContain('review-bot');
    });

    it('renders Discussion launch provenance without presenting it as execution authority', async () => {
        const tree = (await renderScreen(
            <SessionExecutionRunInfoCard
                run={{
                    runId: 'run_discussion',
                    callId: 'toolu_discussion',
                    sidechainId: 'toolu_discussion',
                    intent: 'delegate',
                    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                    launchOrigin: {
                        kind: 'session_discussion',
                        sessionId: 'session_1',
                        discussionId: 'discussion_1',
                        messageIds: ['message_1'],
                    },
                    permissionMode: 'safe_yolo',
                    runClass: 'long_lived',
                    ioMode: 'streaming',
                    status: 'running',
                    startedAtMs: 1,
                } as any}
                hostSessionId="session_1"
            />,
        )).tree;

        const text = JSON.stringify(tree!.toJSON());
        // Where it came from, in words; never the raw discussion id.
        expect(text).toContain('sessionConversation.origin.fromUntitled');
        expect(text).not.toContain('discussion_1');
        expect(text).not.toContain('acting as');
    });

    it('shows no finish time for a run whose finish was never recorded, instead of 1 January 1970', async () => {
        const render = async (finishedAtMs: number) => (await renderScreen(
            <SessionExecutionRunInfoCard
                run={{
                    runId: 'run_4',
                    callId: 'toolu_4',
                    sidechainId: 'toolu_4',
                    intent: 'review',
                    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                    permissionMode: 'safe_yolo',
                    runClass: 'bounded',
                    ioMode: 'streaming',
                    status: 'succeeded',
                    startedAtMs: 1_700_000_000_000,
                    finishedAtMs,
                } as any}
            />,
        ));

        // The derivations fall back to a history row's creation instant, which is itself 0 when the
        // row carries none — so a 0 finish reaches this card the same way a 0 start does, and no
        // duration is made up from it.
        expect((await render(0)).findByTestId('session-run-header-elapsed')).toBeNull();
        expect((await render(1_700_000_016_000)).findByTestId('session-run-header-elapsed')?.props.children).toBe('0:16');
    });

    it('shows no start time for a run whose start was never recorded, instead of 1 January 1970', async () => {
        const render = async (startedAtMs: number) => openRunMenu(await renderScreen(
            <SessionExecutionRunInfoCard
                run={{
                    runId: 'run_3',
                    callId: 'toolu_3',
                    sidechainId: 'toolu_3',
                    intent: 'review',
                    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                    permissionMode: 'safe_yolo',
                    runClass: 'bounded',
                    ioMode: 'streaming',
                    status: 'succeeded',
                    startedAtMs,
                } as any}
            />,
        ));

        // `startedAtMs` is required on the wire, so an unrecorded start arrives as the 0 sentinel —
        // and `new Date(0)` prints an epoch date as though it were an observed fact.
        expect(await render(0)).not.toContain('runPage.menu.started');
        // A genuinely recorded start is still shown.
        expect(await render(1_700_000_000_000)).toContain('runPage.menu.started');
    });
});


it('retains idle long-lived run controls without showing a live elapsed clock', async () => {
    const { ExecutionRunPublicStateSchema } = await import('@happier-dev/protocol');
    const run = ExecutionRunPublicStateSchema.parse({
        runId: 'idle', callId: 'call-idle', sidechainId: 'sidechain-idle', intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'default',
        retentionPolicy: 'ephemeral', runClass: 'long_lived', ioMode: 'streaming', status: 'running',
        turnInFlight: false, startedAtMs: Date.now() - 72_000,
    });
    const screen = await renderScreen(<SessionExecutionRunInfoCard run={run} stopAction={{ stopping: false, onStop: () => {} }} />);
    expect(screen.findAllHostsByTestId('session-run-header-elapsed')).toHaveLength(0);
    expect(screen.getTextContent()).toContain('diagnosis.machineRuns.idle');
    const { ExecutionRunRow } = await import('../ExecutionRunRow');
    const row = await renderScreen(<ExecutionRunRow run={run} />);
    expect(row.getTextContent()).toContain('diagnosis.machineRuns.idle');
});
