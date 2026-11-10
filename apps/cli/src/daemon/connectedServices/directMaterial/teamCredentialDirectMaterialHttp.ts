import axios from '@/api/client/credentialAxios';
import { type AxiosResponse } from 'axios';

import { TeamCredentialDirectMaterialMineResponseV1Schema, TeamCredentialDirectMaterialPreparationResponseV1Schema, TeamCredentialDirectMaterialUpsertRequestV1Schema, TeamCredentialDirectMaterialUpsertResponseV1Schema, TeamCredentialDirectMaterialWithdrawRequestV1Schema, TeamCredentialDirectMaterialWithdrawResponseV1Schema, TeamCredentialDirectMaterialOpenRequestV1Schema } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import { TeamCredentialDirectMaterialCensusOutputV1Schema } from '@happier-dev/protocol/teams/credentials/directMaterialCensusV1';
import type { TeamCredentialDirectMaterialWithdrawRequestV1, TeamCredentialDirectMaterialUpsertRequestV1, TeamCredentialDirectMaterialOpenRequestV1 } from '@happier-dev/protocol/teams';
import { TeamCredentialResourceErrorV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';

import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { TeamCredentialDirectMaterialHttpContractError } from './teamCredentialDirectMaterialContractError';
import { TeamCredentialNativeBindingReadRequestV1Schema, TeamCredentialNativeBindingReadResponseV1Schema,
  type TeamCredentialNativeBindingReadRequestV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';

export { TeamCredentialDirectMaterialHttpContractError } from './teamCredentialDirectMaterialContractError';

export class TeamCredentialDirectMaterialHttpTransportError extends Error {
  constructor() {
    super('team_credential_direct_material_transport_unavailable');
    this.name = 'TeamCredentialDirectMaterialHttpTransportError';
  }
}

function route(params: Readonly<{ serverUrl?: string; teamId: string; resourceId: string }>): string {
  const base = (params.serverUrl ?? resolveServerHttpBaseUrl()).replace(/\/+$/, '');
  return `${base}/v2/teams/${encodeURIComponent(params.teamId)}/credential-resources/${encodeURIComponent(params.resourceId)}/direct-material`;
}

function config(token: string, signal?: AbortSignal) {
  return {
    headers: { Authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {}),
  };
}

/** Existing requester HTTP projection; only finite platform consumers require it. */
type TeamCredentialPlatformMaterialRequestHeaders = (request: Readonly<{
  method: 'POST'; path: string; body: TeamCredentialDirectMaterialOpenRequestV1; signal?: AbortSignal;
}>) => Promise<Readonly<Record<string, string>> | null>;

export async function fetchTeamCredentialDirectMaterial(params: Readonly<{
  token: string;
  serverUrl?: string;
  teamId: string;
  resourceId: string;
  request: TeamCredentialDirectMaterialOpenRequestV1;
  resolvePlatformOperationRequestHeaders?: TeamCredentialPlatformMaterialRequestHeaders;
  signal?: AbortSignal;
}>) {
  const request = TeamCredentialDirectMaterialOpenRequestV1Schema.safeParse(params.request);
  if (!request.success) throw new TeamCredentialDirectMaterialHttpContractError();
  const platformHeaders = request.data.consumer.kind === 'platform_operation'
    ? await params.resolvePlatformOperationRequestHeaders?.({ method: 'POST', path: new URL(route(params)).pathname,
      body: request.data, ...(params.signal ? { signal: params.signal } : {}) }) : undefined;
  if (request.data.consumer.kind === 'platform_operation' && !platformHeaders)
    return { status: 'unavailable' as const, reason: 'access_removed' as const };
  let response: AxiosResponse<unknown>;
  try {
    response = await axios.post(route(params), request.data, {
      ...config(params.token, params.signal),
      ...(platformHeaders ? { headers: platformHeaders } : {}),
      validateStatus: () => true,
    });
  } catch {
    params.signal?.throwIfAborted();
    throw new TeamCredentialDirectMaterialHttpTransportError();
  }
  if (response.status < 200 || response.status >= 300) {
    const error = TeamCredentialResourceErrorV1Schema.safeParse(response.data);
    if (!error.success) throw new TeamCredentialDirectMaterialHttpContractError();
    return {
      status: 'operation_error' as const,
      error: error.data,
    };
  }
  const result = TeamCredentialDirectMaterialMineResponseV1Schema.safeParse(response.data);
  if (!result.success) throw new TeamCredentialDirectMaterialHttpContractError();
  return result.data;
}

/** Exact installed-guest private arm; no direct-material or catalog fallback. */
export async function fetchTeamCredentialNativeBinding(params: Readonly<{
  token: string; serverUrl?: string; request: TeamCredentialNativeBindingReadRequestV1; signal?: AbortSignal;
}>) {
  params.signal?.throwIfAborted();
  const request = TeamCredentialNativeBindingReadRequestV1Schema.safeParse(params.request);
  if (!request.success) throw new TeamCredentialDirectMaterialHttpContractError();
  let response: AxiosResponse<unknown>;
  try {
    response = await axios.post(route({ ...params, teamId: request.data.teamId, resourceId: request.data.resourceId }), request.data, {
      ...config(params.token, params.signal), validateStatus: () => true,
    });
  } catch {
    params.signal?.throwIfAborted();
    throw new TeamCredentialDirectMaterialHttpTransportError();
  }
  params.signal?.throwIfAborted();
  if (response.status < 200 || response.status >= 300) return { status: 'unavailable', reason: 'binding_unavailable' } as const;
  const result = TeamCredentialNativeBindingReadResponseV1Schema.safeParse(response.data);
  if (!result.success) throw new TeamCredentialDirectMaterialHttpContractError();
  return result.data;
}

export async function fetchTeamCredentialDirectMaterialPreparation(params: Readonly<{
  token: string;
  serverUrl?: string;
  teamId: string;
  resourceId: string;
  sourceMemberKey: string;
  cursor?: string;
  signal?: AbortSignal;
}>) {
  const query = new URLSearchParams({ view: 'preparation', sourceMemberKey: params.sourceMemberKey });
  if (params.cursor) query.set('cursor', params.cursor);
  const response = await axios.get(`${route(params)}?${query.toString()}`, config(params.token, params.signal));
  const result = TeamCredentialDirectMaterialPreparationResponseV1Schema.safeParse(response.data);
  if (!result.success) throw new TeamCredentialDirectMaterialHttpContractError();
  return result.data;
}

export async function fetchTeamCredentialDirectMaterialCensus(params: Readonly<{
  token: string;
  serverUrl?: string;
  teamId: string;
  resourceId: string;
  cursor?: string;
  signal?: AbortSignal;
}>) {
  const query = new URLSearchParams({ view: 'census' });
  if (params.cursor) query.set('cursor', params.cursor);
  const response = await axios.get(`${route(params)}?${query.toString()}`, config(params.token, params.signal));
  const result = TeamCredentialDirectMaterialCensusOutputV1Schema.safeParse(response.data);
  if (!result.success) throw new TeamCredentialDirectMaterialHttpContractError();
  return result.data;
}

export async function upsertTeamCredentialDirectMaterial(params: Readonly<{
  token: string;
  serverUrl?: string;
  teamId: string;
  resourceId: string;
  body: TeamCredentialDirectMaterialUpsertRequestV1;
  signal?: AbortSignal;
}>) {
  const body = TeamCredentialDirectMaterialUpsertRequestV1Schema.safeParse(params.body);
  if (!body.success) throw new TeamCredentialDirectMaterialHttpContractError();
  const response = await axios.put(route(params), body.data, config(params.token, params.signal));
  const result = TeamCredentialDirectMaterialUpsertResponseV1Schema.safeParse(response.data);
  if (!result.success) throw new TeamCredentialDirectMaterialHttpContractError();
  return result.data;
}

export async function withdrawTeamCredentialDirectMaterial(params: Readonly<{
  token: string;
  serverUrl?: string;
  teamId: string;
  resourceId: string;
  body: TeamCredentialDirectMaterialWithdrawRequestV1;
  signal?: AbortSignal;
}>) {
  const body = TeamCredentialDirectMaterialWithdrawRequestV1Schema.safeParse(params.body);
  if (!body.success) throw new TeamCredentialDirectMaterialHttpContractError();
  const response = await axios.delete(route(params), { ...config(params.token, params.signal), data: body.data });
  const result = TeamCredentialDirectMaterialWithdrawResponseV1Schema.safeParse(response.data);
  if (!result.success) throw new TeamCredentialDirectMaterialHttpContractError();
  return result.data;
}
