import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch, type ServerFetch } from '@/sync/http/client';
import {
    AutomationAssignmentUpdateRequestSchema,
    AutomationV3ClearRunHistoryResponseSchema,
    AutomationDeleteResponseSchema,
    AutomationDefinitionDetailSchema,
    AutomationDefinitionListResponseSchema,
    AutomationDefinitionListRequestSchema,
    AutomationDefinitionCreateRequestSchema,
    AutomationDefinitionPatchRequestSchema,
    AutomationDefinitionReconcileRequestSchema,
    AutomationV3RunDetailSchema,
    AutomationV3RunMutationResponseSchema,
    AutomationV3RunReplyHandoffRedeliverRequestSchema,
    AutomationV3SettingsSchema,
    AutomationV3SettingsUpdateRequestSchema,
    type AutomationV3ClearRunHistoryResponse,
    type AutomationDefinitionDetail,
    type AutomationDefinitionListRequest,
    type AutomationDefinitionListResponse,
    type AutomationDefinitionCreateRequest,
    type AutomationDefinitionPatchRequest,
    type AutomationDefinitionReconcileRequest,
    type AutomationV3RunDetail,
    type AutomationV3RunListItem,
    type AutomationV3RunMutationResponse,
    type AutomationV3Settings,
    type AutomationV3SettingsUpdateRequest,
} from '@happier-dev/protocol/automations/automationApiV3';

import {
    AutomationApiError,
    getAutomationAuthHeaders,
    readAutomationJsonOrThrow,
} from './apiAutomationHttp';

export { AutomationApiError, isAutomationApiErrorCode } from './apiAutomationHttp';

export type AutomationAssignmentInput = Readonly<{
    machineId: string;
    enabled?: boolean;
    priority?: number;
}>;

/** A Sync-captured direct request for one applied Home. */
export type AutomationRequestContext = Readonly<{
    request: ServerFetch;
    serverId: string;
}>;

function requestAutomation(
    context: AutomationRequestContext | undefined,
    path: string,
    init?: RequestInit,
): Promise<Response> {
    return (context?.request ?? serverFetch)(path, init, { includeAuth: false });
}

/**
 * Current list items deliberately exclude private definition and recipe
 * content. Consumers that need those bytes must read the exact definition.
 */
export async function listAutomationDefinitions(
    credentials: AuthCredentials,
    params: Readonly<Partial<AutomationDefinitionListRequest>> = {},
    context?: AutomationRequestContext,
): Promise<AutomationDefinitionListResponse> {
    const query = AutomationDefinitionListRequestSchema.parse(params);
    const search = new URLSearchParams({ limit: String(query.limit) });
    if (query.cursor) search.set('cursor', query.cursor);
    // The server's indexed filters serve trigger-set lookups without an Account-wide scan.
    if (query.workflowDefinitionId !== undefined) search.set('workflowDefinitionId', query.workflowDefinitionId);
    if (query.scopeSessionId !== undefined) search.set('scopeSessionId', query.scopeSessionId);
    if (query.scope !== undefined) search.set('scope', query.scope);
    const response = await requestAutomation(context, `/v3/automations?${search.toString()}`, {
        headers: getAutomationAuthHeaders(credentials),
    });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationDefinitionListResponseSchema.parse(raw);
}

/** Account-scoped settings are read through their strict owner, never inferred from definitions or runs. */
export async function getAutomationSettings(
    credentials: AuthCredentials,
    context?: AutomationRequestContext,
): Promise<AutomationV3Settings> {
    const response = await requestAutomation(context, '/v3/automations/settings', {
        headers: getAutomationAuthHeaders(credentials),
    });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3SettingsSchema.parse(raw);
}

/** A complete strict record replaces the server-owned Automation settings projection. */
export async function updateAutomationSettings(
    credentials: AuthCredentials,
    input: AutomationV3SettingsUpdateRequest,
    context?: AutomationRequestContext,
): Promise<AutomationV3Settings> {
    const body = AutomationV3SettingsUpdateRequestSchema.parse(input);
    const response = await requestAutomation(context, '/v3/automations/settings', {
        method: 'PUT',
        headers: getAutomationAuthHeaders(credentials, { includeJsonContentType: true }),
        body: JSON.stringify(body),
    });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3SettingsSchema.parse(raw);
}

