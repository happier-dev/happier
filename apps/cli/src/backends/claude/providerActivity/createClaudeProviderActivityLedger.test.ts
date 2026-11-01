import { describe, expect, it, vi } from 'vitest';
import {
    createClaudeProviderActivityLedger,
    normalizeClaudeProviderTaskEvent,
    readClaudeSessionHookProviderTaskActivity,
    readClaudeProviderTaskActivity,
} from './createClaudeProviderActivityLedger';

describe('Claude provider task lifecycle', () => {
    it('keeps strict activity admission separate from operational interrupt targets', () => {
        expect(normalizeClaudeProviderTaskEvent({
            type: 'user',
            toolUseResult: { status: 'async_launched', agentId: ' async-agent ' },
        })).toEqual({
            activity: null,
            interruptTarget: { type: 'active', taskId: 'async-agent' },
            backgroundTask: null,
        });
        expect(normalizeClaudeProviderTaskEvent({
            type: 'system',
            subtype: 'task_started',
            task_id: ' task-without-session ',
        })).toEqual({
            activity: null,
            interruptTarget: { type: 'active', taskId: 'task-without-session' },
            backgroundTask: null,
        });
        expect(normalizeClaudeProviderTaskEvent({
            type: 'system',
            subtype: 'task_notification',
            task_id: ' task-without-session ',
            status: 'completed',
        })).toEqual({
            activity: null,
            interruptTarget: { type: 'terminal', taskId: 'task-without-session' },
            backgroundTask: null,
        });
        expect(readClaudeProviderTaskActivity({
            type: 'user',
            toolUseResult: { status: 'async_launched', agentId: 'async-agent' },
        })).toBeNull();
    });

    it('does not admit an errored async launch acknowledgement', () => {
        expect(readClaudeProviderTaskActivity({
            type: 'user', sessionId: 's1',
            toolUseResult: { status: 'async_launched', agentId: 'failed-launch' },
            message: { content: [{ type: 'tool_result', tool_use_id: 'launch', is_error: true }] },
        })).toBeNull();
    });

    it('admits an exact successful native asynchronous resume even before local inventory reconstruction', () => {
        expect(readClaudeProviderTaskActivity({ type: 'user', sessionId: 's1',
            toolUseResult: { success: true, resumedAgentId: 'resumed' },
        })).toEqual({ type: 'started', source: 'hook-agent-resume', sessionId: 's1', taskId: 'resumed' });
    });

    it.each(['transcript', 'hook', 'child-hook'] as const)(
        'retires only a resumed child explicitly reported stopped by native SendMessage (%s)',
        (delivery) => {
            const ledger = createClaudeProviderActivityLedger();
            ledger.noteOwnedSessionId('s1');
            ledger.apply({ type: 'started', sessionId: 's1', taskId: 'stopped-child' });
            ledger.apply({ type: 'terminal', sessionId: 's1', taskId: 'stopped-child', terminalStatus: 'failed' });
            ledger.apply({ type: 'started', sessionId: 's1', taskId: 'stopped-child', source: 'hook-agent-resume' });
            ledger.apply({ type: 'started', sessionId: 's1', taskId: 'sibling' });
            // Claude 2.1.296 native response, observed after a rejected tool/interrupted child.
            const response = { success: false, message: "Agent stopped-child was stopped by the user and won't be resumed. Treat its work as cancelled; only launch a new agent if the user explicitly asks." };
            const activity = delivery === 'transcript'
                ? readClaudeProviderTaskActivity({ type: 'user', sessionId: 's1', toolUseResult: response,
                    message: { content: [{ type: 'tool_result', tool_use_id: 'send', content: JSON.stringify(response) }] } })
                : readClaudeSessionHookProviderTaskActivity({ hook_event_name: 'PostToolUse', session_id: 's1',
                    ...(delivery === 'child-hook' ? { agent_id: 'sibling' } : {}),
                    tool_name: 'SendMessage', tool_input: { to: 'stopped-child' }, tool_response: response });
            expect(activity).toEqual({ type: 'terminal', sessionId: 's1', taskId: 'stopped-child', terminalStatus: 'stopped' });
            if (activity) ledger.apply(activity);
            expect(ledger.getObservedActiveProviderTaskCount()).toBe(1);
            expect(ledger.getActiveProviderTaskBlockers().map(blocker => blocker.taskId)).toEqual(['sibling']);
        },
    );

    it('does not infer child cancellation from arbitrary failed responses or copied text', () => {
        const message = "Agent stopped-child was stopped by the user and won't be resumed. Treat its work as cancelled; only launch a new agent if the user explicitly asks.";
        for (const row of [
            { type: 'user', sessionId: 's1', message: { content: message } },
            { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { to: 'stopped-child' }, tool_response: { success: false, message } },
            { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'SendMessage', tool_input: { to: 'other-child' }, tool_response: { success: false, message } },
            { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'SendMessage', tool_input: { to: 'stopped-child' }, tool_response: { success: false, message: 'Delivery timed out' } },
        ]) {
            expect(readClaudeProviderTaskActivity(row)).toBeNull();
            expect(readClaudeSessionHookProviderTaskActivity(row)).toBeNull();
        }
    });

    it('requires background admission rather than a terminal-only identity for SubagentStart', () => {
        const ledger = createClaudeProviderActivityLedger();
        const apply = (value: unknown) => {
            const activity = readClaudeProviderTaskActivity(value);
            if (activity) ledger.apply(activity);
        };
        const complete = (taskId: string) => apply({ type: 'attachment', sessionId: 's1',
            attachment: { type: 'task_status', taskId, taskType: 'local_agent', status: 'completed' } });
        const start = (agentId: string) => apply({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: agentId });
        complete('foreground');
        start('foreground');
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
        complete('fast-background');
        apply({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Agent',
            tool_response: { status: 'async_launched', agentId: 'fast-background' } });
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
        start('fast-background');
        expect(ledger.getActiveProviderTaskCount()).toBe(1);
        complete('fast-background');
        start('fast-background');
        expect(ledger.getActiveProviderTaskCount()).toBe(1);
        apply({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'SendMessage',
            tool_response: { success: true, resumedAgentId: 'foreground' } });
        expect(ledger.getActiveProviderTaskCount()).toBe(2);
    });

    it('ignores copied user XML and ordinary queued prompts while reading native notification provenance', () => {
        const content = '<task-notification><task-id>known</task-id><status>completed</status></task-notification>';
        const user = { type: 'user', sessionId: 's1', message: { content } };
        expect(readClaudeProviderTaskActivity(user)).toBeNull();
        const queued = { type: 'attachment', sessionId: 's1', attachment: { type: 'queued_command', prompt: content } };
        expect(readClaudeProviderTaskActivity(queued)).toBeNull();
        const ledger = createClaudeProviderActivityLedger();
        ledger.apply({ type: 'started', sessionId: 's1', taskId: 'known' });
        expect(readClaudeProviderTaskActivity({ type: 'queue-operation', operation: 'enqueue', sessionId: 's1', content })).toBeNull();
        expect(ledger.getActiveProviderTaskCount()).toBe(1);
        const native = readClaudeProviderTaskActivity({ ...user, origin: { kind: 'task-notification' } });
        expect(native?.type).toBe('terminal');
        if (native) ledger.apply(native);
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
        expect(readClaudeProviderTaskActivity({ ...queued, attachment: { ...queued.attachment,
            commandMode: 'task-notification' } })?.type).toBe('terminal');
    });

    it('accepts only exact typed lifecycle rows and aliases explicit Workflow', () => {
        expect(readClaudeProviderTaskActivity({
            type: 'system', subtype: 'task_started', session_id: ' s1 ', task_id: ' t1 ',
            task_type: 'local_workflow',
        })).toEqual({ type: 'started', sessionId: 's1', taskId: 't1' });
        expect(readClaudeProviderTaskActivity({
            type: 'system', subtype: 'task_progress', session_id: 's1', task_id: 't1',
        })).toEqual({ type: 'progress', sessionId: 's1', taskId: 't1', source: 'system-task-progress' });
        for (const status of ['completed', 'failed', 'stopped']) {
            expect(readClaudeProviderTaskActivity({
                type: 'system', subtype: 'task_notification', session_id: 's1', task_id: 't1', status,
            })).toEqual({ type: 'terminal', terminalStatus: status, sessionId: 's1', taskId: 't1' });
        }
        for (const [status, terminalStatus] of [
            ['completed', 'completed'],
            ['failed', 'failed'],
            ['killed', 'stopped'],
        ] as const) {
            expect(readClaudeProviderTaskActivity({
                type: 'system', subtype: 'task_updated', session_id: 's1', task_id: 't1', patch: { status },
            })).toEqual({ type: 'terminal', terminalStatus, sessionId: 's1', taskId: 't1' });
        }
    });

    it('rejects inferred and broadened evidence', () => {
        expect(readClaudeProviderTaskActivity({ type: 'user', toolUseResult: { backgroundTaskId: 't1' } })).toBeNull();
        expect(readClaudeProviderTaskActivity({ type: 'queue-operation', content: '<task-notification />' })).toBeNull();
        expect(readClaudeProviderTaskActivity({ hook_event_name: 'Stop', background_tasks: [] })).toBeNull();
        expect(readClaudeProviderTaskActivity({
            type: 'system', subtype: 'task_notification', session_id: 's1', task_id: 't1', status: 'succeeded',
        })).toBeNull();
        for (const status of ['pending', 'running', 'stopped', 'cancelled', 'succeeded']) {
            expect(readClaudeProviderTaskActivity({
                type: 'system', subtype: 'task_updated', session_id: 's1', task_id: 't1', patch: { status },
            })).toBeNull();
        }
        expect(readClaudeProviderTaskActivity({
            type: 'system',
            subtype: 'task_updated',
            session_id: 's1',
            task_id: 't1',
            status: 'completed',
        })).toBeNull();
    });

    it('admits an unknown but fully typed task type while an absent task type stays known-only', () => {
        // PLAN 4.9.1 step 5: a known-foreground type defers to authenticated hook evidence, a
        // known-background type admits, and an UNKNOWN but fully typed one degrades to background.
        // The allowlist of two (`local_bash` | `local_workflow`) silently dropped every other
        // detached shape - the exact failure t3code's denylist exists to prevent.
        for (const taskType of ['shell', 'monitor', 'monitor_mcp', 'container_bash']) {
            expect(readClaudeProviderTaskActivity({
                type: 'system',
                subtype: 'task_started',
                session_id: 's1',
                task_id: `bg-${taskType}`,
                task_type: taskType,
            })).toEqual({ type: 'started', sessionId: 's1', taskId: `bg-${taskType}` });
        }
        // Untyped input never reaches classification (PLAN 4.9.1 step 1): no `task_type` means no
        // provider evidence of detached work, so liveness stays with the authenticated hook.
        expect(readClaudeProviderTaskActivity({
            type: 'system',
            subtype: 'task_started',
            session_id: 's1',
            task_id: 'untyped-1',
        })).toEqual({
            type: 'started',
            sessionId: 's1',
            taskId: 'untyped-1',
            admission: 'known-only',
        });
    });

    it('keeps local/remote Agent typed starts and unknown progress non-admitting', () => {
        for (const taskType of ['local_agent', 'remote_agent', 'subagent', undefined]) {
            expect(readClaudeProviderTaskActivity({
                type: 'system',
                subtype: 'task_started',
                session_id: 's1',
                task_id: 'agent-1',
                task_type: taskType,
            })).toEqual({
                type: 'started',
                sessionId: 's1',
                taskId: 'agent-1',
                admission: 'known-only',
            });
        }
        expect(readClaudeProviderTaskActivity({
            type: 'system',
            subtype: 'task_started',
            session_id: 's1',
            task_id: 'bash-1',
            task_type: 'local_bash',
        })).toEqual({ type: 'started', sessionId: 's1', taskId: 'bash-1' });
    });
});

