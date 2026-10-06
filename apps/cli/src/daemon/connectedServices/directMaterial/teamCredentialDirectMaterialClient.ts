import { computeTeamCredentialSourceMemberKeyV1, materializeTeamCredentialDirectMaterialV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import type { TeamCredentialDirectMaterialExpected, TeamCredentialDirectMaterialPayloadV1, TeamCredentialDirectMaterialStoredV1, TeamCredentialDirectMaterialOpenRequestV1, TeamCredentialErrorCodeV1 } from '@happier-dev/protocol/teams';
import {
  fetchTeamCredentialDirectMaterial,
  TeamCredentialDirectMaterialHttpContractError,
  TeamCredentialDirectMaterialHttpTransportError,
} from './teamCredentialDirectMaterialHttp';

export type TeamCredentialDirectMaterialUnavailableReason =
  | 'preparing'
  | 'source_changed'
  | 'recipient_binding_changed'
  | 'access_removed'
  | 'disabled'
  | 'temporarily_unavailable'
  | 'unsupported_direct_source'
  | 'invalid_material'
  | 'resource_corrupt';

export type TeamCredentialDirectMaterialOperationFailure = Readonly<{
  error: TeamCredentialErrorCodeV1;
}>;

/** Secret-free carrier for a canonical Team resource operation refusal. */
export class TeamCredentialDirectMaterialOperationError extends Error {
  readonly code: TeamCredentialErrorCodeV1;

  constructor(error: TeamCredentialDirectMaterialOperationFailure) {
    super(error.error);
    this.name = 'TeamCredentialDirectMaterialOperationError';
    this.code = error.error;
  }
}

type RecipientEncryptionMaterial =
  | Readonly<{ mode: 'plain' }>
  | Readonly<{ mode: 'e2ee'; secretKeyOrSeed: Uint8Array }>
  | Readonly<{ mode: 'e2ee_unavailable' }>;

type CurrentMaterialRead =
  | Readonly<{
      ok: true;
      recipientMode: 'plain' | 'e2ee';
      stored: TeamCredentialDirectMaterialStoredV1;
      expected: TeamCredentialDirectMaterialExpected;
    }>
  | Readonly<{ ok: false; reason: TeamCredentialDirectMaterialUnavailableReason }>
  | Readonly<{ ok: false; operationError: TeamCredentialDirectMaterialOperationFailure }>;

export type TeamCredentialDirectMaterialClient = Readonly<{
  open(input: TeamCredentialDirectMaterialOpenRequestV1 & Readonly<{
    teamId?: string;
    signal?: AbortSignal;
  }>): Promise<
    | Readonly<{ ok: true; payload: TeamCredentialDirectMaterialPayloadV1 }>
    | Readonly<{ ok: false; reason: TeamCredentialDirectMaterialUnavailableReason }>
    | Readonly<{ ok: false; operationError: TeamCredentialDirectMaterialOperationFailure }>
  >;
}>;

/**
 * The direct material client is the sole recipient opener. Its fetch owner
 * derives expected bindings from current server authority and its encryption
 * owner derives Account mode/key material; public callers author neither.
 */
export function createTeamCredentialDirectMaterialClient(dependencies: Readonly<{
  fetchCurrent(input: TeamCredentialDirectMaterialOpenRequestV1 & Readonly<{
    teamId?: string;
    signal?: AbortSignal;
  }>): Promise<CurrentMaterialRead>;
  readRecipientEncryptionMaterial(signal?: AbortSignal): Promise<RecipientEncryptionMaterial>;
}>): TeamCredentialDirectMaterialClient {
  return Object.freeze({
    async open(input) {
      input.signal?.throwIfAborted();
      const current = await dependencies.fetchCurrent(input);
      input.signal?.throwIfAborted();
      if (!current.ok) return current;
      if (
        current.expected.resourceId !== input.resourceId
        || (input.teamId !== undefined && current.expected.teamId !== input.teamId)
      ) {
        return { ok: false, reason: 'source_changed' };
      }
      const recipient = await dependencies.readRecipientEncryptionMaterial(input.signal);
      input.signal?.throwIfAborted();
      if (recipient.mode === 'e2ee_unavailable') {
        return { ok: false, reason: 'recipient_binding_changed' };
      }
      if (recipient.mode !== current.recipientMode) {
        return { ok: false, reason: 'recipient_binding_changed' };
      }
      const payload = materializeTeamCredentialDirectMaterialV1({
        stored: current.stored,
        recipientMode: recipient.mode,
        expected: current.expected,
        ...(recipient.mode === 'e2ee' ? { recipientSecretKeyOrSeed: recipient.secretKeyOrSeed } : {}),
      });
      if (!payload) return { ok: false, reason: 'invalid_material' };
      if (computeTeamCredentialSourceMemberKeyV1(payload.sourceMember) !== current.expected.sourceMemberKey) {
        return { ok: false, reason: 'invalid_material' };
      }
      return { ok: true, payload };
    },
  });
}

/** Authenticated HTTP adapter for the one canonical recipient opener. */
export function createHttpTeamCredentialDirectMaterialClient(params: Readonly<{
  token: string;
  teamId?: string;
  serverUrl?: string;
  readRecipientEncryptionMaterial(signal?: AbortSignal): Promise<RecipientEncryptionMaterial>;
}>): TeamCredentialDirectMaterialClient {
  return createTeamCredentialDirectMaterialClient({
    readRecipientEncryptionMaterial: params.readRecipientEncryptionMaterial,
    async fetchCurrent(input) {
      const teamId = input.teamId ?? params.teamId;
      if (!teamId) return { ok: false, reason: 'access_removed' };
      try {
        const result = await fetchTeamCredentialDirectMaterial({
          token: params.token,
          teamId,
          resourceId: input.resourceId,
          request: {
            consumer: input.consumer,
            resourceId: input.resourceId,
            ...('sourceMemberKey' in input
              ? { slot: input.slot, sourceMemberKey: input.sourceMemberKey }
              : { slot: input.slot, disclosedMember: input.disclosedMember }),
          },
          ...(params.serverUrl ? { serverUrl: params.serverUrl } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        input.signal?.throwIfAborted();
        if (result.status === 'operation_error') {
          return { ok: false, operationError: result.error };
        }
        return result.status === 'ready'
          ? { ok: true, recipientMode: result.recipientMode, stored: result.stored, expected: result.expected }
          : { ok: false, reason: result.reason };
      } catch (error) {
        input.signal?.throwIfAborted();
        if (error instanceof TeamCredentialDirectMaterialHttpTransportError) {
          return { ok: false, reason: 'temporarily_unavailable' };
        }
        if (error instanceof TeamCredentialDirectMaterialHttpContractError) {
          return { ok: false, reason: 'resource_corrupt' };
        }
        throw error;
      }
    },
  });
}
