import { randomUUID } from 'node:crypto';

import tweetnacl from 'tweetnacl';
import {
  decodeBase64 as decodeProtocolBase64,
  encodeBase64 as encodeProtocolBase64,
  signMachineInstallationProof,
  verifyMachineInstallationProof as verifyProtocolMachineInstallationProof,
  type MachineInstallationProofPayloadV1,
  type MachineInstallationProofV1,
} from '@happier-dev/protocol';

import { fetchJson } from './http';

export type MachineReplacementSource = 'automatic' | 'manual';

export type MachineIdentityRow = {
  id: string;
  active?: boolean;
  activeAt?: number | null;
  metadata?: unknown;
  metadataVersion?: number;
  daemonState?: unknown;
  daemonStateVersion?: number;
  installationId?: string | null;
  installationPublicKey?: string | null;
  contentPublicKeyFingerprint?: string | null;
  replacedByMachineId?: string | null;
  replacedAt?: number | null;
  replacementReason?: string | null;
  replacementSource?: MachineReplacementSource | null;
  replacementActorUserId?: string | null;
};

export type MachineInstallationIdentityFixture = {
  installationId: string;
  publicKeyBase64: string;
  privateKeyBase64: string;
};

export type MachineInstallationProofInput = {
  installationId: string;
  machineId: string;
  privateKeyBase64: string;
  replacesMachineId?: string | null;
  replacementReason?: string | null;
  contentPublicKeyFingerprint?: string | null;
  accountId?: string | null;
};

export type MachineInstallationProofFixture = MachineInstallationProofV1;

type MachineRegistrationResponse = {
  machine?: MachineIdentityRow;
  replacement?: unknown;
  replacementCandidate?: unknown;
};

type MachineListResponse = MachineIdentityRow[] | { machines?: MachineIdentityRow[] };

function readAccountIdFromToken(token: string): string | null {
  const [, payload] = token.split('.');
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    if (!decoded || typeof decoded !== 'object' || !('sub' in decoded)) return null;
    const sub = decoded.sub;
    return typeof sub === 'string' && sub.trim() ? sub.trim() : null;
  } catch {
    return null;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  return encodeProtocolBase64(Uint8Array.from(bytes), 'base64url');
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(decodeProtocolBase64(value, 'base64url'));
}

function buildMachineInstallationProofPayload(
  params: Omit<MachineInstallationProofInput, 'privateKeyBase64'>,
): MachineInstallationProofPayloadV1 {
  return {
    version: 1,
    installationId: params.installationId,
    machineId: params.machineId,
    ...(params.replacesMachineId ? { replacesMachineId: params.replacesMachineId } : null),
    ...(params.replacementReason ? { replacementReason: params.replacementReason } : null),
    ...(params.contentPublicKeyFingerprint
      ? { contentPublicKeyFingerprint: params.contentPublicKeyFingerprint }
      : null),
    ...(params.accountId ? { accountId: params.accountId } : null),
  };
}

export function createMachineInstallationIdentityFixture(
  overrides?: Partial<Pick<MachineInstallationIdentityFixture, 'installationId'>>,
): MachineInstallationIdentityFixture {
  const keyPair = tweetnacl.sign.keyPair();
  return {
    installationId: overrides?.installationId ?? randomUUID(),
    publicKeyBase64: encodeBase64(keyPair.publicKey),
    privateKeyBase64: encodeBase64(keyPair.secretKey),
  };
}

export function buildMachineInstallationProof(params: MachineInstallationProofInput): MachineInstallationProofFixture {
  const payload = buildMachineInstallationProofPayload(params);
  return signMachineInstallationProof({
    payload,
    privateKey: decodeBase64(params.privateKeyBase64),
  });
}

export function verifyMachineInstallationProof(params: Readonly<{
  installationId: string;
  machineId: string;
  publicKeyBase64: string;
  proof: MachineInstallationProofFixture;
  replacesMachineId?: string | null;
  replacementReason?: string | null;
  contentPublicKeyFingerprint?: string | null;
  accountId?: string | null;
}>): boolean {
  const expectedPayload = buildMachineInstallationProofPayload(params);
  return verifyProtocolMachineInstallationProof({
    payload: expectedPayload,
    proof: params.proof,
    publicKey: params.publicKeyBase64,
  });
}