describe('readClaudeSessionHookProviderTaskActivity', () => {
    const sessionId = 'claude-session-1';

    it('admits exact async/remote Agent launches without optional input/response hints', () => {
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'Agent',
            tool_input: {},
            tool_response: { status: 'async_launched', agentId: ' local-agent ' },
        })).toEqual({ type: 'started', source: 'hook-agent-launch', sessionId, taskId: 'local-agent' });
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'Agent',
            tool_input: { run_in_background: false },
            tool_response: { status: 'async_launched', agentId: 'local-agent', isAsync: false },
        })).toEqual({ type: 'started', source: 'hook-agent-launch', sessionId, taskId: 'local-agent' });
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'Agent',
            tool_response: { status: 'remote_launched', taskId: ' remote-task ' },
        })).toEqual({ type: 'started', source: 'hook-agent-launch', sessionId, taskId: 'remote-task' });
    });

    it('re-admits only a successful main-chain SendMessage resumed Agent id', () => {
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'SendMessage',
            tool_response: { success: true, resumedAgentId: ' resumed-1 ' },
        })).toEqual({ type: 'started', sessionId, taskId: 'resumed-1', source: 'hook-agent-resume' });
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'SendMessage',
            tool_response: { resumedAgentId: ' resumed-2 ' },
        })).toEqual({ type: 'started', sessionId, taskId: 'resumed-2', source: 'hook-agent-resume' });
        for (const toolResponse of [
            { success: false, resumedAgentId: 'resumed-1' },
            { is_error: true, resumedAgentId: 'resumed-1' },
            { isError: true, resumedAgentId: 'resumed-1' },
            { error: 'rejected', resumedAgentId: 'resumed-1' },
            ...['failed', 'error', 'denied', 'rejected'].map((status) => ({ status, resumedAgentId: 'resumed-1' })),
        ]) expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'SendMessage',
            tool_response: toolResponse,
        })).toBeNull();
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            agent_id: 'sidechain',
            tool_name: 'SendMessage',
            tool_response: { resumedAgentId: 'resumed-1' },
        })).toEqual({ type: 'progress', sessionId, taskId: 'sidechain' });
    });

    it('aliases exact async Workflow taskId admission without creating another owner', () => {
        const ledger = createClaudeProviderActivityLedger();
        for (const [status, taskId] of [
            ['async_launched', 'workflow-1'],
            ['remote_launched', 'workflow-2'],
        ] as const) {
            const activity = readClaudeSessionHookProviderTaskActivity({
                hook_event_name: 'PostToolUse',
                session_id: sessionId,
                tool_name: 'Workflow',
                tool_response: { status, taskId: ` ${taskId} ` },
            });
            expect(activity).toEqual({ type: 'started', source: 'hook-agent-launch', sessionId, taskId });
            if (!activity) throw new Error('expected exact Workflow activity');
            expect(ledger.apply(activity)).toBe(true);
            expect(ledger.apply(activity)).toBe(false);
        }
        expect(ledger.getActiveProviderTaskCount()).toBe(2);
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'Workflow',
            tool_response: { status: 'async_launched', task_id: 'native-alias' },
        })).toEqual({ type: 'started', source: 'hook-agent-launch', sessionId, taskId: 'native-alias' });
    });

    it('keeps foreground, PreToolUse, and unknown SubagentStart evidence inert', () => {
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'Agent',
            tool_response: { status: 'completed', agentId: 'foreground-agent' },
        })).toBeNull();
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PreToolUse',
            session_id: sessionId,
            tool_name: 'Agent',
            tool_input: { run_in_background: true },
        })).toBeNull();
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'SubagentStart',
            session_id: sessionId,
            agent_id: 'unknown-agent',
        })).toEqual({ type: 'started', admission: 'known-only', source: 'hook-agent-resume', sessionId, taskId: 'unknown-agent' });
    });

    it('requires matching nested terminal TaskOutput evidence and terminal TaskStop confirmation', () => {
        const taskOutput = (toolResponse: unknown) => readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'TaskOutput',
            tool_input: { task_id: 'task-1' },
            tool_response: toolResponse,
        });
        expect(taskOutput({ retrieval_status: 'success', task: { task_id: 'task-1', status: 'running' } })).toBeNull();
        expect(taskOutput({ retrieval_status: 'success', task: { task_id: 'sibling', status: 'completed' } })).toBeNull();
        expect(taskOutput({ retrieval_status: 'success' })).toBeNull();
        for (const status of ['completed', 'failed', 'stopped', 'killed']) {
            expect(taskOutput({
                retrieval_status: 'success',
                task: { task_id: 'task-1', status },
            })).toEqual({
                type: 'terminal', sessionId, taskId: 'task-1',
                terminalStatus: status === 'killed' ? 'stopped' : status, rememberIfUnknown: false,
            });
        }

        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'TaskStop',
            tool_input: { task_id: 'task-1' },
            tool_response: { status: 'accepted', task_id: 'task-1' },
        })).toBeNull();
        expect(readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            tool_name: 'TaskStop',
            tool_input: { task_id: 'task-1' },
            tool_response: { task: { task_id: 'task-1', status: 'stopped' } },
        })).toEqual({ type: 'terminal', terminalStatus: 'stopped', sessionId, taskId: 'task-1', rememberIfUnknown: false });
    });

    it('treats a vetoable SubagentStop as progress and re-admits a known resumed invocation', () => {
        const ledger = createClaudeProviderActivityLedger();
        ledger.apply({ type: 'started', sessionId, taskId: 'agent-1' });
        const stop = readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'SubagentStop', session_id: sessionId, agent_id: 'agent-1',
        });
        if (stop) ledger.apply(stop);
        expect(ledger.hasActiveProviderTask({ sessionId, taskId: 'agent-1' })).toBe(true);
        ledger.apply({ type: 'terminal', sessionId, taskId: 'agent-1', terminalStatus: 'completed' });
        const resume = readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'SubagentStart', session_id: sessionId, agent_id: 'agent-1',
        });
        if (resume) ledger.apply(resume);
        expect(ledger.hasActiveProviderTask({ sessionId, taskId: 'agent-1' })).toBe(true);
        const unknown = readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'SubagentStart', session_id: sessionId, agent_id: 'unadmitted',
        });
        if (unknown) ledger.apply(unknown);
        expect(ledger.getActiveProviderTaskCount()).toBe(1);
    });

    it('folds native task-status evidence while retaining handbacks as report-delivery progress', () => {
        const ledger = createClaudeProviderActivityLedger();
        ledger.apply({ type: 'started', sessionId, taskId: 'native-agent' });
        const handback = readClaudeProviderTaskActivity({
            type: 'user', sessionId,
            origin: { kind: 'peer', from: 'native-agent', senderTaskId: 'native-agent', handback: true },
            message: { content: '<agent-message agent_id="native-agent">report</agent-message>' },
        });
        expect(handback).toEqual({ type: 'progress', confirmsActivity: false, sessionId, taskId: 'native-agent' });
        if (handback) ledger.apply(handback);
        expect(ledger.getActiveProviderTaskCount()).toBe(1);
        const terminal = readClaudeProviderTaskActivity({ type: 'attachment', sessionId,
            attachment: { type: 'task_status', taskId: 'native-agent', taskType: 'local_agent', status: 'completed' },
        });
        expect(terminal).toEqual({ type: 'terminal', sessionId, taskId: 'native-agent', terminalStatus: 'completed' });
        if (terminal) ledger.apply(terminal);
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
    });

    it('ignores bare queue XML for known and unknown tasks without poisoning future native admission', () => {
        const ledger = createClaudeProviderActivityLedger();
        const xml = (operation: string, taskId: string) => ({ type: 'queue-operation', operation, sessionId,
            content: `<task-notification><task-id>${taskId}</task-id><status>completed</status></task-notification>` });
        ledger.apply({ type: 'started', sessionId, taskId: 'known' });
        const remove = readClaudeProviderTaskActivity(xml('remove', 'known'));
        if (remove) ledger.apply(remove);
        expect(ledger.getActiveProviderTaskCount()).toBe(1);
        const unknown = readClaudeProviderTaskActivity(xml('enqueue', 'future'));
        if (unknown) ledger.apply(unknown);
        ledger.apply({ type: 'started', sessionId, taskId: 'future' });
        expect(ledger.getActiveProviderTaskCount()).toBe(2);
        expect(readClaudeProviderTaskActivity(xml('enqueue', 'known'))).toBeNull();
        expect(ledger.getActiveProviderTaskCount()).toBe(2);
    });

    it('terminalizes only the exact admitted sidechain on StopFailure', () => {
        const ledger = createClaudeProviderActivityLedger();
        for (const taskId of ['failed-agent', 'sibling-agent']) {
            const launch = readClaudeSessionHookProviderTaskActivity({
                hook_event_name: 'PostToolUse',
                session_id: sessionId,
                tool_name: 'Agent',
                tool_response: { status: 'async_launched', agentId: taskId },
            });
            if (!launch) throw new Error('expected exact async Agent launch');
            expect(ledger.apply(launch)).toBe(true);
        }

        const stopFailure = readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'StopFailure',
            session_id: sessionId,
            agent_id: ' failed-agent ',
            error: 'authentication_failed',
        });
        expect(stopFailure).toEqual({
            type: 'terminal',
            terminalStatus: 'failed',
            sessionId,
            taskId: 'failed-agent',
            rememberIfUnknown: true,
        });
        if (!stopFailure) throw new Error('expected exact sidechain StopFailure');
        expect(ledger.apply(stopFailure)).toBe(true);
        expect(ledger.getActiveProviderTaskBlockers()).toEqual([{
            sessionId,
            taskId: 'sibling-agent',
            sources: ['hook-agent-launch'],
        }]);

        const siblingStopFailure = readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'StopFailure',
            session_id: sessionId,
            agent_id: 'sibling-agent',
            error: 'authentication_failed',
        });
        if (!siblingStopFailure) throw new Error('expected exact sibling StopFailure');
        expect(ledger.apply(siblingStopFailure)).toBe(true);
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
        expect(ledger.hasActiveProviderTasks()).toBe(false);

        for (const malformed of [
            { hook_event_name: 'StopFailure', session_id: sessionId, error: 'authentication_failed' },
            { hook_event_name: 'StopFailure', session_id: sessionId, agent_id: '   ' },
            { hook_event_name: 'StopFailure', session_id: sessionId, task_id: 'not-a-sidechain-identity' },
        ]) {
            expect(readClaudeSessionHookProviderTaskActivity(malformed)).toBeNull();
        }
    });
});

