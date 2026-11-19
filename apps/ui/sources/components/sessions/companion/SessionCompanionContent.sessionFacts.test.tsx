import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createMachineFixture, createSessionFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { View } from 'react-native';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded } from '@/sync/domains/machines/reachability/machineReachability';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import { listPendingPermissionRequests } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { storage, useSession } from '@/sync/domains/state/storage';
import type { SessionCompanionController } from './state/useSessionCompanionController';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const runtime = installSessionPaneRuntimeTestHarness();
const { SessionCompanionContent } = await import('./SessionCompanionContent');
const { useSessionCompanionController } = await import('./state/useSessionCompanionController');
const { AGENT_PLAN_COMPANION_ITEM, SESSION_SUMMARY_COMPANION_ITEM } = await import('./state/sessionCompanionPreference');
const { SessionSummaryCard } = await import('./summary/SessionSummaryCard');
const { AgentInputPermissionRequests } = await import('@/components/sessions/agentInput/components/AgentInputPermissionRequests');
const { AppSessionTranscriptSourceProvider } = await import('@/components/sessions/transcript/source/appSessionTranscriptSource');

let controller: SessionCompanionController;
const openFullSurface = () => {};
function RailFacts() {
    const session = useSession('s1', runtime.serverId);
    controller = useSessionCompanionController({ sessionId: 's1', serverId: runtime.serverId, openFullSurface });
    return session ? <SessionCompanionContent session={session} serverId={runtime.serverId}
        controller={controller} boardBinding={null} presentation="rail" /> : null;
}

