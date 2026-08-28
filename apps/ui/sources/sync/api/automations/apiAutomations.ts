import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import {
    AutomationAssignmentUpdateRequestSchema,
    AutomationV3ClearRunHistoryResponseSchema,
    AutomationDeleteResponseSchema,
    AutomationDefinitionDetailSchema,
    AutomationDefinitionListResponseSchema,
    AutomationDefinitionCreateRequestSchema,
    AutomationDefinitionPatchRequestSchema,
    AutomationDefinitionReconcileRequestSchema,
    AutomationTriggerCreateRequestSchema,
    AutomationTriggerPatchRequestSchema,
    AutomationTriggerDeleteRequestSchema,
    AutomationV3RunDetailSchema,
    AutomationV3RunMutationResponseSchema,
    AutomationV3SettingsSchema,
    AutomationV3SettingsUpdateRequestSchema,
    type AutomationV3ClearRunHistoryResponse,
    type AutomationDefinitionDetail,
    type AutomationDefinitionListItem,
    type AutomationDefinitionCreateRequest,
    type AutomationDefinitionPatchRequest,
    type AutomationDefinitionReconcileRequest,
    type AutomationTriggerCreateRequest,
    type AutomationTriggerPatchRequest,
    type AutomationTriggerDeleteRequest,
    type AutomationV3RunDetail,
    type AutomationV3RunListItem,
    type AutomationV3Settings,
    type AutomationV3SettingsUpdateRequest,
} from '@happier-dev/protocol';

import {
    getAutomationAuthHeaders,
    readAutomationJsonOrThrow,
} from './apiAutomationHttp';

export { AutomationApiError, isAutomationApiErrorCode } from './apiAutomationHttp';

export type AutomationAssignmentInput = Readonly<{
    machineId: string;
    enabled?: boolean;
    priority?: number;
}>;

/**
 * Current list items deliberately exclude private definition and recipe
 * content. Consumers that need those bytes must read the exact definition.
 */