/** Direct authenticated definition read; this is the only UI API that returns private Event authoring content. */
export async function getAutomationDefinition(
    credentials: AuthCredentials,
    automationId: string,
    context?: AutomationRequestContext,
): Promise<AutomationDefinitionDetail> {
    const response = await requestAutomation(context, `/v3/automations/${encodeURIComponent(automationId)}`, {
        headers: getAutomationAuthHeaders(credentials),
    });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationDefinitionDetailSchema.parse(raw);
}

export async function createAutomationDefinition(
    credentials: AuthCredentials,
    input: AutomationDefinitionCreateRequest,
    context?: AutomationRequestContext,
): Promise<AutomationDefinitionDetail> {
    const body = AutomationDefinitionCreateRequestSchema.parse(input);
    const response = await requestAutomation(context, '/v3/automations', {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials, { includeJsonContentType: true }),
        body: JSON.stringify(body),
    });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationDefinitionDetailSchema.parse(raw);
}

export async function updateAutomationDefinition(
    credentials: AuthCredentials,
    automationId: string,
    input: AutomationDefinitionPatchRequest,
    context?: AutomationRequestContext,
): Promise<AutomationDefinitionDetail> {
    const body = AutomationDefinitionPatchRequestSchema.parse(input);
    const response = await requestAutomation(context, `/v3/automations/${encodeURIComponent(automationId)}`, {
        method: 'PATCH',
        headers: getAutomationAuthHeaders(credentials, { includeJsonContentType: true }),
        body: JSON.stringify(body),
    });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationDefinitionDetailSchema.parse(raw);
}

/** One visible full-editor Save, committed by the canonical server owner. */
export async function reconcileAutomationDefinition(
    credentials: AuthCredentials,
    automationId: string,
    input: AutomationDefinitionReconcileRequest,
    context?: AutomationRequestContext,
): Promise<AutomationDefinitionDetail> {
    const body = AutomationDefinitionReconcileRequestSchema.parse(input);
    const response = await requestAutomation(context, `/v3/automations/${encodeURIComponent(automationId)}`, {
        method: 'PUT',
        headers: getAutomationAuthHeaders(credentials, { includeJsonContentType: true }),
        body: JSON.stringify(body),
    });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationDefinitionDetailSchema.parse(raw);
}

/** Lifecycle mutations remain on the definition owner for Event Automations. */
export async function pauseAutomationDefinition(
    credentials: AuthCredentials,
    automationId: string,
    context?: AutomationRequestContext,
): Promise<AutomationDefinitionDetail> {
    const response = await requestAutomation(context, `/v3/automations/${encodeURIComponent(automationId)}/pause`, {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials),
    });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationDefinitionDetailSchema.parse(raw);
}

export async function resumeAutomationDefinition(
    credentials: AuthCredentials,
    automationId: string,
    context?: AutomationRequestContext,
): Promise<AutomationDefinitionDetail> {
    const response = await requestAutomation(context, `/v3/automations/${encodeURIComponent(automationId)}/resume`, {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials),
    });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationDefinitionDetailSchema.parse(raw);
}

export async function replaceAutomationDefinitionAssignments(
    credentials: AuthCredentials,
    automationId: string,
    assignments: ReadonlyArray<AutomationAssignmentInput>,
    context?: AutomationRequestContext,
): Promise<AutomationDefinitionDetail> {
    const body = AutomationAssignmentUpdateRequestSchema.parse({ assignments });
    const response = await requestAutomation(context, `/v3/automations/${encodeURIComponent(automationId)}/assignments`, {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials, { includeJsonContentType: true }),
        body: JSON.stringify(body),
    });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationDefinitionDetailSchema.parse(raw);
}

/**
 * Admits one occurrence and returns the whole receipt.
 *
 * The receipt's optional `workflowRun` is the server's explicit statement that
 * this admitted Run is a managed workflow, and the Protocol schema already
 * proves its id is the returned Run's id. Keeping it here is what lets a caller
 * open the exact managed Run instead of guessing from a recipe shape or
 * reaching for the newest history row. A legacy receipt simply omits it, and
 * callers must not synthesize one.
 */
