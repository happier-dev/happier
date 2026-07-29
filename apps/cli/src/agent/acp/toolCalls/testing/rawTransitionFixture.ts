export type SharedRawAcpToolTransition = Readonly<{
    name: string;
    toolCallId: string;
    updates: readonly Readonly<Record<string, unknown>>[];
    closeTurnBeforeLateUpdates?: boolean;
    beginNewTurnBeforeLateUpdates?: boolean;
    lateUpdates?: readonly Readonly<Record<string, unknown>>[];
    expected: Readonly<{
        toolName: string;
        title: string;
        kind: string | null;
        status: string;
        rawInput: unknown;
        rawOutput: unknown;
        resultCount: number;
        distinctCallLocalIds?: number;
    }>;
}>;

export const SHARED_RAW_ACP_TOOL_TRANSITIONS: readonly SharedRawAcpToolTransition[] = Object.freeze([
    Object.freeze({
        name: 'sparse create enriches before terminal output',
        toolCallId: 'shared-sparse',
        updates: Object.freeze([
            Object.freeze({
                sessionUpdate: 'tool_call',
                toolCallId: 'shared-sparse',
                title: 'Sparse title',
                kind: 'read',
                status: 'pending',
            }),
            Object.freeze({
                sessionUpdate: 'tool_call_update',
                toolCallId: 'shared-sparse',
                title: 'Enriched title',
                status: 'in_progress',
                rawInput: Object.freeze({ path: 'README.md' }),
            }),
            Object.freeze({
                sessionUpdate: 'tool_call_update',
                toolCallId: 'shared-sparse',
                status: 'completed',
                rawOutput: Object.freeze({ text: 'done' }),
            }),
        ]),
        expected: Object.freeze({
            toolName: 'read',
            title: 'Enriched title',
            kind: 'read',
            status: 'completed',
            rawInput: Object.freeze({ path: 'README.md' }),
            rawOutput: Object.freeze({ text: 'done' }),
            resultCount: 1,
        }),
    }),
    Object.freeze({
        name: 'terminal-only update creates one failed result',
        toolCallId: 'shared-terminal-only',
        updates: Object.freeze([
            Object.freeze({
                sessionUpdate: 'tool_call_update',
                toolCallId: 'shared-terminal-only',
                title: 'Terminal only',
                kind: 'execute',
                status: 'failed',
                rawInput: Object.freeze({ command: 'false' }),
                rawOutput: Object.freeze({ exitCode: 1 }),
            }),
        ]),
        expected: Object.freeze({
            toolName: 'execute',
            title: 'Terminal only',
            kind: 'execute',
            status: 'failed',
            rawInput: Object.freeze({ command: 'false' }),
            rawOutput: Object.freeze({ exitCode: 1 }),
            resultCount: 1,
        }),
    }),
    Object.freeze({
        name: 'result-less turn terminalization publishes one synthetic result',
        toolCallId: 'shared-resultless',
        updates: Object.freeze([
            Object.freeze({
                sessionUpdate: 'tool_call',
                toolCallId: 'shared-resultless',
                title: 'Create plan',
                kind: 'other',
                status: 'pending',
                rawInput: Object.freeze({ goal: 'Plan only' }),
            }),
        ]),
        closeTurnBeforeLateUpdates: true,
        expected: Object.freeze({
            toolName: 'other',
            title: 'Create plan',
            kind: 'other',
            status: 'completed',
            rawInput: Object.freeze({ goal: 'Plan only' }),
            rawOutput: undefined,
            resultCount: 1,
        }),
    }),
    Object.freeze({
        name: 'late provider output enriches a retained terminal tombstone once',
        toolCallId: 'shared-late-result',
        updates: Object.freeze([
            Object.freeze({
                sessionUpdate: 'tool_call',
                toolCallId: 'shared-late-result',
                title: 'Initial title',
                kind: 'read',
                status: 'pending',
                rawInput: Object.freeze({ path: 'late.txt' }),
            }),
        ]),
        closeTurnBeforeLateUpdates: true,
        lateUpdates: Object.freeze([
            Object.freeze({
                sessionUpdate: 'tool_call_update',
                toolCallId: 'shared-late-result',
                title: 'Final title',
                status: 'completed',
                rawOutput: Object.freeze({ text: 'late' }),
            }),
            Object.freeze({
                sessionUpdate: 'tool_call_update',
                toolCallId: 'shared-late-result',
                title: 'Final title',
                status: 'completed',
                rawOutput: Object.freeze({ text: 'late' }),
            }),
        ]),
        expected: Object.freeze({
            toolName: 'read',
            title: 'Final title',
            kind: 'read',
            status: 'completed',
            rawInput: Object.freeze({ path: 'late.txt' }),
            rawOutput: Object.freeze({ text: 'late' }),
            resultCount: 2,
        }),
    }),
    Object.freeze({
        name: 'hostile exact id remains public while operational identity is bounded',
        toolCallId: ' hostile\n\0'.repeat(8_192),
        updates: Object.freeze([
            Object.freeze({
                sessionUpdate: 'tool_call_update',
                toolCallId: ' hostile\n\0'.repeat(8_192),
                title: 'Hostile ID',
                kind: 'search',
                status: 'completed',
                rawInput: Object.freeze({ query: 'needle' }),
                rawOutput: Object.freeze({ matches: 1 }),
            }),
        ]),
        expected: Object.freeze({
            toolName: 'search',
            title: 'Hostile ID',
            kind: 'search',
            status: 'completed',
            rawInput: Object.freeze({ query: 'needle' }),
            rawOutput: Object.freeze({ matches: 1 }),
            resultCount: 1,
        }),
    }),
    Object.freeze({
        name: 'same exact raw id in a later turn gets a new operational identity',
        toolCallId: 'shared-reused-id',
        updates: Object.freeze([
            Object.freeze({
                sessionUpdate: 'tool_call',
                toolCallId: 'shared-reused-id',
                title: 'First turn',
                kind: 'read',
                status: 'completed',
                rawInput: Object.freeze({ path: 'first.txt' }),
                rawOutput: Object.freeze({ text: 'first' }),
            }),
        ]),
        closeTurnBeforeLateUpdates: true,
        beginNewTurnBeforeLateUpdates: true,
        lateUpdates: Object.freeze([
            Object.freeze({
                sessionUpdate: 'tool_call',
                toolCallId: 'shared-reused-id',
                title: 'Second turn',
                kind: 'read',
                status: 'completed',
                rawInput: Object.freeze({ path: 'second.txt' }),
                rawOutput: Object.freeze({ text: 'second' }),
            }),
        ]),
        expected: Object.freeze({
            toolName: 'read',
            title: 'Second turn',
            kind: 'read',
            status: 'completed',
            rawInput: Object.freeze({ path: 'second.txt' }),
            rawOutput: Object.freeze({ text: 'second' }),
            resultCount: 2,
            distinctCallLocalIds: 2,
        }),
    }),
]);