export async function listAutomationDefinitions(
    credentials: AuthCredentials,
): Promise<AutomationDefinitionListItem[]> {
    const response = await serverFetch('/v3/automations', {
        headers: getAutomationAuthHeaders(credentials),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationDefinitionListResponseSchema.parse(raw).automations;
}

/** Account-scoped settings are read through their strict owner, never inferred from definitions or runs. */
export async function getAutomationSettings(
    credentials: AuthCredentials,
): Promise<AutomationV3Settings> {
    const response = await serverFetch('/v3/automations/settings', {
        headers: getAutomationAuthHeaders(credentials),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3SettingsSchema.parse(raw);
}

/** A complete strict record replaces the server-owned Automation settings projection. */
export async function updateAutomationSettings(
    credentials: AuthCredentials,
    input: AutomationV3SettingsUpdateRequest,
): Promise<AutomationV3Settings> {
    const body = AutomationV3SettingsUpdateRequestSchema.parse(input);
    const response = await serverFetch('/v3/automations/settings', {
        method: 'PUT',
        headers: getAutomationAuthHeaders(credentials, { includeJsonContentType: true }),
        body: JSON.stringify(body),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3SettingsSchema.parse(raw);
}

/** Direct authenticated definition read; this is the only UI API that returns private Event authoring content. */
export async function getAutomationDefinition(
    credentials: AuthCredentials,
    automationId: string,
): Promise<AutomationDefinitionDetail> {
    const response = await serverFetch(`/v3/automations/${encodeURIComponent(automationId)}`, {
        headers: getAutomationAuthHeaders(credentials),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationDefinitionDetailSchema.parse(raw);
}

export async function createAutomationDefinition(
    credentials: AuthCredentials,
    input: AutomationDefinitionCreateRequest,
): Promise<AutomationDefinitionDetail> {
    const body = AutomationDefinitionCreateRequestSchema.parse(input);
    const response = await serverFetch('/v3/automations', {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials, { includeJsonContentType: true }),
        body: JSON.stringify(body),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationDefinitionDetailSchema.parse(raw);
}

export async function updateAutomationDefinition(
    credentials: AuthCredentials,
    automationId: string,
    input: AutomationDefinitionPatchRequest,
): Promise<AutomationDefinitionDetail> {
    const body = AutomationDefinitionPatchRequestSchema.parse(input);
    const response = await serverFetch(`/v3/automations/${encodeURIComponent(automationId)}`, {
        method: 'PATCH',
        headers: getAutomationAuthHeaders(credentials, { includeJsonContentType: true }),
        body: JSON.stringify(body),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationDefinitionDetailSchema.parse(raw);
}

/** One visible full-editor Save, committed by the canonical server owner. */
export async function reconcileAutomationDefinition(
    credentials: AuthCredentials,
    automationId: string,
    input: AutomationDefinitionReconcileRequest,
): Promise<AutomationDefinitionDetail> {
    const body = AutomationDefinitionReconcileRequestSchema.parse(input);
    const response = await serverFetch(`/v3/automations/${encodeURIComponent(automationId)}`, {
        method: 'PUT',
        headers: getAutomationAuthHeaders(credentials, { includeJsonContentType: true }),
        body: JSON.stringify(body),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationDefinitionDetailSchema.parse(raw);
}

async function mutateAutomationTrigger(
    credentials: AuthCredentials,
    automationId: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    body: AutomationTriggerCreateRequest | AutomationTriggerPatchRequest | AutomationTriggerDeleteRequest,
): Promise<AutomationDefinitionDetail> {
    const response = await serverFetch(`/v3/automations/${encodeURIComponent(automationId)}/triggers`, {
        method,
        headers: getAutomationAuthHeaders(credentials, { includeJsonContentType: true }),
        body: JSON.stringify(body),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationDefinitionDetailSchema.parse(raw);
}

export async function createAutomationTrigger(
    credentials: AuthCredentials,
    automationId: string,
    input: AutomationTriggerCreateRequest,
): Promise<AutomationDefinitionDetail> {
    return mutateAutomationTrigger(
        credentials,
        automationId,
        'POST',
        AutomationTriggerCreateRequestSchema.parse(input),
    );
}

export async function updateAutomationTrigger(
    credentials: AuthCredentials,
    automationId: string,
    input: AutomationTriggerPatchRequest,
): Promise<AutomationDefinitionDetail> {
    return mutateAutomationTrigger(
        credentials,
        automationId,
        'PATCH',
        AutomationTriggerPatchRequestSchema.parse(input),
    );
}

export async function deleteAutomationTrigger(
    credentials: AuthCredentials,
    automationId: string,
    input: AutomationTriggerDeleteRequest,
): Promise<AutomationDefinitionDetail> {
    return mutateAutomationTrigger(
        credentials,
        automationId,
        'DELETE',
        AutomationTriggerDeleteRequestSchema.parse(input),
    );
}

/** Lifecycle mutations remain on the definition owner for Event Automations. */
export async function pauseAutomationDefinition(
    credentials: AuthCredentials,
    automationId: string,
): Promise<AutomationDefinitionDetail> {
    const response = await serverFetch(`/v3/automations/${encodeURIComponent(automationId)}/pause`, {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationDefinitionDetailSchema.parse(raw);
}

export async function resumeAutomationDefinition(
    credentials: AuthCredentials,
    automationId: string,
): Promise<AutomationDefinitionDetail> {
    const response = await serverFetch(`/v3/automations/${encodeURIComponent(automationId)}/resume`, {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationDefinitionDetailSchema.parse(raw);
}

export async function replaceAutomationDefinitionAssignments(
    credentials: AuthCredentials,
    automationId: string,
    assignments: ReadonlyArray<AutomationAssignmentInput>,
): Promise<AutomationDefinitionDetail> {
    const body = AutomationAssignmentUpdateRequestSchema.parse({ assignments });
    const response = await serverFetch(`/v3/automations/${encodeURIComponent(automationId)}/assignments`, {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials, { includeJsonContentType: true }),
        body: JSON.stringify(body),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationDefinitionDetailSchema.parse(raw);
}

export async function runAutomationDefinitionNow(
    credentials: AuthCredentials,
    automationId: string,
): Promise<AutomationV3RunListItem> {
    const response = await serverFetch(`/v3/automations/${encodeURIComponent(automationId)}/run-now`, {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3RunMutationResponseSchema.parse(raw).run;
}

/** Direct Run detail stays route-owned; the bounded Run list never carries these private envelopes. */
export async function getAutomationRunDetail(
    credentials: AuthCredentials,
    automationId: string,
    runId: string,
): Promise<AutomationV3RunDetail> {
    const response = await serverFetch(
        `/v3/automations/${encodeURIComponent(automationId)}/runs/${encodeURIComponent(runId)}`,
        { headers: getAutomationAuthHeaders(credentials) },
        { includeAuth: false },
    );
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3RunDetailSchema.parse(raw);
}

/** Removes only server-eligible terminal Run history for one Automation. */
export async function clearAutomationRunHistory(
    credentials: AuthCredentials,
    automationId: string,
): Promise<AutomationV3ClearRunHistoryResponse> {
    const response = await serverFetch(`/v3/automations/${encodeURIComponent(automationId)}/runs/clear-history`, {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3ClearRunHistoryResponseSchema.parse(raw);
}

/** Cancellation remains one Run mutation; callers receive the refreshed bounded Run projection. */
export async function cancelAutomationRun(
    credentials: AuthCredentials,
    runId: string,
): Promise<AutomationV3RunListItem> {
    const response = await serverFetch(`/v3/automations/runs/${encodeURIComponent(runId)}/cancel`, {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3RunMutationResponseSchema.parse(raw).run;
}

/** Requeues the existing frozen reply handoff; the server preserves its custody identity. */
export async function retryAutomationReplyHandoff(
    credentials: AuthCredentials,
    runId: string,
): Promise<AutomationV3RunListItem> {
    const response = await serverFetch(
        `/v3/automations/runs/${encodeURIComponent(runId)}/retry-reply-handoff`,
        {
            method: 'POST',
            headers: getAutomationAuthHeaders(credentials),
        },
        { includeAuth: false },
    );
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3RunMutationResponseSchema.parse(raw).run;
}

export async function deleteAutomationDefinition(
    credentials: AuthCredentials,
    automationId: string,
): Promise<void> {
    const response = await serverFetch(`/v3/automations/${encodeURIComponent(automationId)}`, {
        method: 'DELETE',
        headers: getAutomationAuthHeaders(credentials),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    AutomationDeleteResponseSchema.parse(raw);
}
