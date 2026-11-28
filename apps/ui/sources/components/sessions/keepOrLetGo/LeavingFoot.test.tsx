import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createMachineFixture, createRootLayoutFeaturesResponse, renderScreen } from '@/dev/testkit';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import {
    getLeavingSessionsEntry,
    refreshLeavingSessions,
    resetLeavingSessionsResourceForTests,
} from '@/sync/domains/session/retention/leavingSessionsResource';
import { loadLocalSettings } from '@/sync/domains/state/persistence';
import { storage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/sync/http/client';
import { sync } from '@/sync/sync';

import { LeavingFoot } from './LeavingFoot';
import { LeavingSessionsProvider } from './leavingSessionsView';

const DAY_MS = 86_400_000;
const NOW = Date.now();
const RULE = { retentionDays: 60, noticeDays: 7, floorAt: NOW - DAY_MS };
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));

function leavingRow(id: string, daysUntilLeaving: number) {
    const activity = NOW - (RULE.retentionDays - daysUntilLeaving) * DAY_MS;
    return { id, updatedAt: activity, activeAt: activity };
}

function leavingPage(rows: ReturnType<typeof leavingRow>[]) {
    const newest = Math.max(...rows.map((row) => row.updatedAt)) + RULE.retentionDays * DAY_MS;
    return { rule: RULE, count: rows.length, newestLeavesAt: newest, sessions: rows, nextCursor: null };
}

const flush = () => act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
});

type Reads = { leaving: number; features: number; other: number };