describe('Companion rail real Session facts', () => {
    it('renders live status, the oldest permission, context metrics and the current Plan without a Board read', async () => {
        const { latestUsage, ...session } = createSessionFixture({ id: 's1', serverId: runtime.serverId, active: true, activeAt: Date.now(),
            thinking: true, thinkingAt: Date.now(), presence: 'online',
            agentState: { controlledByUser: false, requests: { ask: { tool: 'Bash', arguments: { command: 'pwd' }, createdAt: 1 } } },
            metadata: { path: '/tmp/project', host: 'test-host',
                sessionWorkStateV1: { v: 1, backendId: 'claude', updatedAt: 1, items: [
                    { id: 'first', kind: 'todo', origin: 'vendor', title: 'Read the owner', status: 'complete', updatedAt: 1 },
                    { id: 'second', kind: 'todo', origin: 'vendor', title: 'Verify the change', status: 'active', updatedAt: 1 },
                ] },
            },
            latestUsage: { inputTokens: 1, outputTokens: 1, cacheCreation: 0, cacheRead: 0, contextSize: 42000,
                timestamp: Date.now(), contextSnapshotStale: false, contextSnapshot: { v: 1, modelId: null,
                    usedTokens: 42000, windowTokens: 100000, totalProcessedTokens: null, baselineTokens: null,
                    isAutoCompactEnabled: null, categories: null, observedAtMs: Date.now(), source: 'provider_turn' } },
        });
        storage.getState().applySessions([session]);
        // Usage continues to arrive on the transcript; the plan comes from Session metadata.
        storage.getState().applyMessages('s1', [{
            id: 'companion-facts', localId: null, seq: 1, createdAt: Date.now(), role: 'agent', isSidechain: false,
            content: [{ type: 'text', text: 'Checking the work', uuid: 'companion-facts', parentUUID: null }],
            usage: { input_tokens: latestUsage!.inputTokens, output_tokens: latestUsage!.outputTokens,
                contextSnapshot: latestUsage!.contextSnapshot ?? undefined },
        }]);
        const screen = await renderScreen(<runtime.Wrapper><RailFacts /></runtime.Wrapper>);
        try {
            await act(async () => { controller.show(SESSION_SUMMARY_COMPANION_ITEM); });
            await act(async () => { controller.addItem(AGENT_PLAN_COMPANION_ITEM); });
            await flushHookEffects({ cycles: 10 });
            const summary = screen.findByType(SessionSummaryCard);
            expect(summary.props.model).toMatchObject({ scope: 'exact', needsYou: { request: { id: 'ask', kind: 'permission' } },
                facts: expect.arrayContaining([{ kind: 'context', percent: 42, stale: false, destination: 'usage' }]),
                plan: { doneCount: 1, total: 2, currentStep: 2 } });
            expect(summary.props.model.status).not.toBeNull();
            expect(screen.findByTestId('session-companion-content-summary-ask')).not.toBeNull();
            expect(screen.findByTestId('session-companion-content-plan-step-second')).not.toBeNull();
        } finally { await screen.unmount(); }
    });
    it('names when and why a disconnected Session is behind on an online Machine, offers Retry, and never calls it Offline', async () => {
        const machine = createMachineFixture({ id: 'machine-online', active: true, activeAt: Date.now() });
        const base = createSessionFixture();
        const lastSeenAt = Date.now() - 20 * 60_000;
        const session = createSessionFixture({ id: 's1', serverId: runtime.serverId, active: false, activeAt: lastSeenAt, presence: lastSeenAt,
            metadata: { ...base.metadata!, machineId: machine.id, path: '/repo', host: 'Build computer' } });
        storage.getState().applyMachines([machine], true, { sourceServerId: runtime.serverId });
        storage.getState().applySessions([session]);
        recordMachineRequestSucceeded({ serverId: runtime.serverId, accountId: 'account-a', machineId: machine.id });
        const screen = await renderScreen(<runtime.Wrapper><RailFacts /></runtime.Wrapper>);
        try {
            await act(async () => { controller.show(SESSION_SUMMARY_COMPANION_ITEM); });
            await flushHookEffects({ cycles: 10 });
            const summary = screen.findByTestId('session-companion-content-summary');
            const line = screen.findByTestId('session-companion-content-freshness-text');
            const lineText = String(line?.props.accessibilityLabel ?? '') || screen.getTextContent();
            const asOfStem = t('surfaceState.asOf', { time: '\u00a7' }).split('\u00a7')[0]!;
            expect(lineText).toContain(t('sessionCompanion.freshness.sessionDisconnected'));
            expect(lineText).toContain(asOfStem);
            expect(lineText).not.toContain(t('sessionBoard.board.stale'));
            expect(screen.findByTestId('session-companion-content-freshness-action')).not.toBeNull();
            expect(summary).not.toBeNull();
            expect(screen.getTextContent()).not.toContain(t('status.offline'));
        } finally { await screen.unmount(); clearMachineRequestReachabilityForTest(); }
    });

    describe('a native permission request, in the chat tray and the Companion', () => {
        const nativeChoices = {
            requirementId: 'occurrence', source: 'native',
            choices: [
                { id: 'once', label: 'Allow once', decision: 'approved' as const, scope: 'once' as const, response: { approved: true } },
                { id: 'always', label: 'Always allow', decision: 'approved' as const, scope: 'localPersistent' as const, response: { approved: true } },
                { id: 'reject', label: 'Reject', decision: 'denied' as const, scope: 'once' as const, response: { approved: false } },
            ],
        };
        function nativeSession(overrides: Parameters<typeof createSessionFixture>[0] = {}) {
            const base = createSessionFixture();
            return createSessionFixture({ id: 's1', serverId: runtime.serverId, active: true, activeAt: Date.now(), presence: 'online',
                metadata: { ...base.metadata!, machineId: 'machine-native', path: '/repo', host: 'Build computer' },
                agentState: { controlledByUser: false, requests: { ask: { tool: 'Shell', arguments: { command: 'pwd' }, createdAt: 1, nativeChoices } } },
                ...overrides });
        }
        /** The composer's tray exactly as the Session screen mounts it: the Session's own source and interaction. */
        function Tray() {
            const session = useSession('s1', runtime.serverId);
            if (!session) return null;
            const interaction = deriveTranscriptInteractionFromSession(session);
            return <AppSessionTranscriptSourceProvider sessionId="s1" serverId={runtime.serverId}>
                <View testID="tray">
                    <AgentInputPermissionRequests sessionId="s1" metadata={session.metadata}
                        permissionRequests={listPendingPermissionRequests(session)} permissionLocationsById={new Map()}
                        canApprovePermissions={interaction.canApprovePermissions} disabledReason={interaction.permissionDisabledReason}
                        maxHeightPx={1000} onContentSizeChange={() => {}} onLayout={() => {}} onScroll={() => {}} />
                </View>
            </AppSessionTranscriptSourceProvider>;
        }
        function offeredChoices(root: ReturnType<Awaited<ReturnType<typeof renderScreen>>['findByTestId']>) {
            const nodes = root?.findAll((node) => typeof node.type === 'string'
                && typeof node.props.testID === 'string' && node.props.testID.startsWith('permission-footer.choice.')) ?? [];
            return nodes.map((node) => `${node.props.testID}:${node.props.accessibilityState?.disabled === true ? 'off' : 'on'}`);
        }
        async function renderBoth() {
            const screen = await renderScreen(<runtime.Wrapper><Tray /><RailFacts /></runtime.Wrapper>);
            await act(async () => { controller.show(SESSION_SUMMARY_COMPANION_ITEM); });
            await flushHookEffects({ cycles: 10 });
            return screen;
        }

        it('offers the same answerable choices in both while the Session is live', async () => {
            storage.getState().applySessions([nativeSession()]);
            const screen = await renderBoth();
            try {
                const tray = offeredChoices(screen.findByTestId('tray'));
                expect([...tray].sort()).toEqual(['permission-footer.choice.always:on', 'permission-footer.choice.once:on', 'permission-footer.choice.reject:on']);
                expect(offeredChoices(screen.findByTestId('session-companion-content-summary'))).toEqual(tray);
                expect(screen.findByTestId('session-companion-content-summary-allow')).toBeNull();
            } finally { await screen.unmount(); }
        });

        it('agrees with the tray when the Machine is offline: the same choices while the Session still runs, the freshness line names the Machine', async () => {
            const machine = createMachineFixture({ id: 'machine-native', active: true, activeAt: Date.now() });
            storage.getState().applyMachines([machine], true, { sourceServerId: runtime.serverId });
            storage.getState().applySessions([nativeSession()]);
            recordMachineRequestFailed({ serverId: runtime.serverId, accountId: 'account-a', machineId: machine.id });
            const screen = await renderBoth();
            try {
                const tray = offeredChoices(screen.findByTestId('tray'));
                expect(tray).toHaveLength(3);
                expect(offeredChoices(screen.findByTestId('session-companion-content-summary'))).toEqual(tray);
                expect(screen.findByTestId('session-companion-content-summary-ask-reason')).toBeNull();
            } finally { await screen.unmount(); clearMachineRequestReachabilityForTest(); }
        });

        it('agrees with the tray once the Session runtime is away: neither offers an answer nor says it is waiting', async () => {
            const lastSeenAt = Date.now() - 20 * 60_000;
            storage.getState().applySessions([nativeSession({ active: false, activeAt: lastSeenAt, presence: lastSeenAt })]);
            const screen = await renderBoth();
            try {
                expect(offeredChoices(screen.findByTestId('tray'))).toEqual([]);
                expect(offeredChoices(screen.findByTestId('session-companion-content-summary'))).toEqual([]);
                expect(screen.findByTestId('session-companion-content-summary-ask')).toBeNull();
                expect(screen.getTextContent()).not.toContain(t('sessionCompanion.status.waitingForYou'));
            } finally { await screen.unmount(); }
        });
    });
});
