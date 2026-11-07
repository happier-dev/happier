import * as React from 'react';
import { readUnexpectedActionErrorDiagnosticV1, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { BotTemplateSourceSessionRefV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { BotTemplateUpdateDiffResultV1Schema, BotTemplateUpdateApplyResultV1Schema, BotTemplateFollowResultV1Schema,
    BotTemplateUpdateFailureDetailsV1Schema,
    type BotTemplateUpdateDiffResultV1, type BotTemplateUpdateApplyInputV1,
    type BotTemplateUpdateApplyResultV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';

type Failure = Extract<ActionExecuteResult, { ok: false }>;
function failed(error: unknown): Failure {
    const errorCode = readUnexpectedActionErrorDiagnosticV1(error).errorCode ?? 'unexpected_error';
    return { ok: false, errorCode, error: errorCode };
}
type Mutation = Readonly<{ kind: 'idle' | 'applying' | 'skipping' | 'stopping' }>
    | Readonly<{ kind: 'updated'; result: BotTemplateUpdateApplyResultV1 }>
    | Readonly<{ kind: 'skipped' | 'stopped' }>
    | Readonly<{ kind: 'failed'; result: Failure }>;

/** One demanded comparison; mutations retain the reviewed revisions until a deliberate new review. */
export function useBotTemplateUpdate(sessionRef: BotTemplateSourceSessionRefV1) {
    const execution = useMountedActionExecution(sessionRef.serverId);
    const key = JSON.stringify([sessionRef, execution.binding?.scope, execution.binding?.revision]);
    const currentKey = React.useRef(key);
    currentKey.current = key;
    const target = React.useMemo(() => sessionRef, [key]);
    const [read, setRead] = React.useState<Readonly<{ key: string; review: BotTemplateUpdateDiffResultV1 | null; errorCode: string | null }>>(
        { key, review: null, errorCode: null });
    const [mutation, setMutation] = React.useState<Mutation>({ kind: 'idle' });
    const recovery = React.useRef<Readonly<{ key: string; value: BotTemplateUpdateApplyInputV1['recovery'] }> | null>(null);
    const reload = React.useCallback(async () => {
        if (!execution.ready) return;
        const result = await execution.execute('template.updates.diff', { sessionRef: target }).catch(failed);
        if (currentKey.current !== key || !execution.isCurrent()) return;
        const parsed = result.ok ? BotTemplateUpdateDiffResultV1Schema.safeParse(result.result) : null;
        setRead(previous => parsed?.success ? { key, review: parsed.data, errorCode: null }
            : { key, review: previous.key === key ? previous.review : null,
                errorCode: result.ok ? 'invalid_result' : result.errorCode ?? 'template_update_unavailable' });
        if (parsed?.success) setMutation({ kind: 'idle' });
    }, [execution.ready, execution.execute, execution.isCurrent, key, target]);
    React.useEffect(() => { void reload(); }, [reload]);
    const apply = React.useCallback(async (input: BotTemplateUpdateApplyInputV1) => {
        setMutation({ kind: 'applying' });
        const result = await execution.execute('template.updates.apply', { ...input,
            ...(recovery.current?.key === key ? { recovery: recovery.current.value } : {}) }, { confirmed: true }).catch(failed);
        if (currentKey.current !== key || !execution.isCurrent()) return;
        const parsed = result.ok ? BotTemplateUpdateApplyResultV1Schema.safeParse(result.result) : null;
        if (parsed?.success) recovery.current = null;
        else if (!result.ok) {
            const partial = BotTemplateUpdateFailureDetailsV1Schema.safeParse(result.details);
            if (partial.success) recovery.current = { key, value: { skillIds: partial.data.skillIds ?? {}, mcpServerIds: partial.data.mcpServerIds ?? {},
                ...(partial.data.acceptedBaseId ? { acceptedBaseId: partial.data.acceptedBaseId } : {}) } };
        }
        setMutation(parsed?.success ? { kind: 'updated', result: parsed.data } : { kind: 'failed', result: result.ok
            ? { ok: false, errorCode: 'invalid_result', error: 'invalid_result' } : result });
    }, [execution.execute, execution.isCurrent, key]);
    const skip = React.useCallback(async (version: string) => {
        setMutation({ kind: 'skipping' });
        const result = await execution.execute('template.updates.skip', { sessionRef: target, version }).catch(failed);
        if (currentKey.current !== key || !execution.isCurrent()) return;
        const parsed = result.ok ? BotTemplateFollowResultV1Schema.safeParse(result.result) : null;
        setMutation(parsed?.success ? { kind: 'skipped' } : { kind: 'failed', result: result.ok
            ? { ok: false, errorCode: 'invalid_result', error: 'invalid_result' } : result });
    }, [execution.execute, execution.isCurrent, key, target]);
    const stop = React.useCallback(async () => {
        setMutation({ kind: 'stopping' });
        const result = await execution.execute('template.follow.stop', { sessionRef: target }).catch(failed);
        if (currentKey.current !== key || !execution.isCurrent()) return;
        const parsed = result.ok ? BotTemplateFollowResultV1Schema.safeParse(result.result) : null;
        setMutation(parsed?.success ? { kind: 'stopped' } : { kind: 'failed', result: result.ok
            ? { ok: false, errorCode: 'invalid_result', error: 'invalid_result' } : result });
    }, [execution.execute, execution.isCurrent, key, target]);
    return { review: read.key === key ? read.review : null, errorCode: read.key === key ? read.errorCode : null,
        mutation, reload, apply, skip, stop, execution };
}
