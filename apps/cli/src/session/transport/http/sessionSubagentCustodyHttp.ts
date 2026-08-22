import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from 'axios';
import {
  SessionSubagentCustodyCapabilityV1Schema,
  SessionSubagentCustodyMutationRequestV1Schema,
  SessionSubagentCustodyMutationResponseV1Schema,
  SessionSubagentCustodyPageV1Schema,
  SessionSubagentCustodyRetirementRequestV1Schema,
  SessionSubagentCustodyRetirementResponseV1Schema,
  type SessionSubagentCustodyMutationRequestV1,
  type SessionSubagentCustodyRecordV1,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

export class SessionSubagentCustodyHttpError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SessionSubagentCustodyHttpError';
  }
}

function route(sessionId: string, suffix = ''): string {
  return `/v2/sessions/${encodeURIComponent(sessionId)}/subagents/custody${suffix}`;
}

function config(token: string, signal?: AbortSignal) {
  return {
    headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
    ...(signal ? { signal } : {}),
  };
}

function parse<T>(schema: { safeParse(value: unknown): { success: boolean; data?: T } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data === undefined) throw new SessionSubagentCustodyHttpError('plugin_subagent_server_response_invalid');
  return parsed.data;
}

function throwForStatus(status: number, data: unknown): never {
  if (status === 401 || status === 403) throw new SessionSubagentCustodyHttpError('not_authenticated');
  if (status === 404) throw new SessionSubagentCustodyHttpError('plugin_subagent_durable_custody_unavailable');
  const error = data && typeof data === 'object' && !Array.isArray(data)
    ? Object.getOwnPropertyDescriptor(data, 'error')?.value
    : undefined;
  if (status === 409 && error === 'idempotency-conflict') throw new SessionSubagentCustodyHttpError('plugin_subagent_operation_conflict');
  if (status === 409 && error === 'capacity-exceeded') throw new SessionSubagentCustodyHttpError('plugin_subagent_idempotency_capacity_exceeded');
  if (status === 409 && error === 'cas-conflict') throw new SessionSubagentCustodyHttpError('plugin_subagent_revision_conflict');
  if (status === 409 && error === 'terminal-regression') throw new SessionSubagentCustodyHttpError('plugin_subagent_terminal_regression');
  if (status === 409 && error === 'generation-retired') throw new SessionSubagentCustodyHttpError('plugin_generation_retired');
  if (status === 409 && error === 'retirement-capacity-exceeded') throw new SessionSubagentCustodyHttpError('plugin_subagent_retirement_capacity_exceeded');
  throw new SessionSubagentCustodyHttpError('plugin_subagent_durable_custody_unavailable');
}

export async function probeSessionSubagentCustody(params: Readonly<{
  token: string; sessionId: string; signal?: AbortSignal;
}>): Promise<void> {
  const path = route(params.sessionId, '/capability');
  const response = await axios.get(`${resolveServerHttpBaseUrl()}${path}`, config(params.token, params.signal));
  if (response.status !== 200) throwForStatus(response.status, response.data);
  parse(SessionSubagentCustodyCapabilityV1Schema, response.data);
}

export async function listSessionSubagentCustody(params: Readonly<{
  token: string;
  sessionId: string;
  scope: Readonly<{ pluginId: string; contributionId: string; immutableGenerationId: string }>;
  custodyKey: string;
  signal?: AbortSignal;
}>): Promise<readonly SessionSubagentCustodyRecordV1[]> {
  const path = route(params.sessionId);
  const response = await axios.get(`${resolveServerHttpBaseUrl()}${path}`, {
    ...config(params.token, params.signal),
    params: { ...params.scope, custodyKey: params.custodyKey },
  });
  if (response.status !== 200) throwForStatus(response.status, response.data);
  return parse(SessionSubagentCustodyPageV1Schema, response.data).records;
}

export async function mutateSessionSubagentCustody(params: Readonly<{
  token: string; sessionId: string; request: SessionSubagentCustodyMutationRequestV1; signal?: AbortSignal;
}>): Promise<Readonly<{ record: SessionSubagentCustodyRecordV1; replayed: boolean }>> {
  const request = parse(SessionSubagentCustodyMutationRequestV1Schema, params.request);
  const path = route(params.sessionId, '/mutations');
  const response = await axios.post(
    `${resolveServerHttpBaseUrl()}${path}`,
    request,
    config(params.token, params.signal),
  );
  if (response.status !== 200) throwForStatus(response.status, response.data);
  return parse(SessionSubagentCustodyMutationResponseV1Schema, response.data);
}

export async function retireSessionSubagentCustodyGeneration(params: Readonly<{
  token: string; pluginId: string; immutableGenerationId: string; signal?: AbortSignal;
}>): Promise<void> {
  const request = parse(SessionSubagentCustodyRetirementRequestV1Schema, {
    pluginId: params.pluginId,
    immutableGenerationId: params.immutableGenerationId,
  });
  const path = '/v2/session-subagents/custody/generation-retirements';
  const response = await axios.post(
    `${resolveServerHttpBaseUrl()}${path}`,
    request,
    config(params.token, params.signal),
  );
  if (response.status !== 200) throwForStatus(response.status, response.data);
  parse(SessionSubagentCustodyRetirementResponseV1Schema, response.data);
}
