import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { AgentRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { createMcpCatalogPermissionChoiceV1 } from '@happier-dev/plugin-sdk/interactions';
import { NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE } from '@happier-dev/plugin-sdk/sessions';
import type { NativePermissionChoicesV1, SessionPermissionDecision, SessionPermissionDecisionResult, SessionPermissionsService } from '@happier-dev/plugin-sdk/sessions';
import { readMuseNativeJson, readMuseRecord } from './events.js';
import type { MuseMsp, MuseMspOpenOptions } from './msp.js';

type NativeRecord = ReturnType<typeof readMuseRecord>;
type Occurrence = { params: NativeRecord; signature: string; controller: AbortController };
type NativeMessage = Readonly<{ method: string; params?: JsonValue }>;
const QUESTION_SOURCE = 'muse.userInput';

function protocolError(message: string): PluginError {
    return new PluginError({ code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR', message });
}
function requiredString(record: NativeRecord, key: string): string {
    const value = record[key];
    if (typeof value !== 'string' || !value) throw protocolError(`Muse omitted ${key} from an interaction`);
    return value;
}
function mapDecision(value: JsonValue | undefined): SessionPermissionDecision | undefined {
    switch (value) {
        case 'approved': return 'approved';
        case 'approvedForSession': return 'approved_for_session';
        case 'approvedPolicyAmendment': return 'approved_execpolicy_amendment';
        case 'denied': case 'deniedPolicyAmendment': case 'timedOut': return 'denied';
        case 'abort': return 'abort';
        default: return undefined;
    }
}
function toolInput(params: NativeRecord): Record<string, JsonValue> {
    if (typeof params.rawArgs === 'string') {
        const parsed = readMuseNativeJson(params.rawArgs);
        return { ...(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? readMuseRecord(parsed) : { rawArgs: params.rawArgs }),
            nativeApproval: params.subject ?? null };
    }
    return { nativeApproval: params.subject ?? null };
}
function approvalChoices(params: NativeRecord, readNativeChildOrigin?: (subagentId: string) => Pick<NonNullable<NativePermissionChoicesV1['origin']>, 'subagentLabel'> | undefined): NativePermissionChoicesV1 {
    const requirement = readMuseRecord(params.currentRequirementId);
    requiredString(requirement, 'approvalId');
    if (typeof requirement.sourceIndex !== 'number') throw protocolError('Muse omitted the approval requirement source index');
    if (!Array.isArray(params.availableChoices)) throw protocolError('Muse omitted the offered approval choices');
    const choices = params.availableChoices.map(readMuseRecord).map((choice): NativePermissionChoicesV1['choices'][number] => {
        const decision = mapDecision(choice.decision);
        const scope = choice.scope;
        if (!decision || (scope !== 'once' && scope !== 'session' && scope !== 'localPersistent')) {
            throw new PluginError({ code: 'unsupported', message: 'Muse offered an unsupported approval decision or scope.' });
        }
        return { id: requiredString(choice, 'choiceId'), label: requiredString(choice, 'label'), decision, scope,
            ...(typeof choice.rulePreview === 'string' ? { rulePreview: choice.rulePreview } : {}),
            ...(choice.acceptsFeedback === true ? { allowsFeedback: true } : {}),
            response: { approved: decision !== 'denied' && decision !== 'abort', decision } };
    });
    const origin = readMuseRecord(params.subagentOrigin);
    const observedOrigin = typeof origin.subagentId === 'string' ? readNativeChildOrigin?.(origin.subagentId) : undefined;
    return { requirementId: JSON.stringify({ approvalId: requirement.approvalId, sourceIndex: requirement.sourceIndex }),
        source: 'muse', choices,
        ...(typeof origin.childSessionId === 'string' ? { origin: { ...observedOrigin, sessionId: origin.childSessionId,
            ...(typeof origin.subagentId === 'string' ? { subagentId: origin.subagentId } : {}) } } : {}) };
}
function questionInput(params: NativeRecord): Record<string, JsonValue> {
    if (!Array.isArray(params.questions)) throw protocolError('Muse omitted structured questions');
    return { questions: params.questions.map(readMuseRecord).map(question => {
        const selection = readMuseRecord(question.selection);
        const mode = selection.mode;
        if (mode !== 'single' && mode !== 'multiple') throw new PluginError({ code: 'unsupported', message: 'Muse offered an unsupported question selection.' });
        if (!Array.isArray(question.options)) throw protocolError('Muse omitted question options');
        const options = question.options.map(readMuseRecord).map(option => ({ id: requiredString(option, 'label'),
            label: requiredString(option, 'label'), ...(typeof option.description === 'string' ? { description: option.description } : {}) }));
        const min = typeof selection.minSelections === 'number' ? selection.minSelections : 1;
        const max = typeof selection.maxSelections === 'number' ? selection.maxSelections : options.length;
        return { id: requiredString(question, 'id'), question: requiredString(question, 'question'),
            ...(typeof question.header === 'string' ? { header: question.header } : {}),
            selection: mode, required: mode === 'single' || min > 0, allowCustom: true, allowNote: true, options,
            ...(mode === 'multiple' ? { minSelections: min, maxSelections: max } : {}) };
    }) };
}
function nativeAnswers(params: NativeRecord, decision: SessionPermissionDecisionResult): JsonValue[] {
    if (!Array.isArray(params.questions)) throw protocolError('Muse omitted structured questions');
    return params.questions.map(readMuseRecord).map(question => {
        const id = requiredString(question, 'id');
        const detail = decision.answerDetails?.[id];
        const labels = decision.answers?.[id] ?? [];
        if (detail?.freeText === undefined && readMuseRecord(question.selection).mode === 'single' && labels.length !== 1) {
            throw new PluginError({ code: 'unsupported', message: 'Muse requires an answer for each single-choice question.' });
        }
        return { questionId: id,
            ...(detail?.freeText !== undefined ? { freeText: detail.freeText }
                : readMuseRecord(question.selection).mode === 'multiple' ? { selectedLabels: [...labels] }
                    : { selectedLabel: labels[0]! }),
            ...(detail?.note !== undefined ? { note: detail.note } : {}) };
    });
}

/** Maps native interactions into the existing host pending and application owner. */
export function createMuseInteractions(options: Readonly<{
    context: AgentRuntimeContext;
    permissions?: SessionPermissionsService;
    command: MuseMsp['command'];
    onError?(error: unknown, params?: NativeRecord): void;
    onNativeQuestionSettlement?(params: NativeRecord): void;
    readNativeChildOrigin?(subagentId: string): Pick<NonNullable<NativePermissionChoicesV1['origin']>, 'subagentLabel'> | undefined;
}>) {
    const approvals = new Map<string, Occurrence>();
    const questions = new Map<string, Occurrence>();
    let disposed = false;
    const report = (error: unknown, params?: NativeRecord) => { if (!disposed) options.onError?.(error, params); };
    function present(kind: 'approval' | 'question', params: NativeRecord) {
        if (disposed) return;
        const permissions = options.permissions ?? options.context.services.sessions.current?.permissions;
        if (!permissions?.settleObservedDecision) throw new PluginError({ code: 'unsupported', message: 'Native Muse interaction settlement is unavailable.' });
        const id = requiredString(params, kind === 'approval' ? 'approvalId' : 'userInputId');
        requiredString(params, 'sessionId');
        const map = kind === 'approval' ? approvals : questions;
        const previous = map.get(id);
        const merged = { ...previous?.params, ...params };
        const nativeChoices = kind === 'approval' ? approvalChoices(merged, options.readNativeChildOrigin) : undefined;
        const signature = JSON.stringify(kind === 'approval' ? nativeChoices : merged.questions);
        if (previous?.signature === signature) { previous.params = merged; return; }
        const occurrence = { params: merged, signature, controller: previous?.controller ?? new AbortController() };
        map.set(id, occurrence);
        const signal = AbortSignal.any([options.context.signal, occurrence.controller.signal]);
        let catalogGrant: { choiceId: string; nativeChoiceId: string } | undefined;
        void permissions!.requestDecision({ requestId: id,
            toolName: kind === 'approval' && typeof merged.toolName === 'string' ? merged.toolName : kind === 'question' ? 'AskUserQuestion' : 'native_tool',
            source: kind === 'approval' ? NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE : QUESTION_SOURCE,
            input: kind === 'approval' ? toolInput(merged) : questionInput(merged),
            ...(nativeChoices ? { nativeChoices } : {}),
        }, { signal,
            ...(nativeChoices ? { buildNativeChoices: ({ mcpTool }: Readonly<{ mcpTool: Parameters<typeof createMcpCatalogPermissionChoiceV1>[0]['mcpTool'] }>) => {
                const grant = nativeChoices.choices.find(choice => choice.decision === 'approved' && choice.scope === 'once')
                    ?? nativeChoices.choices.find(choice => choice.decision === 'approved_for_session' && choice.scope === 'session');
                if (!grant) return nativeChoices;
                const catalogChoice = createMcpCatalogPermissionChoiceV1({ mcpTool, grant, existingChoices: nativeChoices.choices });
                // Catalog persistence belongs to the host follow-up; Muse only receives its offered grant.
                catalogGrant = catalogChoice ? { choiceId: catalogChoice.id, nativeChoiceId: grant.id } : undefined;
                return catalogChoice ? { ...nativeChoices, choices: [...nativeChoices.choices, catalogChoice] } : nativeChoices;
            } } : {}),
            async acknowledgeDecisionApplication(decision) {
            if (kind === 'approval') {
                const answer = decision.nativeChoice;
                if (!answer) throw protocolError('The host returned no offered native approval choice');
                await options.command('approval/decide', { sessionId: merged.sessionId!, approvalId: id,
                    requirementId: merged.currentRequirementId!,
                    choiceId: catalogGrant?.choiceId === answer.choiceId ? catalogGrant.nativeChoiceId : answer.choiceId,
                    ...(answer.feedback !== undefined ? { feedback: answer.feedback } : {}) }, { signal });
            } else {
                await options.command('userInput/answer', { sessionId: merged.sessionId!, userInputId: id,
                    answers: nativeAnswers(merged, decision) }, { signal });
            }
        } }).catch(error => { if (!signal.aborted) report(error, occurrence.params); }).finally(() => {
            if (map.get(id) === occurrence) map.delete(id);
        });
    }
    function settle(kind: 'approval' | 'question', params: NativeRecord) {
        const id = requiredString(params, kind === 'approval' ? 'approvalId' : 'userInputId');
        const map = kind === 'approval' ? approvals : questions;
        const occurrence = map.get(id);
        if (!occurrence) return;
        const permissions = options.permissions ?? options.context.services.sessions.current?.permissions;
        if (kind === 'question' && params.outcome !== 'answered') {
            // Native settled is the durable authority boundary, including open
            // outcomes. Retire its existing host occurrence without inventing
            // a person's answer; retain exact native facts for presentation.
            try { options.onNativeQuestionSettlement?.({ ...occurrence.params, ...params }); }
            finally { occurrence.controller.abort(); }
            return;
        }
        const decision = kind === 'approval' ? mapDecision(params.decision) : 'approved';
        if (!decision) { report(new PluginError({ code: 'unsupported', message: 'Muse returned an unsupported native interaction settlement.' }), params); return; }
        const answers: Record<string, readonly string[]> = {};
        const answerDetails: Record<string, { freeText?: string; note?: string }> = {};
        if (kind === 'question' && Array.isArray(params.answers)) {
            for (const value of params.answers) {
                const answer = readMuseRecord(value);
                const key = requiredString(answer, 'questionId');
                answers[key] = typeof answer.selectedLabel === 'string' ? [answer.selectedLabel]
                    : Array.isArray(answer.selectedLabels) ? answer.selectedLabels.filter((label): label is string => typeof label === 'string') : [];
                answerDetails[key] = { ...(typeof answer.freeText === 'string' ? { freeText: answer.freeText } : {}),
                    ...(typeof answer.note === 'string' ? { note: answer.note } : {}) };
            }
        }
        void permissions!.settleObservedDecision!({ requestId: id,
            source: kind === 'approval' ? NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE : QUESTION_SOURCE,
            decision: decision === 'approved_for_session' || decision === 'approved_execpolicy_amendment' ? 'approved' : decision,
            ...(kind === 'question' ? { answers, answerDetails } : {}),
        }).catch(error => report(error, params));
    }
    const onRequest: NonNullable<MuseMspOpenOptions['onRequest']> = {
        'approval/request': async request => { const params = readMuseRecord(request.params);
            try { present('approval', params); return {}; } catch (error) { report(error, params); throw error; } },
        'userInput/request': async request => { const params = readMuseRecord(request.params);
            try { present('question', params); return {}; } catch (error) { report(error, params); throw error; } },
    };
    return { onRequest,
        observe(message: NativeMessage): boolean {
            try {
                switch (message.method) {
                    case 'approval/requested': case 'approval/updated': present('approval', readMuseRecord(message.params)); return true;
                    case 'userInput/requested': present('question', readMuseRecord(message.params)); return true;
                    case 'approval/resolved': settle('approval', readMuseRecord(message.params)); return true;
                    case 'userInput/settled': settle('question', readMuseRecord(message.params)); return true;
                    default: return false;
                }
            } catch (error) { report(error, readMuseRecord(message.params)); return true; }
        },
        dispose() { disposed = true; for (const map of [approvals, questions]) {
            for (const occurrence of map.values()) occurrence.controller.abort();
            map.clear();
        } },
    };
}
