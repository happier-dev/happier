import * as React from 'react';
import type { DetectedMcpServerV1 } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import type { McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import type { ValueRefV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';
import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { prepareDetectedMcpServerImportV1, prepareMcpServerImportV1 } from '@happier-dev/protocol/mcp/servers/import/mcpServerImportV1';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1, projectMcpServerActionFailureV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { buildMcpPastePreviewModel, buildMcpPasteValues, countOpenMcpPasteValues,
    EMPTY_MCP_PASTE_ANSWERS, type McpPasteAnswers } from '../add/mcpAddPaste';

export type McpFoundAdoptionState =
    | Readonly<{ status: 'idle' | 'choosing' | 'submitting' }>
    | Readonly<{ status: 'adopted'; serverId: string }>
    | Readonly<{ status: 'failed'; errorCode: string }>;

/** Discovery carries names only. The existing import preview owns all prompts and duplicate decisions. */
type Continuation = Readonly<{
    key: string;
    machineId: string;
    item: DetectedMcpServerV1;
    model: ReturnType<typeof buildMcpPastePreviewModel>;
    answers: McpPasteAnswers;
    state: McpFoundAdoptionState;
}>;

export function useMcpFoundAdoption(options: Readonly<{
    machineId: string | null;
    machineOnline: boolean | null;
    catalog: McpServerCatalogV1 | null;
    catalogRevision: number | 'absent' | null;
    execution: Pick<ReturnType<typeof useMountedActionExecution>, 'execute' | 'ready' | 'isCurrent'>;
    /** The selected Home/Account and machine binding; changing it retires unsaved choices. */
    scopeKey?: string;
}>) {
    const key = JSON.stringify([options.scopeKey, options.machineId]);
    const [stored, setStored] = React.useState<Continuation | null>(null);
    const active = React.useRef<Continuation | null>(null);
    const latest = React.useRef({ options, key });
    latest.current = { options, key };
    React.useEffect(() => () => { active.current = null; }, [key]);
    const publish = React.useCallback((value: Continuation | null) => {
        active.current = value;
        setStored(value);
    }, []);
    const cancel = React.useCallback(() => publish(null), [publish]);
    const submitContinuation = React.useCallback(async (draft: Continuation) => {
        const { options, key } = latest.current;
        const { execution } = options;
        if (active.current !== draft || key !== draft.key || options.machineOnline !== true || !execution.ready || !execution.isCurrent()
            || options.catalogRevision === null || !options.catalog) return;
        if (countOpenMcpPasteValues(draft.model, draft.answers) || draft.model.errors.length) return;
        const pending = { ...draft, state: { status: 'submitting' } as const };
        publish(pending);
        const current = () => active.current === pending && latest.current.key === draft.key && execution.isCurrent();
        try {
            const receipt = await execution.execute('mcp.found.adopt', {
                machineId: draft.machineId, expectedRevision: options.catalogRevision, items: [draft.item],
                values: buildMcpPasteValues(draft.model, draft.answers),
            });
            if (!current()) return;
            const imported = receipt.ok ? MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.found.adopt'].safeParse(receipt.result) : null;
            if (!imported?.success) {
                publish({ ...draft, state: { status: 'failed', errorCode: receipt.ok ? 'invalid_action_output' : receipt.errorCode } });
                return;
            }
            const serverId = imported.data.serverIds[0] ?? imported.data.duplicates.find(item => item.serverId)?.serverId;
            publish({ ...draft, state: serverId ? { status: 'adopted', serverId }
                : { status: 'failed', errorCode: 'invalid_action_output' } });
        } catch (error) {
            if (current()) publish({ ...draft, state: { status: 'failed', errorCode: projectMcpServerActionFailureV1(error).errorCode } });
        }
    }, [publish]);
    const begin = React.useCallback(async (item: DetectedMcpServerV1) => {
        const { options, key } = latest.current;
        if (options.machineOnline !== true || !options.execution.ready || !options.execution.isCurrent() || !options.machineId
            || !options.catalog || options.catalogRevision === null || active.current?.state.status === 'submitting') return;
        const model = buildMcpPastePreviewModel(prepareMcpServerImportV1({
            parsed: prepareDetectedMcpServerImportV1([item], options.machineId), catalog: options.catalog,
        }));
        const draft: Continuation = { key, machineId: options.machineId, item, model,
            answers: EMPTY_MCP_PASTE_ANSWERS, state: { status: 'choosing' } };
        publish(draft);
        if (!countOpenMcpPasteValues(model, draft.answers)) await submitContinuation(draft);
    }, [publish, submitContinuation]);
    const setValue = React.useCallback((id: string, value: ValueRefV1) => {
        const draft = active.current;
        if (!draft || draft.key !== latest.current.key || draft.state.status === 'submitting' || draft.state.status === 'adopted') return;
        publish({ ...draft, answers: { ...draft.answers, rows: { ...draft.answers.rows, [id]: value } }, state: { status: 'choosing' } });
    }, [publish]);
    const setField = React.useCallback((id: string, value: string) => {
        const draft = active.current;
        if (!draft || draft.key !== latest.current.key || draft.state.status === 'submitting' || draft.state.status === 'adopted') return;
        publish({ ...draft, answers: { ...draft.answers, fields: { ...draft.answers.fields, [id]: value } }, state: { status: 'choosing' } });
    }, [publish]);
    const submit = React.useCallback(async () => {
        const draft = active.current;
        if (draft && draft.state.status !== 'submitting' && draft.state.status !== 'adopted') await submitContinuation(draft);
    }, [submitContinuation]);
    const draft = stored?.key === key && options.execution.ready && options.execution.isCurrent() ? stored : null;
    const answers = draft?.answers ?? EMPTY_MCP_PASTE_ANSWERS;
    const openValues = draft ? countOpenMcpPasteValues(draft.model, answers) : 0;
    const canBegin = Boolean(options.machineOnline === true && options.machineId && options.execution.ready
        && options.execution.isCurrent() && options.catalog && options.catalogRevision !== null
        && draft?.state.status !== 'submitting');
    return { state: draft?.state ?? { status: 'idle' } as McpFoundAdoptionState,
        begin, setValue, setField, submit, cancel, openValues, item: draft?.item ?? null, model: draft?.model ?? null, answers, canBegin,
        canSubmit: Boolean(canBegin && draft && openValues === 0 && !draft.model.errors.length
            && draft.state.status !== 'submitting' && draft.state.status !== 'adopted'),
    };
}
