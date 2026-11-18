import { describe, expect, it } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { planExistingSessionChanges } from '@happier-dev/protocol/sessions/authoring/existingSessionPlanner';
import { executeBulkSessionChanges, summarizeBulkSessionChanges } from './executeBulkSessionChanges';
import { buildBulkSessionResultRowData } from './bulkSessionResultRows';

const a = { serverId: 'home', sessionId: 'a' };
const b = { serverId: 'home', sessionId: 'b' };
const targets = [a, b].map(address => ({ address, agentId: 'agent', machineId: 'machine' }));

describe('bulk Send', () => {
    it('publishes skipped target facts to the host alongside completed recipients', async () => {
        const updates: unknown[] = [];
        const plan = { ...planExistingSessionChanges({}, [targets[0]], 'hello'),
            skippedTargets: [{ address: b, reason: 'archived' }] };
        await executeBulkSessionChanges({ plan, onResult: row => updates.push(row),
            executeConfirmed: async () => ({ ok: true, result: { kind: 'fanout', results: [
                { target: a, result: { ok: true, result: { status: 'accepted', localId: 'sent-a' } } },
            ] } }) });
        expect(updates).toEqual(expect.arrayContaining([
            expect.objectContaining({ target: b, state: 'skipped', code: 'archived' }),
            expect.objectContaining({ target: a, state: 'sent' }),
        ]));
    });

    it('filters failed targets before later stages and publishes each result before the stage settles', async () => {
        const plan = planExistingSessionChanges({ permissionMode: 'yolo', connectedServices: null }, targets, 'hello');
        const calls: unknown[] = [];
        const updates: unknown[] = [];
        const result = await executeBulkSessionChanges({ plan, onResult: row => updates.push(row),
            executeConfirmed: async (id, input, context) => {
                calls.push({ id, input });
                if (calls.length === 1) {
                    context?.onSessionTargetResult?.({ actionId: id, position: 0, target: a,
                        result: { ok: false, error: 'unavailable', errorCode: 'target_unavailable' } });
                    expect(updates).toHaveLength(1);
                    return { ok: true, result: { kind: 'fanout', results: [
                        { target: a, result: { ok: false, error: 'unavailable', errorCode: 'target_unavailable' } },
                        { target: b, result: { ok: true, result: {} } },
                    ] } };
                }
                return { ok: true, result: { kind: 'fanout', results: [{ target: b,
                    result: { ok: true, result: { status: 'accepted', localId: 'sent-b' } } }] } };
            } });
        expect(calls).toHaveLength(2);
        expect(calls[1]).toMatchObject({ id: 'session.message.send', input: {
            sessionId: { selector: 'sessions', addresses: [b] }, message: 'hello', permissionModeOverride: 'yolo',
        } });
        expect(result.map(row => [row.target.sessionId, row.state, row.code])).toEqual([
            ['a', 'failed', 'target_unavailable'], ['b', 'sent', undefined],
        ]);
    });

    it('does not advance approval-pending targets and retains the typed wake reason', async () => {
        const plan = planExistingSessionChanges({ connectedServices: null }, targets, 'hello');
        let calls = 0;
        const results = await executeBulkSessionChanges({ plan, executeConfirmed: async () => {
            calls++;
            return { ok: true, result: { kind: 'fanout', results: [
                { target: a, result: { ok: true, result: { kind: 'approval_request_created', actionId: 'session.connected_services_auth.set', artifactId: 'approval' } } },
                { target: b, result: { ok: false, error: 'power approval required', errorCode: 'managed_wake_unconfirmed' } },
            ] } } satisfies ActionExecuteResult;
        } });
        expect(calls).toBe(1);
        expect(results.map(row => [row.state, row.code])).toEqual([
            ['approval_pending', 'approval_request_created'], ['waking', 'managed_wake_unconfirmed'],
        ]);
    });

    it('keeps the agent switch on a target whose message follows it', async () => {
        const claude = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
        const plan = planExistingSessionChanges({ agentTarget: claude }, [targets[0]!], 'hello');
        const results = await executeBulkSessionChanges({ plan, executeConfirmed: async (id) => ({ ok: true, result: { kind: 'fanout', results: [
            { target: a, result: { ok: true, result: id === 'session.agent.transition' ? { type: 'accepted' } : { status: 'accepted', localId: 'sent-a' } } },
        ] } }) });
        expect(results).toEqual([expect.objectContaining({ target: a, state: 'sent',
            switchedFrom: 'agent', switchedTo: 'happier.agent.claude/claude' })]);
    });

    it('summarizes settings-only work from planner stages, counting distinct addresses', () => {
        const plan = planExistingSessionChanges({ connectedServices: null, permissionMode: 'yolo' }, targets);
        expect(summarizeBulkSessionChanges(plan)).toMatchObject({ restarts: 2, engineSwitches: 0, messages: 0, skipped: 0 });
    });

    it('adapts results to Ask row facts without fabricating settings-only input admission', () => {
        const settings = buildBulkSessionResultRowData({ target: a, actionId: 'session.permission_mode.set', state: 'applied',
            result: { ok: true, result: {} } }, 'settings');
        expect(settings.target).toMatchObject({ target: a, requestBound: false, localId: null, replyStatus: 'not_requested' });
        const message = buildBulkSessionResultRowData({ target: a, actionId: 'session.message.send', state: 'sent',
            result: { ok: true, result: { status: 'accepted', localId: 'receiver-input' } } }, 'message');
        expect(message.target).toMatchObject({ target: a, requestBound: true, localId: 'receiver-input', replyStatus: 'not_requested' });
    });
});