export async function registerMachineIdentity(params: Readonly<{
  baseUrl: string;
  token: string;
  machineId?: string;
  metadata?: string;
  daemonState?: string | null;
  dataEncryptionKey?: string | null;
  contentPublicKey?: string | null;
  contentPublicKeySig?: string | null;
  installation?: MachineInstallationIdentityFixture | null;
  replacesMachineId?: string | null;
  replacementReason?: string | null;
  contentPublicKeyFingerprint?: string | null;
}>): Promise<{ status: number; machineId: string; machine: MachineIdentityRow | null; data: MachineRegistrationResponse }> {
  const machineId = params.machineId ?? randomUUID();
  const installation = params.installation ?? null;
  const contentPublicKeyFingerprint = params.contentPublicKeyFingerprint ?? null;
  const accountId = readAccountIdFromToken(params.token);
  const body: Record<string, unknown> = {
    id: machineId,
    metadata: params.metadata ?? `e2e-machine-metadata:${machineId}`,
  };
  if (params.daemonState !== undefined) body.daemonState = params.daemonState;
  if (params.dataEncryptionKey !== undefined) body.dataEncryptionKey = params.dataEncryptionKey;
  if (params.contentPublicKey !== undefined) body.contentPublicKey = params.contentPublicKey;
  if (params.contentPublicKeySig !== undefined) body.contentPublicKeySig = params.contentPublicKeySig;
  if (installation) {
    body.installationId = installation.installationId;
    body.installationPublicKey = installation.publicKeyBase64;
    body.installationProof = buildMachineInstallationProof({
      installationId: installation.installationId,
      machineId,
      privateKeyBase64: installation.privateKeyBase64,
      replacesMachineId: params.replacesMachineId ?? null,
      replacementReason: params.replacementReason ?? null,
      contentPublicKeyFingerprint,
      accountId,
    });
  }
  if (params.replacesMachineId !== undefined) body.replacesMachineId = params.replacesMachineId;
  if (params.replacementReason !== undefined) body.replacementReason = params.replacementReason;
  if (params.contentPublicKeyFingerprint !== undefined) body.contentPublicKeyFingerprint = params.contentPublicKeyFingerprint;

  const response = await fetchJson<MachineRegistrationResponse>(`${params.baseUrl}/v1/machines`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    timeoutMs: 15_000,
  });

  return {
    status: response.status,
    machineId,
    machine: response.data?.machine ?? null,
    data: response.data,
  };
}

export async function fetchMachineIdentities(params: Readonly<{
  baseUrl: string;
  token: string;
}>): Promise<MachineIdentityRow[]> {
  const response = await fetchJson<MachineListResponse>(`${params.baseUrl}/v1/machines`, {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: 15_000,
  });
  if (response.status !== 200) {
    throw new Error(`Failed to fetch machines (status=${response.status})`);
  }
  if (Array.isArray(response.data)) return response.data;
  return response.data.machines ?? [];
}

export async function fetchMachineIdentity(params: Readonly<{
  baseUrl: string;
  token: string;
  machineId: string;
}>): Promise<MachineIdentityRow> {
  const machines = await fetchMachineIdentities({ baseUrl: params.baseUrl, token: params.token });
  const machine = machines.find((row) => row.id === params.machineId);
  if (!machine) {
    throw new Error(`Machine not found: ${params.machineId}`);
  }
  return machine;
}

export async function replaceMachineManually(params: Readonly<{
  baseUrl: string;
  token: string;
  oldMachineId: string;
  replacementMachineId: string;
  reason?: string;
  confirmActiveOldMachine?: boolean;
}>): Promise<{ status: number; data: unknown }> {
  const response = await fetchJson<unknown>(
    `${params.baseUrl}/v1/machines/${encodeURIComponent(params.oldMachineId)}/replacement`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        replacementMachineId: params.replacementMachineId,
        reason: params.reason ?? 'manual-repair',
        confirmActiveOldMachine: params.confirmActiveOldMachine === true,
      }),
      timeoutMs: 15_000,
    },
  );
  return { status: response.status, data: response.data };
}

export async function undoMachineReplacement(params: Readonly<{
  baseUrl: string;
  token: string;
  oldMachineId: string;
}>): Promise<{ status: number; data: unknown }> {
  const response = await fetchJson<unknown>(
    `${params.baseUrl}/v1/machines/${encodeURIComponent(params.oldMachineId)}/replacement`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${params.token}` },
      timeoutMs: 15_000,
    },
  );
  return { status: response.status, data: response.data };
}
