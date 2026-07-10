import { describe, expect, it } from 'vitest';

import {
    buildClaudeProviderTaskRuntimeActivitySourceId,
    CLAUDE_PROVIDER_TASK_ACTIVITY_TTL_MS,
    createClaudeProviderActivityLedger,
    readClaudeProviderTaskActivity,
} from './providerActivity.js';

describe('Claude provider runtime activity parsing', () => {
    it('builds canonical provider-task runtime activity source ids', () => {
        expect(buildClaudeProviderTaskRuntimeActivitySourceId(' agent-1 ')).toBe('claude:provider-task:agent-1');
        expect(buildClaudeProviderTaskRuntimeActivitySourceId('   ')).toBeNull();
    });

    it('treats terminal statuses on task progress and updates as terminal provider activity', () => {
        expect(readClaudeProviderTaskActivity({
            type: 'system',
            subtype: 'task_progress',
            task_id: 'agent-1',
            status: 'completed',
        })).toEqual({ type: 'terminal', taskId: 'agent-1' });

        expect(readClaudeProviderTaskActivity({
            type: 'system',
            subtype: 'task_updated',
            task_id: 'agent-2',
            patch: { status: 'failed' },
        })).toEqual({ type: 'terminal', taskId: 'agent-2' });
    });

    it('reads transcript task notifications from origin metadata', () => {
        expect(readClaudeProviderTaskActivity({
            type: 'user',
            origin: {
                kind: 'task-notification',
                taskId: 'agent-1',
                status: 'completed',
            },
            message: {
                content: [{ type: 'text', text: 'Task completed' }],
            },
        })).toEqual({ type: 'terminal', taskId: 'agent-1' });
    });

    it('reads transcript task notifications from queued-command XML', () => {
        expect(readClaudeProviderTaskActivity({
            type: 'queue-operation',
            operation: 'enqueue',
            content:
                '<task-notification><task-id>agent-1</task-id><status>completed</status></task-notification>',
        })).toEqual({ type: 'terminal', taskId: 'agent-1' });

        expect(readClaudeProviderTaskActivity({
            type: 'attachment',
            attachment: {
                type: 'queued_command',
                prompt:
                    '<task-notification><task-id>agent-2</task-id><status>running</status></task-notification>',
            },
        })).toEqual({ type: 'progress', taskId: 'agent-2' });
    });

    it('reads Bash background command launches from bare toolUseResult.backgroundTaskId', () => {
        expect(readClaudeProviderTaskActivity({
            type: 'user',
            message: {
                content: [{
                    type: 'tool_result',
                    tool_use_id: 'toolu_bash',
                    content:
                        'Command running in background with ID: b9c3fz9oq. Output is being written to: /tmp/b9c3fz9oq.output.',
                    is_error: false,
                }],
            },
            toolUseResult: {
                stdout: '',
                stderr: '',
                interrupted: false,
                isImage: false,
                noOutputExpected: false,
                backgroundTaskId: ' b9c3fz9oq ',
            },
        })).toEqual({ type: 'background', taskId: 'b9c3fz9oq' });
    });
});

describe('createClaudeProviderActivityLedger — W-3 per-task TTL backstop', () => {
    type Scheduled = { fn: () => void; delayMs: number };

    function harness(opts?: Readonly<{ ttlMs?: number }>) {
        let now = 0;
        const scheduled: Scheduled[] = [];
        const expired: number[] = [];
        const ledger = createClaudeProviderActivityLedger({
            now: () => now,
            ...(opts?.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
            onActiveTasksExpired: () => { expired.push(now); },
            // Manual scheduler: capture the single armed sweep; tests fire it deterministically.
            setExpiryTimer: (fn, delayMs) => {
                const entry: Scheduled = { fn, delayMs };
                scheduled.push(entry);
                return () => {
                    const idx = scheduled.indexOf(entry);
                    if (idx >= 0) scheduled.splice(idx, 1);
                };
            },
        });
        return {
            ledger,
            expired,
            advance: (ms: number) => { now += ms; },
            fireDueTimers: () => {
                const due = scheduled.splice(0, scheduled.length);
                for (const entry of due) entry.fn();
            },
        };
    }

    it('stops blocking hasActiveProviderTasks once a task passes the TTL (prune on read)', () => {
        const { ledger, advance } = harness();
        ledger.noteProviderTaskStarted('t1');
        expect(ledger.hasActiveProviderTasks()).toBe(true);
        advance(CLAUDE_PROVIDER_TASK_ACTIVITY_TTL_MS + 1);
        expect(ledger.hasActiveProviderTasks()).toBe(false);
        expect(ledger.getActiveProviderTaskIds()).toEqual([]);
    });

    it('renews the deadline on a fresh progress event inside the window', () => {
        const { ledger, advance } = harness({ ttlMs: 1000 });
        ledger.noteProviderTaskStarted('t1');
        advance(800);
        ledger.noteProviderTaskProgress('t1'); // renews lastEventAt
        advance(800); // 1600 total, but only 800 since the renewal
        expect(ledger.hasActiveProviderTasks()).toBe(true);
        advance(300); // 1100 since renewal
        expect(ledger.hasActiveProviderTasks()).toBe(false);
    });

    it('fires the idle re-check exactly once when the proactive sweep expires a task', () => {
        const { ledger, expired, advance, fireDueTimers } = harness({ ttlMs: 1000 });
        ledger.noteProviderTaskStarted('t1');
        advance(1000);
        fireDueTimers();
        expect(expired).toHaveLength(1);
        // No active tasks remain → the rescheduled sweep is a no-op (no second callback).
        fireDueTimers();
        expect(expired).toHaveLength(1);
    });

    it('does NOT fire the idle callback on a normal terminate (only on TTL expiry)', () => {
        const { ledger, expired, fireDueTimers } = harness({ ttlMs: 1000 });
        ledger.noteProviderTaskStarted('t1');
        ledger.noteProviderTaskFinished('t1');
        fireDueTimers();
        expect(expired).toHaveLength(0);
        expect(ledger.hasActiveProviderTasks()).toBe(false);
    });
});
