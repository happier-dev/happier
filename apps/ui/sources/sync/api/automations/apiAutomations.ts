import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import {
    AutomationV3AssignmentUpdateRequestSchema,
    AutomationV3DeleteResponseSchema,
    AutomationV3DefinitionDetailSchema,
    AutomationV3DefinitionListResponseSchema,
    AutomationV3PluginEventDefinitionCreateRequestSchema,
    AutomationV3PluginEventDefinitionPatchRequestSchema,
    AutomationV3RunDetailSchema,
    AutomationV3RunMutationResponseSchema,
    type AutomationV3AssignmentInput,
    type AutomationV3DefinitionDetail,
    type AutomationV3DefinitionListItem,
    type AutomationV3PluginEventDefinitionCreateRequest,
    type AutomationV3PluginEventDefinitionPatchRequest,
    type AutomationV3RunDetail,
    type AutomationV3RunListItem,
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
 * Current V3 list items deliberately exclude private definition and recipe
 * content. Consumers that need those bytes must read the exact definition.
 */
export async function listAutomationDefinitionsV3(
    credentials: AuthCredentials,
): Promise<AutomationV3DefinitionListItem[]> {
    const response = await serverFetch('/v3/automations', {
        headers: getAutomationAuthHeaders(credentials),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3DefinitionListResponseSchema.parse(raw).automations;
}

/** Direct authenticated definition read; this is the only UI API that returns private Event authoring content. */
export async function getAutomationDefinitionV3(
    credentials: AuthCredentials,
    automationId: string,
): Promise<AutomationV3DefinitionDetail> {
    const response = await serverFetch(`/v3/automations/${encodeURIComponent(automationId)}`, {
        headers: getAutomationAuthHeaders(credentials),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3DefinitionDetailSchema.parse(raw);
}

/**
 * First Event writer. The Protocol schema is re-applied at the UI boundary so
 * a caller cannot accidentally send server-owned fields or a legacy V2 shape.
 */
export async function createPluginEventAutomationDefinitionV3(
    credentials: AuthCredentials,
    input: AutomationV3PluginEventDefinitionCreateRequest,
): Promise<AutomationV3DefinitionDetail> {
    const body = AutomationV3PluginEventDefinitionCreateRequestSchema.parse(input);
    const response = await serverFetch('/v3/automations', {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials, { includeJsonContentType: true }),
        body: JSON.stringify(body),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3DefinitionDetailSchema.parse(raw);
}

/** Event edits are full V3 replacement requests guarded by the displayed current template version. */
export async function updatePluginEventAutomationDefinitionV3(
    credentials: AuthCredentials,
    automationId: string,
    input: AutomationV3PluginEventDefinitionPatchRequest,
): Promise<AutomationV3DefinitionDetail> {
    const body = AutomationV3PluginEventDefinitionPatchRequestSchema.parse(input);
    const response = await serverFetch(`/v3/automations/${encodeURIComponent(automationId)}`, {
        method: 'PATCH',
        headers: getAutomationAuthHeaders(credentials, { includeJsonContentType: true }),
        body: JSON.stringify(body),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3DefinitionDetailSchema.parse(raw);
}

/** Lifecycle mutations remain on the V3 definition owner for Event Automations. */
export async function pauseAutomationDefinitionV3(
    credentials: AuthCredentials,
    automationId: string,
): Promise<AutomationV3DefinitionDetail> {
    const response = await serverFetch(`/v3/automations/${encodeURIComponent(automationId)}/pause`, {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3DefinitionDetailSchema.parse(raw);
}

export async function resumeAutomationDefinitionV3(
    credentials: AuthCredentials,
    automationId: string,
): Promise<AutomationV3DefinitionDetail> {
    const response = await serverFetch(`/v3/automations/${encodeURIComponent(automationId)}/resume`, {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3DefinitionDetailSchema.parse(raw);
}

export async function replaceAutomationDefinitionAssignmentsV3(
    credentials: AuthCredentials,
    automationId: string,
    assignments: ReadonlyArray<AutomationV3AssignmentInput>,
): Promise<AutomationV3DefinitionDetail> {
    const body = AutomationV3AssignmentUpdateRequestSchema.parse({ assignments });
    const response = await serverFetch(`/v3/automations/${encodeURIComponent(automationId)}/assignments`, {
        method: 'POST',
        headers: getAutomationAuthHeaders(credentials, { includeJsonContentType: true }),
        body: JSON.stringify(body),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    return AutomationV3DefinitionDetailSchema.parse(raw);
}

export async function runAutomationDefinitionNowV3(
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
export async function getAutomationRunDetailV3(
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

/** Cancellation remains one V3 Run mutation; callers receive the refreshed bounded Run projection. */
export async function cancelAutomationRunV3(
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

export async function deleteAutomationDefinitionV3(
    credentials: AuthCredentials,
    automationId: string,
): Promise<void> {
    const response = await serverFetch(`/v3/automations/${encodeURIComponent(automationId)}`, {
        method: 'DELETE',
        headers: getAutomationAuthHeaders(credentials),
    }, { includeAuth: false });
    const raw = await readAutomationJsonOrThrow(response);
    AutomationV3DeleteResponseSchema.parse(raw);
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
