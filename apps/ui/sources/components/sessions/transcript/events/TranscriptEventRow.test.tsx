import { StyleSheet } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_FOLLOW_WAKE_EVENT_MESSAGE } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';

import { renderScreen } from '@/dev/testkit';
import { setPreferredLanguageFromSettings, t } from '@/text';
import { normalizeRawMessage, RawRecordSchema, type AgentEvent } from "@happier-dev/session-core/raw";

import { TranscriptEventRow, TranscriptFollowSourceAction, TranscriptFollowSourceNotice } from './TranscriptEventRow';
import { SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { WorkerUpdateCard } from '@/components/sessions/work/WorkerUpdateCard';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { act } from 'react-test-renderer';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { storage } from '@/sync/domains/state/storageStore';

const executeDefaultAction = vi.fn();
const modalConfirm = vi.fn();
const modalAlert = vi.fn();
const workerUpdateRouter = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: workerUpdateRouter.push } }).module;
});

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({
        execute: (...args: unknown[]) => executeDefaultAction(...args),
    }),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            confirm: (...args: unknown[]) => modalConfirm(...args),
            alert: (...args: unknown[]) => modalAlert(...args),
        },
    }).module;
});

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

describe('TranscriptEventRow', () => {
    it('retains canonical MCP accounting evidence without displaying it as an unknown conversation event', async () => {
        // The host projector commits this canonical event; usageWorkEvidence consumes
        // it independently of the transcript presentation.
        const raw = RawRecordSchema.parse({ role: 'agent', content: { type: 'event', id: 'mcp-window', data: {
            type: 'mcp-binding-usage', usage: {
                v: 1, evidenceId: 'mcp-window', sessionId: 'session-1', turnId: 'turn-1', observedAtMs: 200,
                window: { startMs: 100, endMs: 200 }, coverage: 'complete',
                bindings: [{ serverId: 'server', bindingId: 'binding', serverRevision: 10, bindingRevision: 20,
                    catalogRevision: 40, toolCallCount: 0, schemaBytes: null }],
            },
        } } });
        const normalized = normalizeRawMessage('mcp-window', null, 200, raw);
        expect(normalized?.role).toBe('event');
        if (normalized?.role !== 'event') throw new Error('Expected the retained accounting event');
        const screen = await renderScreen(<TranscriptEventRow event={normalized.content} />);
        expect(screen.getTextContent()).toBe('');
        const future = await renderScreen(<TranscriptEventRow event={{ type: 'future-event' } as unknown as AgentEvent} />);
        expect(future.getTextContent()).toContain(t('message.unknownEvent'));
        await screen.unmount();
        await future.unmount();
    });
    it('does not describe a terminal policy decision as a user cancellation', async () => {
        const screen = await renderScreen(<TranscriptEventRow event={{
            type: 'connected-service-runtime-auth-recovery',
            status: 'cancelled', serviceId: 'happier.agent.claude/claude-subscription', profileId: 'work',
            terminal: true, reason: 'switch_reason_disabled',
        }} />);
        expect(screen.getTextContent()).not.toContain(t('message.connectedServiceRuntimeAuthRecoveryCancelled'));
        expect(screen.getTextContent()).toContain(t('message.connectedServiceRuntimeAuthRecoveryStopped'));
        expect(screen.findByTestId('transcript-event-connected-service-runtime-auth-recovery')).toBeTruthy();
    });
    it('keeps a guard stop intent quiet without claiming exit or freed memory before current settlement', async () => {
        const event = { type: 'message', message: 'Happier requested this session to stop. Resume it after it stops to continue.',
            sessionStopV1: { v: 1, status: 'requested', at: new Date(2026, 9, 10, 13, 40).getTime(), rule: 'idle_sessions', idleMs: 7_200_000, freedBytes: 820 * 1024 ** 2 } };
        const screen = await renderScreen(<TranscriptEventRow event={event as AgentEvent} sessionId="stopped" />);
        expect(screen.findByTestId('transcript-event-session-stop')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Stop requested');
        expect(screen.getTextContent()).not.toContain('freed');
        expect(screen.getTextContent()).not.toContain('Resume it after it stops');
    });

    it('lets a stop marker that arrives now rise in, and shows one met again in history at once', async () => {
        const marker = (at: number) => ({ type: 'message', message: 'requested', sessionStopV1: { v: 1, status: 'requested', at, rule: 'memory_guard' } }) as unknown as AgentEvent;
        const fresh = await renderScreen(<TranscriptEventRow event={marker(Date.now())} sessionId="fresh" />);
        expect(fresh.findAll(node => node.props?.testID === 'transcript-event-session-stop' && node.props?.entering !== undefined)).not.toHaveLength(0);
        const old = await renderScreen(<TranscriptEventRow event={marker(Date.now() - 3_600_000)} sessionId="old" />);
        expect(old.findAll(node => node.props?.testID === 'transcript-event-session-stop' && node.props?.entering !== undefined)).toHaveLength(0);
        expect(old.findByTestId('transcript-event-session-stop')).not.toBeNull();
    });

    it('renders a worker publish summary in its own transcript without lead controls', async () => {
        const summary = 'Implemented the requested fix; the focused check passed.';
        const screen = await renderScreen(<TranscriptEventRow event={{ type: 'worker-report', summary }} sessionId="worker" />);

        expect(screen.getTextContent()).toContain(summary);
        expect(screen.findByTestId('worker-update-inspect')).toBeNull();
        expect(screen.findByTestId('transcriptEvent.clearTerminalComposer')).toBeNull();
    });
    it('says a Goal changed in one quiet line without claiming any Goal content', async () => {
        const screen = await renderScreen(<TranscriptEventRow event={{ type: 'goal-changed' }} sessionId="lead" />);

        expect(screen.getTextContent()).toBe(t('message.goalChanged'));
        expect(screen.getTextContent()).not.toContain(t('message.unknownEvent'));
        await screen.unmount();
    });
    it.each([
        { pointer: { kind: 'session', sessionId: 'worker', seq: 7 } as const, expected: '/session/worker?serverId=home-b' },
        { pointer: { kind: 'execution_run', sessionId: 'worker', runId: 'run_1' } as const, expected: '/session/worker/runs/run_1?serverId=home-b' },
        { pointer: { kind: 'workflow_run', runId: 'workflow_1' } as const, expected: '/workflows/runs/workflow_1?serverId=home-b' },
    ])('opens an authorized worker pointer within its Home: $pointer.kind', async ({ pointer, expected }) => {
        const update = {
            v: 1, workerKind: 'session', workerId: 'worker', ownerState: 'published', wake: 'published',
            headline: 'Worker report', result: 'Ready for inspection', canInspect: true,
            transcriptPointer: pointer,
        } as const;
        const screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId="lead" serverId="home-b">
            <TranscriptEventRow event={{ type: 'worker-update', update }} serverId="home-b" />
        </AppSessionTranscriptSourceProvider>);
        await screen.pressByTestIdAsync('worker-update-inspect');
        expect(workerUpdateRouter.push).toHaveBeenCalledWith(expected);
    });

    it('keeps a worker pointer read-only on a public transcript', async () => {
        const screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId="lead" serverId="home-b"><TranscriptEventRow navigationEnabled={false} event={{ type: 'worker-update', update: {
            v: 1, workerKind: 'session', workerId: 'worker', ownerState: 'settled', wake: 'finished',
            headline: 'Finished', result: 'Result', canInspect: true,
            transcriptPointer: { kind: 'session', sessionId: 'worker' },
        } }} /></AppSessionTranscriptSourceProvider>);
        expect(screen.findByTestId('worker-update:worker')).not.toBeNull();
        expect(screen.findByTestId('worker-update-inspect')).toBeNull();
    });
    describe('queued Follow source notice', () => {
        const needsYou = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'next_turn',
            original: { sourceSessionId: 'worker', sourceRequests: { agentStateVersion: 3, requests: [{ requestId: 'perm-1', createdAt: 10 }] } },
            requestEvents: [{ requestId: 'perm-1', event: { kind: 'needs_you', type: 'approval' } }] });
        const finished = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'next_turn',
            original: { sourceSessionId: 'worker', sourceTurn: { id: 'turn-1', status: 'completed' } },
            event: { kind: 'finished' } });
        const render = (followInput: typeof needsYou) => renderScreen(<AppSessionTranscriptSourceProvider sessionId="lead" serverId="home-b">
            <TranscriptFollowSourceNotice followInput={followInput} messageId="pending-1" sessionId="lead" serverId="home-b" createdAt={1} />
            <TranscriptFollowSourceAction followInput={followInput} serverId="home-b" testID="open" />
        </AppSessionTranscriptSourceProvider>);

        it('tells a stopped lead that the worker needs the person and opens that worker', async () => {
            const screen = await render(needsYou);
            expect(screen.getTextContent()).toContain(t('message.provenanceFrom', { source: t('message.provenanceSession') }));
            expect(screen.getTextContent()).toContain(t('sessionWork.workerUpdate.state.needsYou'));
            expect(screen.getTextContent()).toContain(t('runs.openSession'));
            await screen.pressByTestIdAsync('open');
            expect(workerUpdateRouter.push).toHaveBeenCalledWith('/session/worker?serverId=home-b');
        });

        it('keeps an ordinary queued Follow as source identity alone', async () => {
            const screen = await render(finished);
            expect(screen.getTextContent()).toContain(t('message.provenanceFrom', { source: t('message.provenanceSession') }));
            expect(screen.getTextContent()).not.toContain(t('sessionWork.workerUpdate.state.needsYou'));
            expect(screen.getTextContent()).not.toContain(t('runs.openSession'));
        });
    });
    it('opens a context-only wake with one host row that says it is not a message from you', async () => {
        const update = {
            v: 1, workerKind: 'session', workerId: 'worker', ownerState: 'settled', wake: 'finished',
            headline: 'Finished', result: 'Result', canInspect: false,
        } as const;
        const first = await renderScreen(<AppSessionTranscriptSourceProvider sessionId="lead" serverId="home-b">
            <TranscriptEventRow hostWakeCount={3} event={{ type: 'worker-update', update }} />
        </AppSessionTranscriptSourceProvider>);
        const wake = first.findByTestId('transcript-event-host-wake');
        expect(wake).not.toBeNull();
        expect(first.getTextContent()).toContain(t('sessionWork.workerUpdate.wokenBy', { count: 3 }));
        expect(first.getTextContent()).toContain(t('sessionWork.workerUpdate.notFromYou'));
        expect(first.findByTestId('worker-update:worker')).not.toBeNull();

        const follower = await renderScreen(<AppSessionTranscriptSourceProvider sessionId="lead" serverId="home-b">
            <TranscriptEventRow event={{ type: 'worker-update', update }} />
        </AppSessionTranscriptSourceProvider>);
        expect(follower.findByTestId('transcript-event-host-wake')).toBeNull();
        expect(follower.findByTestId('worker-update:worker')).not.toBeNull();
    });
    it('binds each card to its own admitted Follow reason and accepted delivery evidence', async () => {
        const update = { v: 1, workerKind: 'session', workerId: 'worker', ownerState: 'settled',
            wake: 'finished', headline: 'Finished', canInspect: false } as const;
        const render = async (followMatches: { kind: 'relation'; relation: 'manager' | 'follower' }[] | undefined,
            delivery: { status: 'woke' | null; reason: null }) => renderScreen(
            <AppSessionTranscriptSourceProvider sessionId="lead" serverId="home-b">
                <TranscriptEventRow event={{ type: 'worker-update', update, ...(followMatches ? { followMatches } : {}) }}
                    followDeliveryProjection={delivery} />
            </AppSessionTranscriptSourceProvider>);
        const manager = await render([{ kind: 'relation', relation: 'manager' }], { status: 'woke', reason: null });
        const unknown = await render([{ kind: 'relation', relation: 'follower' }], { status: null, reason: null });
        expect(manager.findAll(node => node.type === WorkerUpdateCard)[0]?.props).toMatchObject({
            followMatches: [{ kind: 'relation', relation: 'manager' }], delivery: { status: 'woke', reason: null },
        });
        expect(unknown.findAll(node => node.type === WorkerUpdateCard)[0]?.props).toMatchObject({
            followMatches: [{ kind: 'relation', relation: 'follower' }], delivery: { status: null, reason: null },
        });
    });
    it('renders a host worker update as a card with its effective engine and result', async () => {
        const screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId="lead" serverId="home-b"><TranscriptEventRow event={{
            type: 'worker-update', update: {
                v: 1, workerKind: 'execution_run', workerId: 'run_new', ownerState: 'failed',
                wake: 'finished', engine: { agentId: 'codex', modelId: 'effective-model' },
                headline: 'Verification failed', result: 'A regression needs attention.', canInspect: false,
                truncated: true, transcriptPointer: { kind: 'execution_run', sessionId: 'worker', runId: 'run_new' },
            },
        }} /></AppSessionTranscriptSourceProvider>);
        expect(screen.findByTestId('worker-update:run_new')).not.toBeNull();
        expect(screen.findByTestId('worker-update-result')?.props.children).toBe('A regression needs attention.');
        expect(screen.findByTestId('worker-update-engine')?.children.join('')).toContain('effective-model');
        expect(screen.findByTestId('worker-update-pointer')).toBeNull();
        expect(screen.getTextContent()).not.toContain('run_new');
        expect(screen.findByTestId('worker-update-truncated')).not.toBeNull();
        expect(screen.findByTestId('worker-update-inspect')).toBeNull();
    });
    beforeEach(() => {
        executeDefaultAction.mockReset();
        executeDefaultAction.mockResolvedValue({ ok: true, result: { ok: true, status: 'cleared', sessionId: 's1' } });
        modalConfirm.mockReset();
        modalConfirm.mockResolvedValue(true);
        modalAlert.mockReset();
        workerUpdateRouter.push.mockReset();
    });

    it('visually de-emphasizes a prior-era event without muting a current-era event', async () => {
        const event = {
            type: 'runtime-config-outcome',
            provider: 'claude',
            runtime: 'claude-unified-terminal',
            status: 'failed',
            message: 'Failed to apply runtime controls.',
            changes: [
                { key: 'reasoningEffort', requested: 'medium', reason: 'not_delivered' },
            ],
        } as AgentEvent;

        const priorEra = await renderScreen(
            <TranscriptEventRow event={event} emphasis="deemphasized" />,
        );
        const currentEra = await renderScreen(<TranscriptEventRow event={event} />);

        const priorEraRow = priorEra.findByProps({ testID: 'transcript-event-runtime-config-outcome-failed' });
        const currentEraRow = currentEra.findByProps({ testID: 'transcript-event-runtime-config-outcome-failed' });

        expect(StyleSheet.flatten(priorEraRow.props.style)?.opacity).toBeLessThan(1);
        expect(StyleSheet.flatten(currentEraRow.props.style)?.opacity).toBeUndefined();
    });

    it('offers to clear the terminal composer for typed terminal draft blocked events', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                serverId="home-b"
                sessionId="s1"
                event={{
                    type: 'terminal-composer-draft-blocked',
                    reason: 'idle_draft_guard',
                    stateAtMs: 1234,
                    message: 'Terminal draft blocked delivery.',
                } as unknown as AgentEvent}
            />,
        );

        expect(screen.findByProps({ testID: 'transcript-event-terminal-composer-draft-blocked' })).toBeTruthy();
        expect(screen.findByTestId('transcriptEvent.clearTerminalComposer')).toBeTruthy();

        await screen.pressByTestIdAsync('transcriptEvent.clearTerminalComposer');

        expect(modalConfirm).not.toHaveBeenCalled();
        expect(executeDefaultAction).toHaveBeenCalledWith(
            'session.terminalComposer.clear',
            { sessionId: 's1', expectedStateAtMs: 1234 },
            { defaultSessionId: 's1', serverId: 'home-b', surface: 'ui', placement: 'pending_messages' },
        );
        expect(modalAlert).not.toHaveBeenCalled();
    });

    it('offers to clear the terminal composer for legacy passive terminal draft notices', async () => {
        const legacyMessages = [
            "Your queued message can't steer the running turn: the terminal composer holds an unsent draft. Clear the draft in the terminal (or interrupt the turn) to deliver it.",
            'Your queued message is waiting: the terminal composer holds an unsent draft. Clear the draft in the terminal to deliver it.',
        ];

        for (const message of legacyMessages) {
            const screen = await renderScreen(
                <TranscriptEventRow
                    sessionId="s1"
                    event={{ type: 'message', message }}
                />,
            );

            expect(screen.findByTestId('transcriptEvent.clearTerminalComposer')).toBeTruthy();
        }
    });

    it('localizes the Follow wake explanation and leaves every other message event verbatim', async () => {
        // Asserted in a non-English locale on purpose: the English copy and the
        // persisted Protocol marker read the same sentence, so an `en` assertion
        // would pass against a row that just echoes the stored English string.
        setPreferredLanguageFromSettings('es');
        try {
            const wake = await renderScreen(
                <TranscriptEventRow
                    sessionId="s1"
                    event={{ type: 'message', message: SESSION_FOLLOW_WAKE_EVENT_MESSAGE }}
                />,
            );
            expect(wake.getTextContent()).toContain(t('session.follow.wakeEventExplanation'));
            expect(wake.getTextContent()).not.toContain(SESSION_FOLLOW_WAKE_EVENT_MESSAGE);

            const other = await renderScreen(
                <TranscriptEventRow
                    sessionId="s1"
                    event={{ type: 'message', message: 'A host-authored note.' }}
                />,
            );
            expect(other.getTextContent()).toContain('A host-authored note.');
        } finally {
            setPreferredLanguageFromSettings(null);
        }
    });

    it('does not offer terminal composer clearing when the transcript row has no session id', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'terminal-composer-draft-blocked',
                    reason: 'idle_draft_guard',
                    stateAtMs: 1234,
                    message: 'Terminal draft blocked delivery.',
                } as unknown as AgentEvent}
            />,
        );

        expect(screen.findByTestId('transcriptEvent.clearTerminalComposer')).toBeNull();
    });

    it('renders structured context compaction events', async () => {
        const started = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'context-compaction',
                    phase: 'started',
                    lifecycleId: 'pi:context-compaction',
                    provider: 'pi',
                }}
            />,
        );

        expect(started.findByProps({ testID: 'transcript-event-context-compaction-started' })).toBeTruthy();

        const completed = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'context-compaction',
                    phase: 'completed',
                    lifecycleId: 'pi:context-compaction',
                    agentId: 'pi',
                }}
            />,
        );

        expect(completed.findByProps({ testID: 'transcript-event-context-compaction-completed' })).toBeTruthy();

        const paused = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'context-compaction',
                    phase: 'completed',
                    lifecycleId: 'pi:context-compaction',
                    provider: 'pi',
                    continuation: 'paused',
                    pauseReason: 'agent-idle-after-compaction',
                }}
            />,
        );

        expect(paused.findByProps({ testID: 'transcript-event-context-compaction-paused' })).toBeTruthy();
    });

    it('renders structured connected-service account switch events', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch',
                    serviceId: 'openai-codex',
                    groupId: 'codex-main',
                    groupLabel: 'Happier',
                    fromProfileId: 'work',
                    toProfileId: 'backup',
                    fromProfileLabel: 'team@happier.dev',
                    toProfileLabel: 'leeroy.brun@gmail.com',
                    reason: 'usage_limit',
                    mode: 'hot_apply',
                    effectiveRemainingPct: 12,
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'session-event-connected-service-account-switch' })).toBeTruthy();
        expect(serialized).toContain('Switched ChatGPT group Happier from team@happier.dev to leeroy.brun@gmail.com');
        expect(serialized).not.toContain('from group');
        expect(serialized).not.toContain('to profile');
    });

    it('renders a normalized switch through the captured Account profile and current device privacy', async () => {
        const browserStorage = installLocalStorageMock();
        const browserLocks = installWebLockManagerMock();
        const initial = storage.getState();
        let row: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            const target = await upsertAndActivateServer({ serverUrl: 'https://transcript-account-names.test', scope: 'tab' });
            await setServerProfileIdentityForUrl(target.serverUrl, 'srv_transcript_account_names');
            const owner = 'transcript-account-owner';
            expect(await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id },
                { token: createAccountTokenForTests(owner, { currentAccount: true }) })).toBe(true);
            const scope = { serverId: target.id, accountId: owner };
            const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
            storage.getState().activateProfileScope(scope);
            storage.getState().applyProfileForScope(scope, { ...profileDefaults, id: owner, connectedAccountsV4:
                [{ accountId: 'work-routing-id', email: 'work@example.com', displayName: 'Same name' },
                    { accountId: 'personal-routing-id', email: 'personal@example.com', displayName: 'Same name' },
                    { accountId: 'backup-routing-id', email: 'backup@example.com', displayName: 'Happier' }]
                    .map(({ accountId, email, displayName }) => ({ ref: { service, accountId }, displayName,
                        providerIdentity: { email }, status: 'connected' as const, authenticationModeId: 'oauth',
                        revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz',
                        configurationReady: true, configurationRevision: null, scopes: [] })) });
            const reads: string[] = [];
            setRuntimeFetch(async input => {
                const path = new URL(String(input)).pathname;
                reads.push(path);
                if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                if (path.startsWith('/v1/account/entity-rows/connected-metadata/')) return Response.json({
                    status: 'present', revision: 0, content: { t: 'plain', v: { v: 1, entries: [] } },
                });
                return Response.json({ error: 'not_found' }, { status: 404 });
            });
            const raw = RawRecordSchema.parse({ role: 'agent', content: { type: 'event', id: 'switch-accounts', data: {
                type: 'connected-service-account-switch', serviceId: 'happier.agent.codex/openai-codex', groupId: null,
                fromProfileId: 'work-routing-id', toProfileId: 'backup-routing-id', reason: 'manual', mode: 'hot_apply',
            } } });
            const normalized = normalizeRawMessage('switch-accounts', null, 200, raw);
            if (normalized?.role !== 'event') throw new Error('Expected the normalized account switch');
            storage.getState().applyLocalSettings({ hideConnectedAccountIdentities: false });
            row = await renderScreen(<TranscriptEventRow event={normalized.content} serverId={target.id} />);
            expect(row.getTextContent()).toContain('from Same name · work@example.com to Happier');
            expect(row.getTextContent()).not.toContain('routing-id');
            await act(async () => storage.getState().applyLocalSettings({ hideConnectedAccountIdentities: true }));
            expect(row.getTextContent()).toContain('from Same name · wo•••@e•••.com to Happier');
            expect(row.getTextContent()).not.toContain('@example.com');
            expect(reads.filter(path => path === '/v1/account/profile' || path.includes('/machines/') || path.includes('/rpc'))).toHaveLength(0);
        } finally {
            await row?.unmount();
            retireActiveServerAccountScopeLifetime();
            resetRuntimeFetch();
            invalidateAccountEncryptionModeCache();
            storage.setState({ profile: initial.profile, profileScope: initial.profileScope });
            storage.getState().applyLocalSettings({ hideConnectedAccountIdentities: initial.localSettings.hideConnectedAccountIdentities });
            browserLocks.restore(); browserStorage.restore();
        }
    });

    it('renders event-carried switch selection labels instead of raw profile ids (P7 identity display)', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch',
                    serviceId: 'claude-subscription',
                    groupId: 'team-pool',
                    fromProfileId: 'batiplus',
                    toProfileId: 'batiplus',
                    fromProfileLabel: 'leeroy',
                    toProfileLabel: 'leeroy',
                    reason: 'usage_limit',
                    mode: 'restart_resume',
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'session-event-connected-service-account-switch' })).toBeTruthy();
        expect(serialized).toContain('leeroy');
        expect(serialized).not.toContain('batiplus');
    });

    it('renders native connected-service account switch sides without leaking null labels', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch',
                    serviceId: 'openai-codex',
                    groupId: 'happier',
                    fromProfileId: null,
                    toProfileId: 'team',
                    reason: 'manual',
                    mode: 'restart_resume',
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        const nativeLabel = t('connectedServices.authModal.nativeAuthTitle');
        expect(screen.findByProps({ testID: 'session-event-connected-service-account-switch' })).toBeTruthy();
        expect(serialized).toContain(nativeLabel);
        expect(serialized).not.toContain('from null');
    });

    it('renders structured provider quota wait and recovered events', async () => {
        const waiting = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'agent-quota-wait',
                    serviceId: 'openai-codex',
                    profileId: 'work',
                    groupId: 'codex-main',
                    resetAtMs: 1_000,
                    reason: 'usage_limit',
                }}
            />,
        );

        expect(waiting.findByProps({ testID: 'transcript-event-agent-quota-wait' })).toBeTruthy();

        const recovered = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'agent-quota-recovered',
                    serviceId: 'openai-codex',
                    profileId: 'work',
                    groupId: 'codex-main',
                    reason: 'reset_confirmed',
                }}
            />,
        );

        expect(recovered.findByProps({ testID: 'transcript-event-agent-quota-recovered' })).toBeTruthy();
    });

    it('explains a restart policy refusal in the transcript', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow event={{
                type: 'connected-service-account-switch-attempt',
                ok: false,
                action: 'restart_requested',
                errorCode: 'restart_disallowed_by_execution_policy',
            }} />,
        );
        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(serialized).not.toContain(t('connectedServices.authSwitch.switchFailed'));
        expect(serialized).toContain('restart_disallowed_by_execution_policy');
    });

    it('O1: renders connected-service-account-switch-attempt events without falling back to Unknown event', async () => {
        const okRestart = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-attempt',
                    ok: true,
                    action: 'restart_requested',
                }}
            />,
        );
        expect(okRestart.findByProps({ testID: 'transcript-event-connected-service-account-switch-attempt' })).toBeTruthy();
        expect(JSON.stringify(okRestart.tree.toJSON())).not.toContain('Unknown event');

        const failed = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-attempt',
                    ok: false,
                    action: 'restart_requested',
                    errorCode: 'provider_session_state_unavailable_for_resume',
                }}
            />,
        );
        expect(failed.findByProps({ testID: 'transcript-event-connected-service-account-switch-attempt' })).toBeTruthy();
        expect(JSON.stringify(failed.tree.toJSON())).not.toContain('Unknown event');
    });

    it('renders direct live switch attempts without restart copy', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-attempt',
                    ok: true,
                    action: 'hot_applied',
                    attemptedContinuityMode: 'hot_apply',
                    outcome: 'succeeded',
                    outcomeAction: 'hot_applied',
                    partialState: 'runtime_auth_applied',
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch-attempt' })).toBeTruthy();
        expect(serialized).toContain('Authentication switched in the running session');
        expect(serialized).not.toContain('Restarting session');
        expect(serialized).not.toContain('Switch authentication');
    });

    it('renders credential refresh or recycle attempts distinctly from restart-resume', async () => {
        const credentialRefresh = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-attempt',
                    ok: true,
                    action: 'hot_applied',
                    attemptedContinuityMode: 'credential_refresh',
                    outcome: 'succeeded',
                    outcomeAction: 'credential_refreshed',
                    partialState: 'runtime_auth_applied',
                }}
            />,
        );
        const restartResume = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-attempt',
                    ok: true,
                    action: 'restart_requested',
                    attemptedContinuityMode: 'restart',
                    outcome: 'succeeded',
                    outcomeAction: 'restarted',
                    groupGeneration: 2,
                    sessionAdoption: 'applied',
                }}
            />,
        );

        const refreshSerialized = JSON.stringify(credentialRefresh.tree.toJSON());
        const restartSerialized = JSON.stringify(restartResume.tree.toJSON());
        expect(refreshSerialized).toContain('Authentication refreshed');
        expect(refreshSerialized).not.toContain('Restarting session');
        expect(restartSerialized).toContain('Restarting session');
    });

    it('renders connected-service account switch attempt diagnostics through the shared presentation mapping', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-attempt',
                    ok: false,
                    action: 'hot_applied',
                    errorCode: 'provider_account_adoption_mismatch',
                    diagnostic: {
                        code: 'provider_account_adoption_mismatch',
                        failurePhase: 'post_switch_verification',
                        source: 'transcript_switch_attempt',
                        serviceId: 'openai-codex',
                        agentId: 'codex',
                        retryable: true,
                        suggestedActions: ['retry', 'open_connected_accounts'],
                    },
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch-attempt' })).toBeTruthy();
        expect(serialized).toContain(t('connectedServices.diagnostics.status.provider_account_adoption_mismatch'));
        expect(serialized).not.toContain('provider_account_adoption_mismatch)');
    });

    it.each(['hot_apply_failed', 'live_hot_auth_failed'])('presents switch failure recovery without exposing raw codes (%s)', async (errorCode) => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-attempt',
                    ok: false,
                    action: 'hot_applied',
                    outcome: 'failed',
                    outcomeAction: 'none',
                    errorCode,
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch-attempt' })).toBeTruthy();
        expect(serialized).toContain(t(errorCode === 'hot_apply_failed'
            ? 'connectedServices.authSwitch.errors.hotApplyFailed'
            : 'connectedServices.authSwitch.switchFailed'));
        expect(serialized).not.toContain(`(${errorCode})`);
        expect(serialized).not.toContain(t('message.unknownEvent'));
    });

    it('renders observed-only switch attempts as neutral instead of successful adoption', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-attempt',
                    ok: true,
                    action: 'metadata_updated',
                    attemptedContinuityMode: 'metadata_only',
                    outcome: 'observed',
                    outcomeAction: 'metadata_updated',
                    groupGeneration: 2,
                    sessionAdoption: 'observed_only',
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch-attempt' })).toBeTruthy();
        expect(screen.findByType('Icon').props.name).toBe('info');
        expect(serialized).toContain(t('connectedServices.authSwitch.status.appliesOnNextResume'));
    });

    it('renders typed runtime-auth recovery transcript events', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-runtime-auth-recovery',
                    status: 'retry_scheduled',
                    serviceId: 'openai-codex',
                    profileId: 'backup',
                    groupId: 'team',
                    attempt: 2,
                    nextRetryAtMs: 1_700_000_010_000,
                    terminal: false,
                    diagnostic: {
                        code: 'recovery_retry_scheduled',
                        failurePhase: 'runtime_auth_recovery',
                        source: 'runtime_auth_recovery',
                        serviceId: 'openai-codex',
                        agentId: 'codex',
                        retryable: true,
                        suggestedActions: ['retry'],
                    },
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-runtime-auth-recovery' })).toBeTruthy();
        expect(screen.findByType('Icon').props.name).toBe('clock');
        expect(serialized).toContain(t('connectedServices.diagnostics.status.recovery_retry_scheduled'));
        expect(serialized).not.toContain(t('message.unknownEvent'));
    });

    it('O1: renders connected-service-account-switch-deferral events without falling back to Unknown event', async () => {
        const deferred = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-deferral',
                    policy: 'defer_until_idle',
                    awaitingBoundary: false,
                    timeoutMs: 60_000,
                }}
            />,
        );
        expect(deferred.findByProps({ testID: 'transcript-event-connected-service-account-switch-deferral' })).toBeTruthy();
        expect(JSON.stringify(deferred.tree.toJSON())).not.toContain('Unknown event');
    });

    it('O1: renders connected-service-account-switch-deferral-completed events without falling back to Unknown event', async () => {
        const completed = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-deferral-completed',
                    policy: 'defer_until_turn_boundary',
                    reason: 'turn_boundary_reached',
                }}
            />,
        );
        expect(completed.findByProps({ testID: 'transcript-event-connected-service-account-switch-deferral-completed' })).toBeTruthy();
        expect(JSON.stringify(completed.tree.toJSON())).not.toContain('Unknown event');

        const cancelled = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-deferral-completed',
                    reason: 'aborted_after_timeout',
                }}
            />,
        );
        expect(cancelled.findByProps({ testID: 'transcript-event-connected-service-account-switch-deferral-completed' })).toBeTruthy();
        expect(JSON.stringify(cancelled.tree.toJSON())).not.toContain('Unknown event');
    });

    it('O1: renders connected-service-account-switch-deferral-superseded events without falling back to Unknown event', async () => {
        const superseded = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-deferral-superseded',
                }}
            />,
        );
        expect(superseded.findByProps({ testID: 'transcript-event-connected-service-account-switch-deferral-superseded' })).toBeTruthy();
        expect(JSON.stringify(superseded.tree.toJSON())).not.toContain('Unknown event');
    });

    it('O1: renders provider-state-sharing-degraded events without falling back to Unknown event', async () => {
        const degraded = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'agent-state-sharing-degraded',
                    serviceId: 'pi',
                    code: 'import_partial',
                    requestedStateMode: 'full',
                    effectiveStateMode: 'partial',
                }}
            />,
        );
        expect(degraded.findByProps({ testID: 'transcript-event-agent-state-sharing-degraded' })).toBeTruthy();
        expect(JSON.stringify(degraded.tree.toJSON())).not.toContain('Unknown event');
    });
});

