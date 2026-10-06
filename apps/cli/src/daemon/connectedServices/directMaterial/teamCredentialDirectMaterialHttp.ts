import axios, { type AxiosResponse } from 'axios';

import { TeamCredentialDirectMaterialMineResponseV1Schema, TeamCredentialDirectMaterialPreparationResponseV1Schema, TeamCredentialDirectMaterialUpsertRequestV1Schema, TeamCredentialDirectMaterialUpsertResponseV1Schema, TeamCredentialDirectMaterialWithdrawRequestV1Schema, TeamCredentialDirectMaterialWithdrawResponseV1Schema, TeamCredentialDirectMaterialOpenRequestV1Schema } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import { TeamCredentialDirectMaterialCensusOutputV1Schema } from '@happier-dev/protocol/teams/credentials/directMaterialCensusV1';
import type { TeamCredentialDirectMaterialWithdrawRequestV1, TeamCredentialDirectMaterialUpsertRequestV1, TeamCredentialDirectMaterialOpenRequestV1 } from '@happier-dev/protocol/teams';
import { TeamCredentialResourceErrorV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';

import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

const REQUEST_TIMEOUT_MS = 15_000;

export class TeamCredentialDirectMaterialHttpTransportError extends Error {
  constructor() {
    super('team_credential_direct_material_transport_unavailable');
    this.name = 'TeamCredentialDirectMaterialHttpTransportError';
  }
}

export class TeamCredentialDirectMaterialHttpContractError extends Error {
  constructor() {
    super('team_credential_direct_material_http_contract_invalid');
    this.name = 'TeamCredentialDirectMaterialHttpContractError';
  }
}

function route(params: Readonly<{ serverUrl?: string; teamId: string; resourceId: string }>): string {
  const base = (params.serverUrl ?? resolveServerHttpBaseUrl()).replace(/\/+$/, '');
  return `${base}/v2/teams/${encodeURIComponent(params.teamId)}/credential-resources/${encodeURIComponent(params.resourceId)}/direct-material`;
}

function config(token: string, signal?: AbortSignal) {
  return {
    headers: { Authorization: `Bearer ${token}` },
    timeout: REQUEST_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  };
}

export async function fetchTeamCredentialDirectMaterial(params: Readonly<{
  token: string;
  serverUrl?: string;
  teamId: string;
  resourceId: string;
  request: TeamCredentialDirectMaterialOpenRequestV1;
  signal?: AbortSignal;
}>) {
  const request = TeamCredentialDirectMaterialOpenRequestV1Schema.safeParse(params.request);
  if (!request.success) throw new TeamCredentialDirectMaterialHttpContractError();
  let response: AxiosResponse<unknown>;
  try {
    response = await axios.post(route(params), request.data, {
      ...config(params.token, params.signal),
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
  return TeamCredentialDirectMaterialPreparationResponseV1Schema.parse(response.data);
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
  return TeamCredentialDirectMaterialCensusOutputV1Schema.parse(response.data);
}

export async function upsertTeamCredentialDirectMaterial(params: Readonly<{
  token: string;
  serverUrl?: string;
  teamId: string;
  resourceId: string;
  body: TeamCredentialDirectMaterialUpsertRequestV1;
  signal?: AbortSignal;
}>) {
  const body = TeamCredentialDirectMaterialUpsertRequestV1Schema.parse(params.body);
  const response = await axios.put(route(params), body, config(params.token, params.signal));
  return TeamCredentialDirectMaterialUpsertResponseV1Schema.parse(response.data);
}

export async function withdrawTeamCredentialDirectMaterial(params: Readonly<{
  token: string;
  serverUrl?: string;
  teamId: string;
  resourceId: string;
  body: TeamCredentialDirectMaterialWithdrawRequestV1;
  signal?: AbortSignal;
}>) {
  const body = TeamCredentialDirectMaterialWithdrawRequestV1Schema.parse(params.body);
  const response = await axios.delete(route(params), { ...config(params.token, params.signal), data: body });
  return TeamCredentialDirectMaterialWithdrawResponseV1Schema.parse(response.data);
}