export async function runAutomationDefinitionNow(
    credentials: AuthCredentials,
    automationId: string,
    context?: AutomationRequestContext,
    options?: Readonly<{ idempotencyKey?: string }>,
): Promise<AutomationV3RunMutationResponse> {
    const response = await requestAutomation(context, `/v3/automations/${encodeURIComponent(automationId)}/run-now`, {
        method: 'POST',
        headers: { ...getAutomationAuthHeaders(credentials), ...(options?.idempotencyKey === undefined
            ? {} : { 'Idempotency-Key': options.idempotencyKey }) },
    }).catch((cause: unknown) => {
        throw Object.assign(new Error('workflow_outcome_unresolved', { cause }), { code: 'workflow_outcome_unresolved' });
    });
    let raw: unknown;
    try {
        raw = await readAutomationJsonOrThrow(response);
    } catch (cause) {
        if (cause instanceof AutomationApiError) {
            const code = cause.status === 401 || cause.status === 403 ? 'not_authenticated' : cause.code;
            throw Object.assign(cause, { code });
        }
        throw Object.assign(new Error('workflow_outcome_unresolved', { cause }), { code: 'workflow_outcome_unresolved' });
    }
    try {
        return AutomationV3RunMutationResponseSchema.parse(raw);
    } catch (cause) {
        throw Object.assign(new Error('workflow_outcome_unresolved', { cause }), { code: 'workflow_outcome_unresolved' });
    }
}

/** Direct Run detail stays route-owned; the bounded Run list never carries these private envelopes. */
export async function getAutomationRunDetail(
    credentials: AuthCredentials,
    automationId: string,
    runId: string,
    context?: AutomationRequestContext,
): Promise<AutomationV3RunDetail> {
    const response = await requestAutomation(
        context,
        `/v3/automations/${encodeURIComponent(automationId)}/runs/${encodeURIComponent(runId)}`,
        { headers: getAutomationAuthHeaders(credentials) },
    );
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3RunDetailSchema.parse(raw);
}

/** Removes only server-eligible terminal Run history for one Automation. */
export async function clearAutomationRunHistory(
    credentials: AuthCredentials,
    automationId: string,
    context?: AutomationRequestContext,
): Promise<AutomationV3ClearRunHistoryResponse> {
    const response = await requestAutomation(context, `/v3/automations/${encodeURIComponent(automationId)}/runs/clear-history`, {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials),
    });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3ClearRunHistoryResponseSchema.parse(raw);
}

/** Cancellation remains one Run mutation; callers receive the refreshed bounded Run projection. */
export async function cancelAutomationRun(
    credentials: AuthCredentials,
    runId: string,
    context?: AutomationRequestContext,
): Promise<AutomationV3RunListItem> {
    const response = await requestAutomation(context, `/v3/automations/runs/${encodeURIComponent(runId)}/cancel`, {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials),
    });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3RunMutationResponseSchema.parse(raw).run;
}

/** Requeues the existing frozen reply handoff; the server preserves its custody identity. */
export async function retryAutomationReplyHandoff(
    credentials: AuthCredentials,
    runId: string,
    context?: AutomationRequestContext,
): Promise<AutomationV3RunListItem> {
    const response = await requestAutomation(
        context,
        `/v3/automations/runs/${encodeURIComponent(runId)}/retry-reply-handoff`,
        {
            method: 'POST',
            headers: getAutomationAuthHeaders(credentials),
        },
    );
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3RunMutationResponseSchema.parse(raw).run;
}

/**
 * Authorizes one further delivery of an accepted result. The exact revision the
 * user acted on travels with the request: the server mints the Run's next
 * distinct delivery identity only for that revision, so a repeated press or a
 * lost response cannot turn one decision into two messages.
 */
export async function deliverAutomationResultAgain(
    credentials: AuthCredentials,
    input: Readonly<{ runId: string; expectedRevision: number }>,
    context?: AutomationRequestContext,
): Promise<AutomationV3RunListItem> {
    const body = AutomationV3RunReplyHandoffRedeliverRequestSchema.parse({
        expectedRevision: input.expectedRevision,
    });
    const response = await requestAutomation(
        context,
        `/v3/automations/runs/${encodeURIComponent(input.runId)}/deliver-result-again`,
        {
            method: 'POST',
            headers: getAutomationAuthHeaders(credentials, { includeJsonContentType: true }),
            body: JSON.stringify(body),
        },
    );
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3RunMutationResponseSchema.parse(raw).run;
}

export async function deleteAutomationDefinition(
    credentials: AuthCredentials,
    automationId: string,
    context?: AutomationRequestContext,
): Promise<void> {
    const response = await requestAutomation(context, `/v3/automations/${encodeURIComponent(automationId)}`, {
        method: 'DELETE',
        headers: getAutomationAuthHeaders(credentials),
    });
    const raw = await readAutomationJsonOrThrow(response);
    AutomationDeleteResponseSchema.parse(raw);
}
