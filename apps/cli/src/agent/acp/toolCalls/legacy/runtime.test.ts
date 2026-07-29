import { describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '@/agent/core';
import { LegacyAcpToolRuntime } from './runtime';
import { CURSOR_CAPTURED_REPLAY_V1 } from '../testing/cursorCapturedReplayFixture';
import { SHARED_RAW_ACP_TOOL_TRANSITIONS } from '../testing/rawTransitionFixture';

function createFixture(
    timeoutMs: number | null = null,
    onPublishedTerminalResult = vi.fn(),
    determineToolName = (_base: string, _id: string, input: Record<string, unknown>): string => input.command ? 'execute' : 'other',
) {
    const messages: AgentMessage[] = [];
    let turnId = 'turn-1';
    const runtime = new LegacyAcpToolRuntime({
        sessionId: () => 'session-1',
        turnId: () => turnId,
        sidechainId: null,
        emit: (message) => messages.push(message),
        transport: {
            agentName: 'test',
            determineToolName,
            getToolCallTimeout: () => timeoutMs,
        } as any,
        onBecameActive: vi.fn(),
        onBecameIdle: vi.fn(),
        onPublishedTerminalResult,
    });
    return { runtime, messages, onPublishedTerminalResult, setTurnId: (value: string) => { turnId = value; } };
}

describe('LegacyAcpToolRuntime', () => {
    it('notifies the terminal-result observer only when the accumulator owns result publication', () => {
        const { runtime, onPublishedTerminalResult } = createFixture();
        const completed = {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'generated-image-1',
            kind: 'image',
            status: 'completed',
            rawOutput: { type: 'ImageGen', path: '/tmp/session/image.png' },
        };

        runtime.handleRawUpdate(completed);
        runtime.handleRawUpdate(completed);
        runtime.handleRawUpdate({
            ...completed,
            rawOutput: { type: 'ImageGen', path: '/tmp/session/image-2.png' },
        });

        expect(onPublishedTerminalResult).toHaveBeenCalledTimes(1);
        expect(onPublishedTerminalResult).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                toolCallId: 'generated-image-1',
                status: 'completed',
                rawOutput: completed.rawOutput,
            }),
        );
    });

    it('replays the sanitized Cursor capture without duplicate or orphan durable identities', () => {
        const { runtime, messages } = createFixture();

        for (const update of CURSOR_CAPTURED_REPLAY_V1.updates) runtime.handleRawUpdate(update);
        runtime.terminalizeTurn('completed');
        for (const update of CURSOR_CAPTURED_REPLAY_V1.lateEnrichment) runtime.handleRawUpdate(update);

        const calls = messages.filter((message) => message.type === 'tool-call');
        const results = messages.filter((message) => message.type === 'tool-result');
        const finalCalls = new Map(calls.map((message) => [message.localId, message]));
        const finalResults = new Map(results.map((message) => [message.localId, message]));
        expect(new Set(calls.map((message) => message.callId)).size).toBe(271);
        expect(finalCalls.size).toBe(271);
        expect(new Set(results.map((message) => message.callId)).size).toBe(271);
        expect(finalResults.size).toBe(271);
        expect([...finalCalls.values()].filter((message) => message.toolName === 'edit')).toHaveLength(30);
        expect([...finalCalls.values()].filter((message) => message.callId.startsWith('captured-task-'))).toHaveLength(6);
        expect([...finalResults.values()].some((message) => message.callId === 'captured-create-plan-001')).toBe(true);
        expect([...finalCalls.values()].some((message) => message.callId === 'captured-create-plan-001')).toBe(true);
        expect([...finalCalls.values()].map((message) => message.callId)).toEqual(expect.arrayContaining([
            'captured-edit-001', 'captured-task-006', 'captured-create-plan-001',
        ]));
        expect(runtime.readCall('captured-edit-001')?.title)
            .toBe('Edit sanitized-001.txt (final)');

        const resumed = createFixture();
        for (const update of CURSOR_CAPTURED_REPLAY_V1.updates) resumed.runtime.handleRawUpdate(update);
        resumed.runtime.terminalizeTurn('completed');
        expect(new Set(resumed.messages.filter((message) => message.type === 'tool-call').map((message) => message.callId)).size)
            .toBe(271);
        expect(new Set(resumed.messages.filter((message) => message.type === 'tool-result').map((message) => message.callId)).size)
            .toBe(271);
    });

    it.each(SHARED_RAW_ACP_TOOL_TRANSITIONS)('matches shared raw transition: $name', ({
        toolCallId,
        updates,
        closeTurnBeforeLateUpdates,
        beginNewTurnBeforeLateUpdates,
        lateUpdates = [],
        expected,
    }) => {
        const { runtime, messages, setTurnId } = createFixture();
        for (const update of updates) runtime.handleRawUpdate(update);
        if (closeTurnBeforeLateUpdates) runtime.terminalizeTurn('completed');
        if (beginNewTurnBeforeLateUpdates) setTurnId('turn-2');
        for (const update of lateUpdates) runtime.handleRawUpdate(update);

        const call = runtime.readCall(toolCallId);
        expect(call && {
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            title: call.title,
            kind: call.kind,
            status: call.status,
            rawInput: call.rawInput,
        }).toEqual({
            toolCallId,
            toolName: expected.toolName,
            title: expected.title,
            kind: expected.kind,
            status: expected.status,
            rawInput: expected.rawInput,
        });
        const results = messages.filter((message) => message.type === 'tool-result');
        expect(results).toHaveLength(expected.resultCount);
        if (expected.resultCount > 0) {
            if (expected.rawOutput === undefined) {
                expect(results.at(-1)?.result).toMatchObject({
                    output: undefined,
                    _acp: { kind: expected.kind },
                });
            } else {
                expect(results.at(-1)?.result).toMatchObject(expected.rawOutput as object);
            }
        }
        expect(call?.localId.length).toBeLessThan(128);
        if (expected.distinctCallLocalIds !== undefined) {
            expect(new Set(messages.filter((message) => message.type === 'tool-call').map((message) => message.localId)).size)
                .toBe(expected.distinctCallLocalIds);
        }
    });

    it('projects richer revisions and one stable result through one accumulator identity', () => {
        const { runtime, messages } = createFixture();
        runtime.handleRawUpdate({
            sessionUpdate: 'tool_call',
            toolCallId: ' call\n\0id ',
            title: 'Run',
            kind: 'other',
            status: 'pending',
        });
        runtime.handleRawUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId: ' call\n\0id ',
            status: 'in_progress',
            rawInput: { command: 'pwd' },
        });
        runtime.handleRawUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId: ' call\n\0id ',
            status: 'completed',
            rawOutput: { stdout: '/tmp' },
        });

        const calls = messages.filter((message) => message.type === 'tool-call');
        const results = messages.filter((message) => message.type === 'tool-result');
        expect(calls).toHaveLength(3);
        expect(new Set(calls.map((call) => call.localId)).size).toBe(1);
        expect(calls.at(-1)).toMatchObject({
            callId: ' call\n\0id ',
            toolName: 'execute',
            args: { command: 'pwd' },
        });
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            callId: ' call\n\0id ',
            result: { stdout: '/tmp' },
        });
        expect(results[0]?.localId).not.toBe(calls[0]?.localId);
        expect(runtime.activeCalls()).toEqual([]);
    });

    it.each([
        ['', 'execute'],
        ['other', 'execute'],
        ['unknown', 'execute'],
        ['unknown_tool', 'execute'],
        [' Other ', 'execute'],
        [' UNKNOWN ', 'execute'],
        [' UNKNOWN_TOOL ', 'execute'],
        ['read', 'read'],
    ])('keeps only semantic cached name %j ahead of a later explicit kind', (initialKind, expectedToolName) => {
        const { runtime, messages } = createFixture(
            null,
            vi.fn(),
            (baseName) => baseName,
        );
        runtime.handleRawUpdate({
            sessionUpdate: 'tool_call',
            toolCallId: 'cached-name',
            title: 'Initial',
            kind: initialKind,
            status: 'pending',
        });
        runtime.handleRawUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'cached-name',
            kind: 'execute',
            status: 'completed',
            rawOutput: { exitCode: 0 },
        });

        expect(runtime.readCall('cached-name')).toMatchObject({
            kind: 'execute',
            toolName: expectedToolName,
        });
        expect(messages.filter((message) => message.type === 'tool-call').at(-1)).toMatchObject({
            toolName: expectedToolName,
        });
        expect(messages.filter((message) => message.type === 'tool-result')).toEqual([
            expect.objectContaining({ toolName: expectedToolName }),
        ]);
    });

    it('seeds permission state, arms only after approval, and terminalizes before reset', () => {
        vi.useFakeTimers();
        try {
            const { runtime, messages } = createFixture(10);
            runtime.observePermission({
                toolCallId: 'permission-first',
                toolName: 'execute',
                input: { command: 'sleep 1' },
            });
            expect(runtime.readCall('permission-first')).toMatchObject({
                toolName: 'execute',
                status: 'pending',
                rawInput: { command: 'sleep 1' },
            });
            vi.advanceTimersByTime(20);
            expect(messages.filter((message) => message.type === 'tool-result')).toHaveLength(0);

            runtime.markRunningAfterPermission('permission-first');
            vi.advanceTimersByTime(20);
            const timeoutResults = messages.filter((message) => message.type === 'tool-result');
            expect(timeoutResults).toHaveLength(1);
            expect(timeoutResults[0]).toMatchObject({
                callId: 'permission-first',
                result: {
                    error: {
                        status: 'timeout',
                        timeoutMs: 10,
                    },
                },
            });
            expect(runtime.activeCalls()).toEqual([]);
            expect(runtime.diagnostics().permissionWaiters).toBe(0);
            expect(runtime.readCall('permission-first')).toMatchObject({ status: 'failed' });

            runtime.handleRawUpdate({
                sessionUpdate: 'tool_call_update',
                toolCallId: 'permission-first',
                status: 'failed',
                rawOutput: { error: 'provider timeout detail' },
            });
            const enrichedResults = messages.filter((message) => message.type === 'tool-result');
            expect(enrichedResults).toHaveLength(2);
            expect(enrichedResults[1]).toMatchObject({
                localId: timeoutResults[0]?.localId,
                callId: 'permission-first',
                result: { error: 'provider timeout detail' },
            });

            runtime.handleRawUpdate({
                sessionUpdate: 'tool_call',
                toolCallId: 'unresolved',
                title: 'Plan',
                status: 'pending',
            });
            runtime.terminalizeTurn('cancelled');
            expect(messages.filter((message) => message.type === 'tool-call').at(-1)).toMatchObject({
                callId: 'unresolved',
            });
            expect(runtime.activeCalls()).toEqual([]);
            runtime.reset();
            expect(runtime.diagnostics()).toEqual({
                active: 0,
                tombstones: 0,
                closedTurns: 0,
                timers: 0,
                permissionWaiters: 0,
                mediaFingerprints: 0,
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('isolates a reused exact raw id in a later turn', () => {
        const { runtime, messages, setTurnId } = createFixture();
        runtime.handleRawUpdate({
            sessionUpdate: 'tool_call', toolCallId: 'same', title: 'First', status: 'completed', rawOutput: 'one',
        });
        const firstLocalId = messages.find((message) => message.type === 'tool-call')?.localId;
        setTurnId('turn-2');
        runtime.handleRawUpdate({
            sessionUpdate: 'tool_call', toolCallId: 'same', title: 'Second', status: 'completed', rawOutput: 'two',
        });
        const calls = messages.filter((message) => message.type === 'tool-call');
        expect(calls.at(-1)?.localId).not.toBe(firstLocalId);
    });

    it('revises an older retained call after intervening legacy turns without colliding with the current turn', () => {
        const { runtime, messages, setTurnId } = createFixture();
        runtime.handleRawUpdate({
            sessionUpdate: 'tool_call', toolCallId: 'older-turn-call', title: 'Older', kind: 'read', status: 'completed', rawOutput: 'first',
        });
        const olderTurnCall = messages.find(
            (message) => message.type === 'tool-call' && message.callId === 'older-turn-call',
        );
        const olderTurnLocalId = olderTurnCall?.type === 'tool-call' ? olderTurnCall.localId : undefined;
        runtime.terminalizeTurn('completed');

        setTurnId('turn-2');
        runtime.handleRawUpdate({
            sessionUpdate: 'tool_call', toolCallId: 'intervening-turn-call', title: 'Intervening', status: 'completed', rawOutput: 'second',
        });
        runtime.terminalizeTurn('completed');

        setTurnId('turn-3');
        runtime.handleRawUpdate({
            sessionUpdate: 'tool_call', toolCallId: 'current-turn-call', title: 'Current', status: 'pending',
        });
        runtime.handleRawUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'older-turn-call',
            status: 'completed',
            title: 'Older enriched after intervening turns',
            rawOutput: 'richer',
        });

        const olderCalls = messages.filter(
            (message) => message.type === 'tool-call' && message.callId === 'older-turn-call',
        );
        expect(olderCalls).toHaveLength(2);
        expect(olderCalls[1]).toMatchObject({
            localId: olderTurnLocalId,
            args: { _acp: { title: 'Older enriched after intervening turns' } },
        });
        expect(messages.filter((message) => message.type === 'tool-result').at(-1)).toMatchObject({
            callId: 'older-turn-call',
            result: { output: 'richer', _acp: { kind: 'read' } },
        });
        expect(runtime.readCall('current-turn-call')).toMatchObject({ status: 'pending' });
    });

    it('normalizes legacy output aliases before canonical observation', () => {
        const { runtime, messages } = createFixture();
        runtime.handleRawUpdate({
            sessionUpdate: 'tool_call', toolCallId: 'alias', title: 'Fetch', kind: 'read', status: 'pending',
        });
        runtime.observePermission({ toolCallId: 'alias', toolName: 'web_fetch', input: { url: 'https://example.com' } });
        runtime.markRunningAfterPermission('alias');
        runtime.handleRawUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'alias',
            status: 'completed',
            title: 'web_fetch',
            output: { title: 'Example' },
        });

        expect(messages.filter((message) => message.type === 'tool-result')).toHaveLength(1);
    });
});
