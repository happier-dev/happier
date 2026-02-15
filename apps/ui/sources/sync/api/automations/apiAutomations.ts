import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';

import {
    ApiAutomationRunNowResponseSchema,
    ApiAutomationSchema,
    type ApiAutomation,
    type ApiAutomationRun,
} from './apiAutomationTypes';
import { getAutomationAuthHeaders, readAutomationJsonOrThrow } from './apiAutomationHttp';

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