describe('LeavingFoot', () => {
    let reads: Reads;
    let leavingResponse: () => Response | Promise<Response>;
    let featuresPayload: unknown;

    beforeEach(() => {
        resetLeavingSessionsResourceForTests();
        resetServerFeaturesClientForTests();
        upsertAndActivateServer({ serverUrl: 'http://leaving.example.test' });
        storage.getState().applyMachines([], true, { sourceServerId: getActiveServerSnapshot().serverId });
        machineRpc.mockReset();
        storage.getState().applyLocalSettings({ leavingFootDismissals: {} });
        reads = { leaving: 0, features: 0, other: 0 };
        featuresPayload = createRootLayoutFeaturesResponse();
        leavingResponse = () => new Response(JSON.stringify(leavingPage([leavingRow('s1', 3), leavingRow('s2', 5)])), { status: 200 });
        setRuntimeFetch(async (input) => {
            const url = String(input);
            if (url.includes('/v2/sessions/leaving')) {
                reads.leaving += 1;
                return leavingResponse();
            }
            if (url.includes('/v1/features')) {
                reads.features += 1;
                return new Response(JSON.stringify(featuresPayload), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.endsWith('/health')) return new Response('{}', { status: 200 });
            reads.other += 1;
            return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
        });
    });

    afterEach(() => {
        resetRuntimeFetch();
        resetLeavingSessionsResourceForTests();
    });

    it('reads an online machine only after its local snooze notice is due and no cloud batch is showing', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        const setMachineDueAt = (keptDueAtMs: number) => storage.getState().applyMachines([
            createMachineFixture({ id: 'studio', active: true, activeAt: Date.now(), daemonState: { keptDueAtMs } }),
        ], true, { sourceServerId: serverId });
        setMachineDueAt(NOW + DAY_MS);
        machineRpc.mockResolvedValue({ ok: true, due: [{ remoteSessionId: 'local', projectId: 'project', leavesAt: NOW + DAY_MS }], retentionDays: 30 });
        const screen = await renderScreen(<LeavingSessionsProvider enabled><LeavingFoot /></LeavingSessionsProvider>);
        await flush();
        expect(machineRpc).not.toHaveBeenCalled();
        await act(async () => { setMachineDueAt(NOW - 1); });
        expect(screen.findByTestId('leaving-foot')).not.toBeNull();
        expect(machineRpc).not.toHaveBeenCalled();

        leavingResponse = () => new Response(JSON.stringify({ rule: RULE, count: 0, newestLeavesAt: null, sessions: [], nextCursor: null }), { status: 200 });
        await act(async () => { await refreshLeavingSessions(); });
        await flush();
        expect(machineRpc).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            machineId: 'studio', serverId, method: RPC_METHODS.DAEMON_LOCAL_HISTORY,
            payload: { providerId: 'claude', source: { kind: 'claudeConfig' }, operation: 'due.list' },
        }));
        expect(screen.findByTestId('local-history-leaving-foot')).not.toBeNull();
    });

    it('keeps a dismissal across a reload on this device and shows again for a newer batch', async () => {
        const screen = await renderScreen(<LeavingSessionsProvider enabled><LeavingFoot /></LeavingSessionsProvider>);
        await flush();
        expect(screen.findByTestId('leaving-foot')).not.toBeNull();

        await act(async () => {
            screen.pressByTestId('leaving-foot-dismiss');
        });
        expect(screen.findByTestId('leaving-foot')).toBeNull();
        await screen.unmount();

        // Reload: memory starts empty and is rebuilt from this device's persisted local settings.
        storage.setState({ localSettings: { ...localSettingsDefaults } });
        storage.setState({ localSettings: loadLocalSettings() });
        resetLeavingSessionsResourceForTests();
        const reloaded = await renderScreen(<LeavingSessionsProvider enabled><LeavingFoot /></LeavingSessionsProvider>);
        await flush();
        expect(reloaded.findByTestId('leaving-foot')).toBeNull();

        // A session that crossed into the window since: a newer batch asks again.
        leavingResponse = () => new Response(
            JSON.stringify(leavingPage([leavingRow('s1', 3), leavingRow('s2', 5), leavingRow('s3', 6)])),
            { status: 200 },
        );
        await act(async () => {
            await refreshLeavingSessions();
        });
        expect(reloaded.findByTestId('leaving-foot')).not.toBeNull();
        expect(reloaded.getTextContent()).toContain('3 sessions leaving');
    });

    it('retires leaving rows on logout even if an old response arrives after a new read', async () => {
        await refreshLeavingSessions();
        expect(getLeavingSessionsEntry().data?.count).toBe(2);
        let replyToOldRead: (response: Response) => void = () => {};
        leavingResponse = () => new Promise((resolve) => { replyToOldRead = resolve; });
        const oldRead = refreshLeavingSessions();
        await flush();

        sync.retireAccountDataForEveryHome();
        expect(getLeavingSessionsEntry().data).toBeNull();
        leavingResponse = () => new Response(JSON.stringify(leavingPage([leavingRow('current', 2)])), { status: 200 });
        await refreshLeavingSessions();
        replyToOldRead(new Response(JSON.stringify(leavingPage([leavingRow('old', 4)])), { status: 200 }));
        await oldRead;
        expect(getLeavingSessionsEntry().data?.sessions.map((session) => session.id)).toEqual(['current']);
    });

    it('reads once per mount and re-renders nothing on list arrivals or an unchanged re-read', async () => {
        let footCommits = 0;
        let arrive: () => void = () => {};
        // The list re-renders on every arrival; the foot is a stable child below it, as in the wrapper.
        function ListShell(props: Readonly<{ children: React.ReactNode }>) {
            const [arrivals, setArrivals] = React.useState(0);
            arrive = () => setArrivals((value) => value + 1);
            return (
                <>
                    <React.Fragment key={arrivals} />
                    {props.children}
                </>
            );
        }
        const screen = await renderScreen(
            <LeavingSessionsProvider enabled>
                <ListShell>
                    <React.Profiler id="foot" onRender={() => { footCommits += 1; }}>
                        <LeavingFoot />
                    </React.Profiler>
                </ListShell>
            </LeavingSessionsProvider>,
        );
        await flush();
        expect(screen.findByTestId('leaving-foot')).not.toBeNull();
        expect(reads.leaving).toBe(1);
        const settledCommits = footCommits;

        for (let arrival = 0; arrival < 5; arrival += 1) {
            await act(async () => {
                arrive();
                storage.setState({});
            });
        }
        expect(reads.leaving).toBe(1);
        expect(footCommits).toBe(settledCommits);

        await act(async () => {
            await refreshLeavingSessions();
        });
        expect(reads.leaving).toBe(2);
        expect(footCommits).toBe(settledCommits);
    });

    it.each([false, true])('shows the policy notice before the start date with no added request (paid only: %s)', async (paidOnly) => {
        leavingResponse = () => new Response(JSON.stringify({ error: 'Retention notice unavailable' }), { status: 404 });
        if (paidOnly) {
            leavingResponse = () => Response.json({ ...leavingPage([]), newestLeavesAt: null });
        }
        const withRetention = (startsAt: number) => {
            const base = createRootLayoutFeaturesResponse() as { capabilities: { server: Record<string, unknown> } };
            return {
                ...base,
                capabilities: {
                    ...base.capabilities,
                    server: {
                        ...base.capabilities.server,
                        retention: {
                            policyVersion: 1,
                            startsAt,
                            noticeDays: 7,
                            enabled: true,
                            sessions: paidOnly ? { mode: 'keep_forever' } : { mode: 'delete_inactive', inactivityDays: 60, requires: ['updatedAt', 'lastActiveAt'] },
                            accountChanges: { mode: 'keep_forever' },
                            voiceSessionLeases: { mode: 'keep_forever' },
                            userFeedItems: { mode: 'keep_forever' },
                            sessionShareAccessLogs: { mode: 'keep_forever' },
                            publicShareAccessLogs: { mode: 'keep_forever' },
                            terminalAuthRequests: { mode: 'keep_forever' },
                            accountAuthRequests: { mode: 'keep_forever' },
                            authPairingSessions: { mode: 'keep_forever' },
                            repeatKeys: { mode: 'keep_forever' },
                            globalLocks: { mode: 'keep_forever' },
                            automationRuns: { mode: 'keep_forever' },
                            automationRunEvents: { mode: 'keep_forever' },
                        },
                    },
                },
            };
        };

        featuresPayload = withRetention(NOW + 30 * DAY_MS);
        expect((await getServerFeaturesSnapshot()).status).toBe('ready');
        const featureReadsBefore = reads.features;
        const screen = await renderScreen(<LeavingSessionsProvider enabled><LeavingFoot /></LeavingSessionsProvider>);
        await flush();
        expect(screen.findByTestId('leaving-foot')).toBeNull();
        expect(screen.findByTestId('leaving-foot-policy')).not.toBeNull();
        expect(screen.getTextContent()).toContain('leaving.example.test');
        expect(screen.findByTestId('leaving-foot-learn-more')).toBeNull();
        expect(screen.getTextContent()).toContain('keeps sessions for 60 days after their last activity');
        expect(reads.features).toBe(featureReadsBefore);
        expect(reads.other).toBe(0);

        await act(async () => {
            screen.pressByTestId('leaving-foot-policy-dismiss');
        });
        expect(screen.findByTestId('leaving-foot-policy')).toBeNull();
        expect(loadLocalSettings().leavingFootDismissals[getActiveServerSnapshot().serverId]?.policyStartsAt)
            .toBe(NOW + 30 * DAY_MS);
        await screen.unmount();

        storage.getState().applyLocalSettings({ leavingFootDismissals: {} });
        resetServerFeaturesClientForTests();
        featuresPayload = withRetention(NOW - DAY_MS);
        await getServerFeaturesSnapshot();
        const started = await renderScreen(<LeavingSessionsProvider enabled><LeavingFoot /></LeavingSessionsProvider>);
        await flush();
        expect(started.findByTestId('leaving-foot-policy')).toBeNull();
    });
});