describe('TranscriptEventRow runtime-config-outcome', () => {
    const baseEvent = {
        type: 'runtime-config-outcome' as const,
        runtime: 'claude-unified-terminal',
        message: 'Model change scheduled',
    };

    it('renders all five frozen statuses with per-status testIDs', async () => {
        for (const status of ['applied', 'requires_restart', 'requires_interactive_control', 'unsupported', 'failed'] as const) {
            const screen = await renderScreen(
                <TranscriptEventRow event={{ ...baseEvent, status }} />,
            );
            expect(screen.findByProps({ testID: `transcript-event-runtime-config-outcome-${status}` })).toBeTruthy();
        }
    });

    it('renders pending timing as a calm secondary detail line', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{ ...baseEvent, status: 'applied', timing: 'before_next_prompt' }}
            />,
        );
        const detail = screen.findByProps({ testID: 'transcript-event-runtime-config-outcome-applied-detail' });
        expect(detail).toBeTruthy();
        expect(JSON.stringify(detail.props.children)).toContain(t('message.runtimeConfigOutcomeAppliesBeforeNextMessage'));
    });

    it('renders queued and already-set timings', async () => {
        const queued = await renderScreen(
            <TranscriptEventRow
                event={{ ...baseEvent, status: 'applied', timing: 'queued_until_safe_window' }}
            />,
        );
        expect(JSON.stringify(
            queued.findByProps({ testID: 'transcript-event-runtime-config-outcome-applied-detail' }).props.children,
        )).toContain(t('message.runtimeConfigOutcomeQueuedUntilReady'));

        const alreadySet = await renderScreen(
            <TranscriptEventRow
                event={{ ...baseEvent, status: 'applied', timing: 'skipped_already_effective' }}
            />,
        );
        expect(JSON.stringify(
            alreadySet.findByProps({ testID: 'transcript-event-runtime-config-outcome-applied-detail' }).props.children,
        )).toContain(t('message.runtimeConfigOutcomeAlreadySet'));
    });

    it('renders friendly per-change copy with values instead of the raw CLI message (L4)', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    ...baseEvent,
                    status: 'applied',
                    changes: [{ key: 'reasoningEffort' as const, requested: 'medium', effective: 'medium' }],
                }}
            />,
        );
        const body = JSON.stringify(screen.tree.toJSON());
        expect(body).toContain(t('message.runtimeConfigOutcomeKeyReasoningEffort'));
        expect(body).toContain('Medium');
        expect(body).not.toContain('Model change scheduled');
    });

    it('prefixes non-applied statuses and renders boolean values as On/Off (L4)', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    ...baseEvent,
                    status: 'requires_interactive_control',
                    changes: [{ key: 'launchOption' as const, requested: true, reason: 'ultracode' }],
                }}
            />,
        );
        const body = JSON.stringify(screen.tree.toJSON());
        expect(body).toContain(t('message.runtimeConfigOutcomeRequiresInteractiveControl'));
        expect(body).toContain(t('message.runtimeConfigOutcomeKeyLaunchOption'));
        expect(body).toContain(t('common.on'));
    });

    it('keeps model ids verbatim and humanizes enum-ish tokens (L4)', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    ...baseEvent,
                    status: 'applied',
                    changes: [
                        { key: 'model' as const, effective: 'claude-sonnet-4-6[1m]' },
                        { key: 'permissionMode' as const, effective: 'acceptEdits' },
                    ],
                }}
            />,
        );
        const body = JSON.stringify(screen.tree.toJSON());
        expect(body).toContain('claude-sonnet-4-6[1m]');
        expect(body).toContain('Accept edits');
    });

    it('falls back to the event message when changes carry no values (L4)', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow event={{ ...baseEvent, status: 'applied' }} />,
        );
        const body = JSON.stringify(screen.tree.toJSON());
        expect(body).toContain('Model change scheduled');
    });

    it('labels a sessionMode change as a first-class sub-state', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    ...baseEvent,
                    status: 'applied',
                    changes: [{ key: 'sessionMode' as const, requested: 'plan' }],
                }}
            />,
        );
        const detail = screen.findByProps({ testID: 'transcript-event-runtime-config-outcome-applied-detail' });
        expect(JSON.stringify(detail.props.children)).toContain(t('message.runtimeConfigOutcomeSessionMode'));
        expect(JSON.stringify(detail.props.children)).toContain('plan');
    });
    describe('capability notice', () => {
        const notice = (items: unknown, message = 'Linear couldn\'t start · env:LINEAR_API_KEY') => ({
            type: 'message', message, capabilityNoticeV1: { v: 1, items },
        }) as unknown as AgentEvent;

        it('says in plain words which server was left out and why, and opens that server', async () => {
            const screen = await renderScreen(<TranscriptEventRow event={notice([
                { kind: 'mcp_server', name: 'Linear', itemId: 'srv 1', code: 'missing_value_ref', detail: 'env:LINEAR_API_KEY' },
            ])} />);
            expect(screen.getTextContent()).toContain('Linear couldn’t start · missing LINEAR_API_KEY');
            expect(screen.getTextContent()).not.toContain('env:LINEAR_API_KEY');
            await screen.pressByTestIdAsync('transcript-event-capability-notice-open');
            expect(workerUpdateRouter.push).toHaveBeenCalledWith('/settings/mcp/srv%201');
        });

        it('keeps one line per skipped server and opens the collection when several were left out', async () => {
            const screen = await renderScreen(<TranscriptEventRow event={notice([
                { kind: 'mcp_server', name: 'Linear', itemId: 'a', code: 'invalid_server', detail: 'mcp_sign_in_required' },
                { kind: 'mcp_server', name: 'Postgres', itemId: 'b', code: 'missing_value_ref', detail: 'header:X_TOKEN' },
            ])} />);
            expect(screen.getTextContent()).toContain('Linear couldn’t start · needs sign-in');
            expect(screen.getTextContent()).toContain('Postgres couldn’t start · missing X_TOKEN');
            await screen.pressByTestIdAsync('transcript-event-capability-notice-open');
            expect(workerUpdateRouter.push).toHaveBeenCalledWith('/settings/mcp');
        });

        it('opens the prompt library for an unavailable optional prompt notice', async () => {
            const screen = await renderScreen(<TranscriptEventRow event={notice([
                { kind: 'prompt_library', name: 'Prompt library', code: 'prompt_library_unavailable' },
            ], 'Prompt library could not load')} />);
            await screen.pressByTestIdAsync('transcript-event-capability-notice-open');
            expect(workerUpdateRouter.push).toHaveBeenCalledWith('/settings/prompts');
        });

        it('never renders the sidecar itself when it is malformed or from a future writer', async () => {
            const screen = await renderScreen(<TranscriptEventRow event={notice({ unexpected: true }, 'Linear couldn\'t start')} />);
            expect(screen.getTextContent()).toContain('Linear couldn\'t start');
            expect(screen.getTextContent()).not.toContain('unexpected');
            expect(screen.findByTestId('transcript-event-capability-notice-open')).toBeNull();
        });
    });
});
