/**
 * Sanitized structural replay ported from the approved Phase 13 capture
 * contract. It deliberately contains no captured user content or filesystem
 * paths; the order and cardinalities are the documented evidence.
 */
export type CapturedCursorReplay = Readonly<{
    updates: readonly Readonly<Record<string, unknown>>[];
    lateEnrichment: readonly Readonly<Record<string, unknown>>[];
}>;

const CAPTURED_LOGICAL_TOOL_ORDER =
    'cmrrrrrsrsssrrrssrsssssssssbrrrrrrsbsssssbbsssrrrsbbbsssrrrsbrsrrbrsrrssssrrsreesrsbsrersebebbssrrrsrrrssrrrsrrssssrrrrrreeebreeeesessseebbssbbbbbbrbbssbrsbbrsrsorssssrssrsssrrsrsrrebreeberebebbbbborssrebesrebebbbbbebrssrsebbbrboeebebobbbbbbbbssrrrssrroosssrrrrrrsrssrrmo';

type ToolFamily = 'c' | 'm' | 'r' | 's' | 'b' | 'e' | 'o';

function addResultBearingTool(
    updates: Array<Readonly<Record<string, unknown>>>,
    params: Readonly<{
        id: string;
        kind: string;
        title: string;
        input: Record<string, unknown>;
        output: Record<string, unknown>;
        status?: 'completed' | 'failed' | 'cancelled';
        enrichment?: Record<string, unknown>;
    }>,
    duplicateTerminal = false,
): void {
    updates.push(Object.freeze({
        sessionUpdate: 'tool_call', toolCallId: params.id, title: params.title, kind: params.kind,
        status: 'pending', rawInput: Object.freeze(params.input),
    }));
    if (params.enrichment) {
        updates.push(Object.freeze({
            sessionUpdate: 'tool_call_update', toolCallId: params.id, title: params.title, kind: params.kind,
            status: 'in_progress', rawInput: Object.freeze(params.enrichment),
        }));
    }
    const terminal = Object.freeze({
        sessionUpdate: 'tool_call_update', toolCallId: params.id, title: params.title, kind: params.kind,
        status: params.status ?? 'completed', rawOutput: Object.freeze(params.output),
    });
    updates.push(terminal);
    if (duplicateTerminal) updates.push(Object.freeze({ ...terminal }));
}

function buildUpdates(): readonly Readonly<Record<string, unknown>>[] {
    const updates: Array<Readonly<Record<string, unknown>>> = [];
    const counts: Record<ToolFamily, number> = { c: 0, m: 0, r: 0, s: 0, b: 0, e: 0, o: 0 };

    for (const family of CAPTURED_LOGICAL_TOOL_ORDER as Iterable<ToolFamily>) {
        const index = ++counts[family];
        const suffix = String(index).padStart(3, '0');
        if (family === 'o' && index === 7) {
            updates.push(Object.freeze({
                sessionUpdate: 'tool_call', toolCallId: 'captured-create-plan-001', title: 'Create Plan', kind: 'other',
                status: 'pending', rawInput: Object.freeze({ _toolName: 'createPlan' }),
            }));
            updates.push(Object.freeze({
                sessionUpdate: 'tool_call_update', toolCallId: 'captured-create-plan-001', title: 'Create Plan', kind: 'other',
                status: 'in_progress', rawInput: Object.freeze({ _toolName: 'createPlan' }),
            }));
            continue;
        }
        const kind = family === 'c' ? 'change_title' : family === 'm' ? 'switch_mode' : family === 'r' ? 'read'
            : family === 's' ? 'search' : family === 'b' ? 'execute' : family === 'e' ? 'edit' : 'other';
        const prefix = family === 'c' ? 'change-title' : family === 'm' ? 'switch-mode' : family === 'r' ? 'read'
            : family === 's' ? 'search' : family === 'b' ? 'bash' : family === 'e' ? 'edit' : 'task';
        const id = `captured-${prefix}-${suffix}`;
        const title = family === 'e' ? `Edit sanitized-${suffix}.txt` : family === 'o' ? `Task ${index}` : `${kind} sanitized ${suffix}`;
        if (family === 'r' && index === 1) {
            updates.push(Object.freeze({
                sessionUpdate: 'tool_call_update', toolCallId: id, title, kind,
                status: 'completed', rawOutput: Object.freeze({ path: `sanitized-${suffix}.txt`, text: 'sanitized' }),
            }));
            continue;
        }
        const input = family === 'e'
            ? { path: `sanitized-${suffix}.txt` }
            : family === 'o'
                ? { _toolName: 'task', description: `Sanitized task ${index}` }
                : family === 'b'
                    ? { command: ['printf', suffix] }
                    : family === 'r'
                        ? { path: `sanitized-${suffix}.txt` }
                        : family === 's'
                            ? { query: `sanitized-${suffix}` }
                            : { value: `sanitized-${suffix}` };
        const output = family === 'o'
            ? { completed: true, task: index }
            : family === 'b'
                ? index === 56
                    ? { error: 'sanitized failure' }
                    : index === 57
                        ? { cancelled: true }
                        : { output: suffix }
                : family === 'r'
                    ? { path: `sanitized-${suffix}.txt`, text: 'sanitized' }
                    : family === 's'
                        ? { totalMatches: index % 5, truncated: index % 11 === 0 }
                        : { completed: true, value: suffix };
        addResultBearingTool(updates, {
            id,
            kind,
            title,
            input,
            output,
            ...(family === 'e' ? { enrichment: { path: `sanitized-${suffix}.txt`, old_string: 'before', new_string: 'after' } } : {}),
            ...(family === 'b' && index >= 56 ? { status: index === 56 ? 'failed' : 'cancelled' } : {}),
        }, family === 'e' || (family === 'r' && index === 2));
    }
    return Object.freeze(updates);
}

export const CURSOR_CAPTURED_REPLAY_V1: CapturedCursorReplay = Object.freeze({
    updates: buildUpdates(),
    // This terminal arrives after the turn closes. It changes the card, not
    // the result payload, so its existing result local ID is not republished.
    lateEnrichment: Object.freeze([Object.freeze({
        sessionUpdate: 'tool_call_update', toolCallId: 'captured-edit-001', title: 'Edit sanitized-001.txt (final)',
        kind: 'edit', status: 'completed', rawOutput: Object.freeze({ completed: true, value: '001' }),
    })]),
});