/** Applies typed Claude SDK system rows from session `s1` to the ledger. */
function sdkRowApplier(ledger: ReturnType<typeof createClaudeProviderActivityLedger>) {
    return (row: Record<string, unknown>) => {
        const activity = readClaudeProviderTaskActivity({ type: 'system', session_id: 's1', ...row });
        if (activity) ledger.apply(activity);
    };
}

describe('createClaudeProviderActivityLedger', () => {
    it('abandons only active tasks and keeps early terminal evidence', () => {
        const ledger = createClaudeProviderActivityLedger();
        ledger.apply({ type: 'started', sessionId: 's1', taskId: 'running-1' });
        ledger.apply({ type: 'started', sessionId: 's1', taskId: 'running-2' });
        ledger.apply({ type: 'terminal', terminalStatus: 'completed', sessionId: 's1', taskId: 'finished-early' });

        expect(ledger.abandonActiveProviderTasks()).toEqual([
            { sessionId: 's1', taskId: 'running-1', sources: ['system-task-started'] },
            { sessionId: 's1', taskId: 'running-2', sources: ['system-task-started'] },
        ]);
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
        expect(ledger.abandonActiveProviderTasks()).toEqual([]);

        // The early terminal record still keeps a late plain start inert, while fresh evidence for
        // an abandoned task is admitted again.
        expect(ledger.apply({ type: 'started', sessionId: 's1', taskId: 'finished-early' })).toBe(false);
        expect(ledger.apply({ type: 'started', sessionId: 's1', taskId: 'running-1' })).toBe(true);
        expect(ledger.getActiveProviderTaskCount()).toBe(1);
    });

    it('never lets a foreign session raise this ledger\'s active provider-task count', () => {
        // PLAN 4.9.1 step 2 (identity). `hasActiveProviderTasks()` holds THIS session's turn open,
        // so another session's typed lifecycle row must be inert here - not merely stored under a
        // different key, where it still counts.
        const ledger = createClaudeProviderActivityLedger();
        ledger.noteOwnedSessionId('claude-session-1');

        const foreign = readClaudeProviderTaskActivity({
            type: 'system',
            subtype: 'task_started',
            session_id: 'claude-session-2',
            task_id: 'bash-1',
            task_type: 'local_bash',
        });
        if (!foreign) throw new Error('expected typed started activity');

        expect(ledger.apply(foreign)).toBe(false);
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
        expect(ledger.hasActiveProviderTasks()).toBe(false);
        expect(ledger.getActiveProviderTaskBlockers()).toEqual([]);

        const owned = readClaudeProviderTaskActivity({
            type: 'system',
            subtype: 'task_started',
            session_id: 'claude-session-1',
            task_id: 'bash-2',
            task_type: 'local_bash',
        });
        if (!owned) throw new Error('expected typed started activity');
        expect(ledger.apply(owned)).toBe(true);
        expect(ledger.getActiveProviderTaskCount()).toBe(1);
    });

    it('keeps every session id this runtime has owned admissible across a provider session change', () => {
        // The Claude session id moves within one Happier session (resume, `init`, compact boundary),
        // and the ledger outlives every one of them. Ownership is therefore a lineage, not a single
        // current id - otherwise a compaction would make live tasks foreign to their own ledger.
        const ledger = createClaudeProviderActivityLedger();
        ledger.noteOwnedSessionId('claude-session-1');
        ledger.noteOwnedSessionId('claude-session-2');

        expect(ledger.apply({ type: 'started', sessionId: 'claude-session-1', taskId: 'pre-compact' })).toBe(true);
        expect(ledger.apply({ type: 'started', sessionId: 'claude-session-2', taskId: 'post-compact' })).toBe(true);
        expect(ledger.getActiveProviderTaskCount()).toBe(2);
        expect(ledger.apply({ type: 'started', sessionId: 'claude-session-3', taskId: 'foreign' })).toBe(false);
        expect(ledger.getActiveProviderTaskCount()).toBe(2);
    });

    it('keys membership by exact session/task tuple and removes only the exact sibling', () => {
        const ledger = createClaudeProviderActivityLedger();
        ledger.apply({ type: 'started', sessionId: 's1', taskId: 'same' });
        ledger.apply({ type: 'started', sessionId: 's2', taskId: 'same' });
        ledger.apply({ type: 'terminal', sessionId: 's1', taskId: 'same' });
        expect(ledger.getActiveProviderTaskBlockers()).toEqual([{
            sessionId: 's2', taskId: 'same', sources: ['system-task-started'],
        }]);
    });

    it('deduplicates Workflow aliases and never expires silent affirmative truth', () => {
        vi.useFakeTimers();
        try {
            const ledger = createClaudeProviderActivityLedger();
            ledger.apply({ type: 'started', sessionId: 's1', taskId: 'workflow' });
            ledger.apply({ type: 'progress', sessionId: 's1', taskId: 'workflow' });
            vi.advanceTimersByTime(24 * 60 * 60 * 1_000);
            expect(ledger.getActiveProviderTaskCount()).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps an agent that stopped with live background children resumable by its own progress', () => {
        // Row shapes observed from Claude Code 2.1.302 stream-json: an Agent that ends its turn
        // while its own backgrounded Bash runs reports `completed`, then wakes when the child settles.
        const ledger = createClaudeProviderActivityLedger();
        const apply = sdkRowApplier(ledger);
        apply({ subtype: 'task_started', task_id: 'agent-1', task_type: 'local_agent', is_backgrounded: true });
        apply({
            subtype: 'task_started',
            task_id: 'bash-1',
            task_type: 'local_bash',
            is_backgrounded: true,
            owned_by_subagent: true,
            parent_task_id: 'agent-1',
        });
        expect(ledger.getActiveProviderTaskCount()).toBe(2);

        apply({ subtype: 'task_updated', task_id: 'agent-1', patch: { status: 'completed' } });
        apply({ subtype: 'task_notification', task_id: 'agent-1', status: 'completed' });
        expect(ledger.getActiveProviderTaskCount()).toBe(1);

        const subagentStop = readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'SubagentStop',
            session_id: 's1',
            agent_id: 'agent-1',
        });
        expect(subagentStop).not.toBeNull();
        if (subagentStop) ledger.apply(subagentStop);
        expect(ledger.getActiveProviderTaskCount()).toBe(1);

        apply({ subtype: 'task_notification', task_id: 'bash-1', status: 'completed' });
        // An Agent that never wakes holds nothing open once its children settle.
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
        if (subagentStop) ledger.apply(subagentStop);
        expect(ledger.getActiveProviderTaskCount()).toBe(0);

        apply({ subtype: 'task_progress', task_id: 'agent-1' });
        expect(ledger.hasActiveProviderTask({ sessionId: 's1', taskId: 'agent-1' })).toBe(true);

        apply({ subtype: 'task_notification', task_id: 'agent-1', status: 'completed' });
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
        apply({ subtype: 'task_progress', task_id: 'agent-1' });
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
    });

    it.each([
        ['failed', { subtype: 'task_notification', task_id: 'agent-1', status: 'failed' }],
        ['killed', { subtype: 'task_updated', task_id: 'agent-1', patch: { status: 'killed' } }],
    ])('does not let a %s Agent with live children wake on later progress', (_status, terminalRow) => {
        const ledger = createClaudeProviderActivityLedger();
        const apply = sdkRowApplier(ledger);
        apply({ subtype: 'task_started', task_id: 'agent-1', task_type: 'local_agent', is_backgrounded: true });
        apply({
            subtype: 'task_started',
            task_id: 'bash-1',
            task_type: 'local_bash',
            is_backgrounded: true,
            owned_by_subagent: true,
            parent_task_id: 'agent-1',
        });
        apply(terminalRow);
        apply({ subtype: 'task_progress', task_id: 'agent-1' });
        expect(ledger.hasActiveProviderTask({ sessionId: 's1', taskId: 'agent-1' })).toBe(false);
    });

    it.each([
        ['failed', { type: 'system', subtype: 'task_notification', task_id: 'agent-1', status: 'failed' }],
        ['stopped', { type: 'system', subtype: 'task_updated', task_id: 'agent-1', patch: { status: 'killed' } }],
        ['TaskStop', {
            hook_event_name: 'PostToolUse', tool_name: 'TaskStop',
            tool_input: { task_id: 'agent-1' }, tool_response: { task_id: 'agent-1', status: 'stopped' },
        }],
        ['completed TaskStop', {
            hook_event_name: 'PostToolUse', tool_name: 'TaskStop',
            tool_input: { task_id: 'agent-1' }, tool_response: { task_id: 'agent-1', status: 'completed' },
        }],
        ['failed TaskOutput', {
            hook_event_name: 'PostToolUse', tool_name: 'TaskOutput',
            tool_input: { task_id: 'agent-1' },
            tool_response: { retrieval_status: 'success', task: { task_id: 'agent-1', status: 'failed' } },
        }],
        ['StopFailure', { hook_event_name: 'StopFailure', agent_id: 'agent-1' }],
    ])('retires an awaiting Agent after %s evidence', (_label, terminalRow) => {
        const ledger = createClaudeProviderActivityLedger();
        const apply = sdkRowApplier(ledger);
        apply({ subtype: 'task_started', task_id: 'agent-1', task_type: 'local_agent', is_backgrounded: true });
        apply({
            subtype: 'task_started', task_id: 'bash-1', task_type: 'local_bash',
            is_backgrounded: true, parent_task_id: 'agent-1',
        });
        apply({ subtype: 'task_notification', task_id: 'agent-1', status: 'completed' });
        const row = { session_id: 's1', ...terminalRow };
        const terminal = readClaudeProviderTaskActivity(row) ?? readClaudeSessionHookProviderTaskActivity(row);
        if (!terminal) throw new Error('expected terminal evidence');
        ledger.apply(terminal);
        apply({ subtype: 'task_notification', task_id: 'bash-1', status: 'completed' });
        apply({ subtype: 'task_progress', task_id: 'agent-1' });
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
    });

    it.each(['typed', 'TaskOutput'])('keeps an Agent resumable after %s completion and completed TaskOutput aliases', (firstCompletion) => {
        const ledger = createClaudeProviderActivityLedger();
        const apply = sdkRowApplier(ledger);
        apply({ subtype: 'task_started', task_id: 'agent-1', task_type: 'local_agent', is_backgrounded: true });
        apply({
            subtype: 'task_started', task_id: 'bash-1', task_type: 'local_bash',
            is_backgrounded: true, parent_task_id: 'agent-1',
        });
        const output = readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'TaskOutput',
            tool_input: { task_id: 'agent-1' },
            tool_response: { retrieval_status: 'success', task: { task_id: 'agent-1', status: 'completed' } },
        });
        if (!output) throw new Error('expected completed TaskOutput evidence');
        if (firstCompletion === 'TaskOutput') ledger.apply(output);
        else apply({ subtype: 'task_notification', task_id: 'agent-1', status: 'completed' });
        ledger.apply(output);
        apply({ subtype: 'task_notification', task_id: 'agent-1', status: 'completed' });
        apply({ subtype: 'task_notification', task_id: 'bash-1', status: 'completed' });
        apply({ subtype: 'task_progress', task_id: 'agent-1' });
        expect(ledger.hasActiveProviderTask({ sessionId: 's1', taskId: 'agent-1' })).toBe(true);
    });

    it.each(['TaskOutput', 'TaskStop'])('keeps an unknown %s terminal from suppressing a later launch', (toolName) => {
        const ledger = createClaudeProviderActivityLedger();
        const terminal = readClaudeSessionHookProviderTaskActivity({
            hook_event_name: 'PostToolUse', session_id: 's1', tool_name: toolName,
            tool_input: { task_id: 'agent-1' },
            tool_response: { retrieval_status: 'success', task: { task_id: 'agent-1', status: 'completed' } },
        });
        if (!terminal) throw new Error('expected exact terminal hook evidence');
        ledger.apply(terminal);
        const apply = sdkRowApplier(ledger);
        apply({ subtype: 'task_started', task_id: 'agent-1', task_type: 'local_agent', is_backgrounded: true });
        expect(ledger.hasActiveProviderTask({ sessionId: 's1', taskId: 'agent-1' })).toBe(true);
    });

    it('keeps an agent resumable while a nested agent it owns still waits on or resumes its own work', () => {
        const createNested = () => {
            const ledger = createClaudeProviderActivityLedger();
            const apply = sdkRowApplier(ledger);
            apply({ subtype: 'task_started', task_id: 'agent-a', task_type: 'local_agent', is_backgrounded: true });
            apply({
                subtype: 'task_started',
                task_id: 'agent-b',
                task_type: 'local_agent',
                is_backgrounded: true,
                owned_by_subagent: true,
                parent_task_id: 'agent-a',
            });
            apply({
                subtype: 'task_started',
                task_id: 'bash-b',
                task_type: 'local_bash',
                is_backgrounded: true,
                owned_by_subagent: true,
                parent_task_id: 'agent-b',
            });
            return { ledger, apply };
        };
        const stop = (apply: (row: Record<string, unknown>) => void, taskId: string) => {
            apply({ subtype: 'task_updated', task_id: taskId, patch: { status: 'completed' } });
            apply({ subtype: 'task_notification', task_id: taskId, status: 'completed' });
        };
        const isActive = (ledger: ReturnType<typeof createClaudeProviderActivityLedger>, taskId: string) =>
            ledger.hasActiveProviderTask({ sessionId: 's1', taskId });

        // A stops while B is itself stopped, waiting on its own shell.
        const waiting = createNested();
        stop(waiting.apply, 'agent-b');
        stop(waiting.apply, 'agent-a');
        waiting.apply({ subtype: 'task_notification', task_id: 'bash-b', status: 'completed' });
        waiting.apply({ subtype: 'task_progress', task_id: 'agent-b' });
        stop(waiting.apply, 'agent-b');
        waiting.apply({ subtype: 'task_progress', task_id: 'agent-a' });
        expect(isActive(waiting.ledger, 'agent-a')).toBe(true);

        // A stops after B has woken from its own wait and is working again.
        const resumed = createNested();
        stop(resumed.apply, 'agent-b');
        resumed.apply({ subtype: 'task_notification', task_id: 'bash-b', status: 'completed' });
        resumed.apply({ subtype: 'task_progress', task_id: 'agent-b' });
        stop(resumed.apply, 'agent-a');
        stop(resumed.apply, 'agent-b');
        resumed.apply({ subtype: 'task_progress', task_id: 'agent-a' });
        expect(isActive(resumed.ledger, 'agent-a')).toBe(true);
    });

    it('keeps the parent link when the typed child launch follows an earlier hook launch', () => {
        const ledger = createClaudeProviderActivityLedger();
        const apply = sdkRowApplier(ledger);
        apply({ subtype: 'task_started', task_id: 'agent-a', task_type: 'local_agent', is_backgrounded: true });
        ledger.apply({ type: 'started', sessionId: 's1', taskId: 'agent-b', source: 'hook-agent-launch' });
        apply({
            subtype: 'task_started',
            task_id: 'agent-b',
            task_type: 'local_agent',
            is_backgrounded: true,
            owned_by_subagent: true,
            parent_task_id: 'agent-a',
        });

        apply({ subtype: 'task_notification', task_id: 'agent-a', status: 'completed' });
        apply({ subtype: 'task_notification', task_id: 'agent-b', status: 'completed' });
        apply({ subtype: 'task_progress', task_id: 'agent-a' });
        expect(ledger.hasActiveProviderTask({ sessionId: 's1', taskId: 'agent-a' })).toBe(true);
    });

    it('does not let progress admit an unknown task', () => {
        const ledger = createClaudeProviderActivityLedger();
        expect(ledger.apply({ type: 'progress', sessionId: 's1', taskId: 'unknown' })).toBe(false);
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
    });

    it('consumes terminal-before-confirmation in the same map without publishing stale active', () => {
        const ledger = createClaudeProviderActivityLedger();
        expect(ledger.apply({
            type: 'terminal',
            sessionId: 's1',
            taskId: 'agent-1',
            rememberIfUnknown: true,
        })).toBe(false);
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
        expect(ledger.apply({ type: 'started', sessionId: 's1', taskId: 'agent-1' })).toBe(false);
        expect(ledger.apply({ type: 'started', sessionId: 's1', taskId: 'agent-1' })).toBe(false);
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
        expect(ledger.hasActiveProviderTask({ sessionId: 's1', taskId: 'agent-1' })).toBe(false);
    });

    it('lets only an exact successful SendMessage resume reactivate a terminal id', () => {
        const ledger = createClaudeProviderActivityLedger();
        ledger.apply({
            type: 'terminal',
            sessionId: 's1',
            taskId: 'agent-1',
            rememberIfUnknown: true,
        });

        expect(ledger.apply({
            type: 'started',
            sessionId: 's1',
            taskId: 'agent-1',
            source: 'hook-agent-resume',
        })).toBe(true);
        expect(ledger.getActiveProviderTaskCount()).toBe(1);
    });

    it('keeps typed terminal evidence authoritative over repeated late launch delivery', () => {
        const ledger = createClaudeProviderActivityLedger();
        ledger.apply({ type: 'started', sessionId: 's1', taskId: 'bash-1' });
        ledger.apply({ type: 'terminal', sessionId: 's1', taskId: 'bash-1', terminalStatus: 'completed' });

        expect(ledger.apply({ type: 'started', sessionId: 's1', taskId: 'bash-1' })).toBe(false);
        expect(ledger.apply({ type: 'started', sessionId: 's1', taskId: 'bash-1' })).toBe(false);
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
    });

    it('retains unknown typed terminal ordering over repeated late launch delivery', () => {
        const ledger = createClaudeProviderActivityLedger();
        const terminal = readClaudeProviderTaskActivity({
            type: 'system',
            subtype: 'task_notification',
            session_id: 's1',
            task_id: 'bash-1',
            status: 'completed',
        });
        if (!terminal) throw new Error('expected typed terminal activity');
        expect(ledger.apply(terminal)).toBe(false);

        expect(ledger.apply({ type: 'started', sessionId: 's1', taskId: 'bash-1' })).toBe(false);
        expect(ledger.apply({ type: 'started', sessionId: 's1', taskId: 'bash-1' })).toBe(false);
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
    });

    it('makes update/notification terminal aliases idempotent in either order without clearing a sibling session', () => {
        const terminalRows = [
            {
                type: 'system',
                subtype: 'task_updated',
                session_id: 's1',
                task_id: 'same',
                patch: { status: 'killed' },
            },
            {
                type: 'system',
                subtype: 'task_notification',
                session_id: 's1',
                task_id: 'same',
                status: 'stopped',
            },
        ];
        for (const rows of [terminalRows, [...terminalRows].reverse()]) {
            const ledger = createClaudeProviderActivityLedger();
            ledger.apply({ type: 'started', sessionId: 's1', taskId: 'same' });
            ledger.apply({ type: 'started', sessionId: 's2', taskId: 'same' });
            const [first, second] = rows.map(row => readClaudeProviderTaskActivity(row));
            if (!first || !second) throw new Error('expected exact terminal activity');

            expect(ledger.apply(first)).toBe(true);
            expect(ledger.apply(second)).toBe(false);
            expect(ledger.getActiveProviderTaskBlockers()).toEqual([{
                sessionId: 's2', taskId: 'same', sources: ['system-task-started'],
            }]);
        }
    });
});
