import axios from 'axios';
import { z } from 'zod';
import { AutomationDefinitionListRequestSchema, AutomationDefinitionListResponseSchema, AutomationDefinitionDetailSchema, AutomationDefinitionCreateRequestSchema, AutomationDefinitionReconcileRequestSchema, AutomationDeleteResponseSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { AutomationRunStateV3Schema } from '@happier-dev/protocol/automations/automationRunStateV3';
import type { AutomationDefinitionListResponse, AutomationDefinitionListRequest, AutomationDefinitionDetail, AutomationDefinitionCreateRequest, AutomationDefinitionReconcileRequest } from '@happier-dev/protocol';

import {
  createAuthenticationHttpStatusError,
  createHttpStatusError,
  isAuthenticationStatus,
} from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';

const AutomationRunSummarySchema = z.object({
  id: z.string().min(1),
  automationId: z.string().min(1),
  state: AutomationRunStateV3Schema,
}).passthrough();
const RunAutomationNowResponseSchema = z.object({ run: AutomationRunSummarySchema });
// The incumbent Automation HTTP owner budget applies to every definition operation.
const AUTOMATION_HTTP_TIMEOUT_MS = 15_000;

export type AutomationRunSummary = z.infer<typeof AutomationRunSummarySchema>;

export async function listAutomationDefinitions(params: Readonly<Partial<AutomationDefinitionListRequest> & {
  token: string;
}>): Promise<AutomationDefinitionListResponse> {
  const query = AutomationDefinitionListRequestSchema.parse({
    ...(params.limit === undefined ? {} : { limit: params.limit }),
    ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
    ...(params.workflowDefinitionId === undefined ? {} : { workflowDefinitionId: params.workflowDefinitionId }),
    ...(params.scopeSessionId === undefined ? {} : { scopeSessionId: params.scopeSessionId }),
    ...(params.scope === undefined ? {} : { scope: params.scope }),
  });
  const search = new URLSearchParams({ limit: String(query.limit) });
  if (query.cursor) search.set('cursor', query.cursor);
  if (query.workflowDefinitionId) search.set('workflowDefinitionId', query.workflowDefinitionId);
  if (query.scopeSessionId) search.set('scopeSessionId', query.scopeSessionId);
  if (query.scope) search.set('scope', query.scope);
  const response = await axios.get(
    `${resolveServerHttpBaseUrl()}/v3/automations?${search.toString()}`,
    {
      headers: { Authorization: `Bearer ${params.token}` },
      timeout: AUTOMATION_HTTP_TIMEOUT_MS,
      validateStatus: () => true,
    },
  );

  if (isAuthenticationStatus(response.status)) {
    throw createAuthenticationHttpStatusError(response.status, 'Authentication failed while listing automations');
  }
  if (response.status < 200 || response.status >= 300) {
    const errorCode = typeof response.data?.error === 'string' ? response.data.error : undefined;
    throw createHttpStatusError(
      response.status,
      `Failed to list automations (${response.status})`,
      errorCode,
    );
  }
  return AutomationDefinitionListResponseSchema.parse(response.data);
}

export async function runAutomationNow(params: Readonly<{
  token: string;
  automationId: string;
  idempotencyKey?: string | null;
}>): Promise<AutomationRunSummary> {
  const response = await axios.post(
    `${resolveServerHttpBaseUrl()}/v3/automations/${encodeURIComponent(params.automationId)}/run-now`,
    undefined,
    {
      headers: {
        Authorization: `Bearer ${params.token}`,
        ...(params.idempotencyKey ? { 'Idempotency-Key': params.idempotencyKey } : {}),
      },
      timeout: AUTOMATION_HTTP_TIMEOUT_MS,
      validateStatus: () => true,
    },
  );

  if (isAuthenticationStatus(response.status)) {
    throw createAuthenticationHttpStatusError(response.status, 'Authentication failed while running automation');
  }
  if (response.status < 200 || response.status >= 300) {
    const errorCode = typeof response.data?.error === 'string' ? response.data.error : undefined;
    throw createHttpStatusError(
      response.status,
      errorCode === 'automation_disabled' ? 'Automation is paused' : `Failed to run automation (${response.status})`,
      errorCode,
    );
  }
  return RunAutomationNowResponseSchema.parse(response.data).run;
}

/** Account trigger writes use the current Automation owner, never a daemon-private store. */
async function requestAutomationDefinition(params: Readonly<{
  token: string; method: 'GET' | 'POST' | 'PUT' | 'DELETE'; automationId?: string; body?: unknown;
}>): Promise<unknown | null> {
  const response = await axios.request({
    method: params.method,
    url: `${resolveServerHttpBaseUrl()}/v3/automations${params.automationId ? `/${encodeURIComponent(params.automationId)}` : ''}`,
    headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${params.token}`, 'Content-Type': 'application/json' },
    ...(params.body === undefined ? {} : { data: params.body }), timeout: AUTOMATION_HTTP_TIMEOUT_MS, validateStatus: () => true,
  });
  if (isAuthenticationStatus(response.status)) throw createAuthenticationHttpStatusError(response.status, 'Authentication failed while accessing automation');
  if (response.status === 404 && params.method === 'GET') return null;
  if (response.status < 200 || response.status >= 300) {
    const parsedError = z.object({ error: z.string(), details: z.unknown().optional() }).passthrough().safeParse(response.data);
    const code = parsedError.success ? parsedError.data.error : undefined;
    throw Object.assign(createHttpStatusError(response.status, `Automation operation failed (${response.status})`, code),
      { code: code === 'version_mismatch' || code === 'automation_template_version_conflict'
          || code === 'automation_trigger_revision_conflict' ? 'currentness_conflict' : code ?? 'content_unavailable',
        ...(parsedError.success && parsedError.data.details !== undefined ? { details: parsedError.data.details } : {}) });
  }
  return response.data;
}

export async function getAutomationDefinition(params: Readonly<{ token: string; automationId: string }>): Promise<AutomationDefinitionDetail | null> {
  const raw = await requestAutomationDefinition({ ...params, method: 'GET' });
  return raw === null ? null : AutomationDefinitionDetailSchema.parse(raw);
}
export async function createAutomationDefinition(params: Readonly<{ token: string; input: AutomationDefinitionCreateRequest }>): Promise<AutomationDefinitionDetail> {
  return AutomationDefinitionDetailSchema.parse(await requestAutomationDefinition({ token: params.token,
    method: 'POST', body: AutomationDefinitionCreateRequestSchema.parse(params.input) }));
}
export async function reconcileAutomationDefinition(params: Readonly<{ token: string; automationId: string; input: AutomationDefinitionReconcileRequest }>): Promise<AutomationDefinitionDetail> {
  return AutomationDefinitionDetailSchema.parse(await requestAutomationDefinition({ token: params.token, automationId: params.automationId,
    method: 'PUT', body: AutomationDefinitionReconcileRequestSchema.parse(params.input) }));
}
export async function deleteAutomationDefinition(params: Readonly<{ token: string; automationId: string }>): Promise<void> {
  AutomationDeleteResponseSchema.parse(await requestAutomationDefinition({ ...params, method: 'DELETE' }));
}
