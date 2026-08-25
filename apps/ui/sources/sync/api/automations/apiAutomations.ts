import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import {
    AutomationAssignmentUpdateRequestSchema,
    AutomationV3ClearRunHistoryResponseSchema,
    AutomationDeleteResponseSchema,
    AutomationDefinitionDetailSchema,
    AutomationDefinitionListResponseSchema,
    AutomationPluginEventDefinitionCreateRequestSchema,
    AutomationPluginEventDefinitionPatchRequestSchema,
    AutomationV3RunDetailSchema,
    AutomationV3RunMutationResponseSchema,
    AutomationV3SettingsSchema,
    AutomationV3SettingsUpdateRequestSchema,
    type AutomationAssignmentInput,
    type AutomationV3ClearRunHistoryResponse,
    type AutomationDefinitionDetail,
    type AutomationDefinitionListItem,
    type AutomationPluginEventDefinitionCreateRequest,
    type AutomationPluginEventDefinitionPatchRequest,
    type AutomationV3RunDetail,
    type AutomationV3RunListItem,
    type AutomationV3Settings,
    type AutomationV3SettingsUpdateRequest,
} from '@happier-dev/protocol';

import {
    ApiAutomationRunNowResponseSchema,
    ApiAutomationSchema,
    type ApiAutomation,
    type ApiAutomationRun,
} from './apiAutomationTypes';
import {
    getAutomationAuthHeaders,
    readAutomationJsonOrThrow,
} from './apiAutomationHttp';

export { AutomationApiError, isAutomationApiErrorCode } from './apiAutomationHttp';

export type AutomationScheduleInput =
    | Readonly<{ kind: 'interval'; everyMs: number; scheduleExpr?: undefined; timezone?: string | null }>
    | Readonly<{ kind: 'cron'; scheduleExpr: string; everyMs?: undefined; timezone?: string | null }>;

export type AutomationAssignmentInput = Readonly<{
    machineId: string;
    enabled?: boolean;
    priority?: number;
}>;

export type AutomationCreateInput = Readonly<{
    name: string;
    description?: string | null;
    enabled: boolean;
    schedule: AutomationScheduleInput;
    targetType: 'new_session' | 'existing_session';
    templateCiphertext: string;
    assignments?: ReadonlyArray<AutomationAssignmentInput>;
}>;

export type AutomationPatchInput = Readonly<Partial<AutomationCreateInput>>;

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

/**
 * First Event writer. The Protocol schema is re-applied at the UI boundary so
 * a caller cannot accidentally send server-owned fields or a legacy V2 shape.
 */
export async function createPluginEventAutomationDefinition(
    credentials: AuthCredentials,
    input: AutomationPluginEventDefinitionCreateRequest,
): Promise<AutomationDefinitionDetail> {
    const body = AutomationPluginEventDefinitionCreateRequestSchema.parse(input);
    const response = await serverFetch('/v3/automations', {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials, { includeJsonContentType: true }),
        body: JSON.stringify(body),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationDefinitionDetailSchema.parse(raw);
}

/** Event edits are full replacement requests guarded by the displayed current template version. */
export async function updatePluginEventAutomationDefinition(
    credentials: AuthCredentials,
    automationId: string,
    input: AutomationPluginEventDefinitionPatchRequest,
): Promise<AutomationDefinitionDetail> {
    const body = AutomationPluginEventDefinitionPatchRequestSchema.parse(input);
    const response = await serverFetch(`/v3/automations/${encodeURIComponent(automationId)}`, {
        method: 'PATCH',
        headers: getAutomationAuthHeaders(credentials, { includeJsonContentType: true }),
        body: JSON.stringify(body),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationDefinitionDetailSchema.parse(raw);
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

export async function listAutomations(credentials: AuthCredentials): Promise<ApiAutomation[]> {
    const response = await serverFetch('/v2/automations', {
        headers: getAutomationAuthHeaders(credentials),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return ApiAutomationSchema.array().parse(raw);
}

export async function getAutomation(credentials: AuthCredentials, automationId: string): Promise<ApiAutomation> {
    const response = await serverFetch(`/v2/automations/${encodeURIComponent(automationId)}`, {
        headers: getAutomationAuthHeaders(credentials),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return ApiAutomationSchema.parse(raw);
}

export async function createAutomation(
    credentials: AuthCredentials,
    input: AutomationCreateInput,
): Promise<ApiAutomation> {
    const response = await serverFetch('/v2/automations', {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials, { includeJsonContentType: true }),
        body: JSON.stringify(input),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return ApiAutomationSchema.parse(raw);
}

export async function updateAutomation(
    credentials: AuthCredentials,
    automationId: string,
    input: AutomationPatchInput,
): Promise<ApiAutomation> {
    const response = await serverFetch(`/v2/automations/${encodeURIComponent(automationId)}`, {
        method: 'PATCH',
        headers: getAutomationAuthHeaders(credentials, { includeJsonContentType: true }),
        body: JSON.stringify(input),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return ApiAutomationSchema.parse(raw);
}

export async function replaceAutomationAssignments(
    credentials: AuthCredentials,
    automationId: string,
    assignments: ReadonlyArray<AutomationAssignmentInput>,
): Promise<ApiAutomation> {
    const response = await serverFetch(`/v2/automations/${encodeURIComponent(automationId)}/assignments`, {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials, { includeJsonContentType: true }),
        body: JSON.stringify({ assignments }),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return ApiAutomationSchema.parse(raw);
}

export async function deleteAutomation(credentials: AuthCredentials, automationId: string): Promise<void> {
    const response = await serverFetch(`/v2/automations/${encodeURIComponent(automationId)}`, {
        method: 'DELETE',
        headers: getAutomationAuthHeaders(credentials),
    }, { includeAuth: false });
    await readAutomationJsonOrThrow(response);
}

export async function pauseAutomation(credentials: AuthCredentials, automationId: string): Promise<ApiAutomation> {
    const response = await serverFetch(`/v2/automations/${encodeURIComponent(automationId)}/pause`, {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return ApiAutomationSchema.parse(raw);
}

export async function resumeAutomation(credentials: AuthCredentials, automationId: string): Promise<ApiAutomation> {
    const response = await serverFetch(`/v2/automations/${encodeURIComponent(automationId)}/resume`, {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return ApiAutomationSchema.parse(raw);
}

export async function runAutomationNow(credentials: AuthCredentials, automationId: string): Promise<ApiAutomationRun> {
    const response = await serverFetch(`/v2/automations/${encodeURIComponent(automationId)}/run-now`, {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return ApiAutomationRunNowResponseSchema.parse(raw).run;
}
