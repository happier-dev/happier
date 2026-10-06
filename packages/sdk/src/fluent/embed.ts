import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';
import type { ActionIdFamilyV1 } from '@happier-dev/protocol/actions';
import { isModelRefGrantedV1, resolveEffectiveApiTokenModelRefV1, resolveEffectiveApiTokenPermissionModeV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { ApiTokenGrantV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { EmbedCredentialV1Schema, EmbedPublicKeyV1Schema, EmbedSessionKeyV1Schema } from '@happier-dev/protocol/embed/embedBridgeV1';
import { EmbedSessionOptionsV1Schema, projectComposerOptionsInputV1 } from '@happier-dev/protocol/embed/embedSessionOptionsV1';
import type { EmbedConfigV1, EmbedCredentialV1 } from '@happier-dev/protocol/embed';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { sealBoxBundle } from '@happier-dev/protocol/crypto/boxBundle';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { openSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { parseSessionPermissionModeAlias } from '@happier-dev/protocol/sessions/metadata/permission-modes';
import type { HappierApiTokens } from '../connect.js';
import { HappierTransportError } from '../errors.js';
import { openSessionDataKey } from '../live/openSessionDataKey.js';
import type { ActionExecutionOptions } from '../types.js';
import type { HappierMachineSessions, HappierSession, HappierSessionListInput, HappierSessions } from './sessions.js';
import type { PublicActionResultById } from '../actions/generated.js';

/** Routing and creation bounds come only from the parent API-token grant. */
export type HappierEmbedActionOptions = Readonly<Omit<ActionExecutionOptions, 'target'>>;
export type HappierEmbedOptions = Readonly<{ signal?: AbortSignal }>;
export type HappierEmbedCreateSessionInput = Readonly<{
  model?: NonNullable<ApiTokenGrantV1['models']>[number];
  title?: string;
  initialMessage?: string;
  permissionMode?: string;
}>;
export type HappierEmbedListSessionsInput = Readonly<
  Omit<HappierSessionListInput, 'folderIds' | 'tagIds'> & { folderId?: string | null; tagIds?: readonly string[] }
>;
export type HappierEmbedCreateCredentialInput = Readonly<{
  sessionId?: string;
  embedPublicKey: string;
  expiresInSeconds: number;
  requireCreatedBy?: string;
}>;
export type HappierEmbedCredential = Readonly<EmbedCredentialV1 & { tokenId: string }>;
export type HappierEmbed = Readonly<{
  get: (options?: HappierEmbedOptions) => Promise<EmbedConfigV1>;
  createSession: (input?: HappierEmbedCreateSessionInput, options?: HappierEmbedActionOptions) => Promise<HappierSession<HappierEmbedActionOptions>>;
  listSessions: (input?: HappierEmbedListSessionsInput, options?: HappierEmbedActionOptions) => Promise<PublicActionResultById['session.list']>;
  createCredential: (input: HappierEmbedCreateCredentialInput, options?: HappierEmbedOptions) => Promise<HappierEmbedCredential>;
}>;

type EmbedParams = Readonly<{
  apiTokens: HappierApiTokens;
  machineSessions: (machineId: string) => HappierMachineSessions;
  sessions: HappierSessions;
  readSession: (sessionId: string, signal?: AbortSignal) => Promise<unknown>;
  requireSessionId: (sessionId: string) => string;
  getAccountMaterial?: (signal?: AbortSignal) => Promise<Readonly<{ type: 'dataKey'; machineKey: Uint8Array }>>;
}>;

function refuse(code: string): never {
  throw new HappierTransportError(`The embed operation was refused: ${code}.`, { code });
}

/** Preserve the parent's vocabulary, expanding only families that contain removed authority. */
function sessionChildGrant(parent: ApiTokenGrantV1, sessionId: string): ApiTokenGrantV1 {
  const removed = new Set<string>(['session.spawn_new', ...ACTION_ID_FAMILIES_V1.session_targeting]);
  const families: ActionIdFamilyV1[] = [];
  const ids = new Set(parent.actions?.ids.filter((id) => !removed.has(id)) ?? []);
  const parentFamilies = parent.actions?.families ?? Object.keys(ACTION_ID_FAMILIES_V1) as ActionIdFamilyV1[];
  for (const family of parentFamilies) {
    if (family === 'session_targeting') continue;
    const members: readonly string[] = ACTION_ID_FAMILIES_V1[family];
    if (members.some((id) => removed.has(id))) {
      for (const id of members) if (!removed.has(id)) ids.add(id);
    } else families.push(family);
  }
  return { ...parent, actions: { families, ids: [...ids] },
    targets: { sessions: [sessionId], machines: [] }, create: null };
}

export function createEmbed(params: EmbedParams): HappierEmbed {
  const readParent = async (options?: HappierEmbedOptions) => {
    const parent = await params.apiTokens.self(options);
    if (parent.embedConfig === null) refuse('not_an_embed_key');
    return { grant: parent.grant, config: parent.embedConfig, accountMode: parent.accountEncryptionMode };
  };
  const embed: HappierEmbed = {
    async get(options) { return (await readParent(options)).config; },
    async createSession(input = {}, options) {
      const { grant } = await readParent(options);
      if (grant.create === null) refuse('create_not_granted');
      const requested = input.permissionMode === undefined ? null : parseSessionPermissionModeAlias(input.permissionMode);
      const permissionMode = resolveEffectiveApiTokenPermissionModeV1(grant, requested ?? undefined);
      if (permissionMode === null) refuse('permission_mode_not_granted');
      if (input.model !== undefined && (!isModelRefGrantedV1(grant, input.model)
        || input.model.agentTargetKey !== grant.create.agentTargetKey)) refuse('model_not_granted');
      const model = resolveEffectiveApiTokenModelRefV1(grant, input.model, grant.create.agentTargetKey);
      if (model === null) refuse('model_not_granted');
      return params.machineSessions(grant.create.machineId).spawn({
        agent: grant.create.agentTargetKey,
        directory: { kind: 'managed' }, organizationPlacement: grant.create.placement,
        permissionMode,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.initialMessage === undefined ? {} : { initialMessage: input.initialMessage }),
        // Initial selection has no prior mutation to order; keep retry payloads identical.
        ...(model === 'automatic' ? {} : { modelSelection: { v: 1, ref: model, updatedAt: 0 } }),
      }, { signal: options?.signal, requestId: options?.requestId });
    },
    async listSessions(input = {}, options) {
      const { config } = await readParent(options);
      const folderId = input.folderId === undefined ? config.organization.folderId : input.folderId;
      const tagIds = input.tagIds === undefined ? config.organization.tagIds : [...input.tagIds];
      if (!folderId && tagIds.length === 0) refuse('listing_filter_required');
      const { folderId: _folderId, tagIds: _tagIds, ...query } = input;
      return params.sessions.list({ ...query, folderIds: folderId ? [folderId] : [], tagIds },
        { signal: options?.signal, requestId: options?.requestId });
    },
    async createCredential(input, options) {
      const publicKey = decodeBase64(EmbedPublicKeyV1Schema.parse(input.embedPublicKey), 'base64url');
      if (!Number.isFinite(input.expiresInSeconds) || input.expiresInSeconds <= 0) {
        throw new TypeError('expiresInSeconds must be finite and positive');
      }
      const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1_000).toISOString();
      const { grant, config, accountMode } = await readParent(options);
      const sessionId = input.sessionId === undefined ? undefined : params.requireSessionId(input.sessionId);
      let childGrant: ApiTokenGrantV1;
      if (sessionId === undefined) {
        if (grant.create === null) refuse('create_not_granted');
        if (!config.newChat?.enabled) refuse('new_chat_disabled');
        if (input.requireCreatedBy !== undefined) throw new TypeError('requireCreatedBy requires sessionId');
        childGrant = { ...grant, actions: { families: [], ids: ['session.spawn_new'] }, approve: false,
          targets: { sessions: [], machines: [grant.create.machineId] } };
      } else childGrant = sessionChildGrant(grant, sessionId);
      // Attribution is checked atomically by the mint owner, before any content read.
      const minted = await params.apiTokens.createChild({ label: sessionId === undefined ? 'Embed new chat' : 'Embed session',
        expiresAt, grant: childGrant,
        ...(input.requireCreatedBy === undefined ? {} : { requireCreatedByChildTokenId: input.requireCreatedBy }),
      }, options);
      try {
      if (minted.apiToken.expiresAt === null) refuse('invalid_api_token_output');
      const credential = { token: minted.token, expiresAt: minted.apiToken.expiresAt, tokenId: minted.apiToken.tokenId };
      if (sessionId === undefined) return credential;
      const parsed = V2SessionByIdResponseSchema.safeParse(await params.readSession(sessionId, options?.signal));
      if (!parsed.success || parsed.data.session.id !== sessionId) refuse('invalid_session_snapshot');
      const session = parsed.data.session;
      if (session.encryptionMode !== 'plain' && session.encryptionMode !== 'e2ee') refuse('invalid_session_snapshot');
      if (accountMode === 'plain') {
        if (session.encryptionMode !== 'plain' || session.dataEncryptionKey !== null || session.ownerMetadata?.t === 'encrypted') refuse('account_mode_mismatch');
        return credential;
      }
      // Session mode owns transcript encryption; Account mode independently owns owner metadata.
      const standaloneKey = session.encryptionMode === 'e2ee'
        ? EmbedSessionKeyV1Schema.safeParse(session.dataEncryptionKey) : undefined;
      if (standaloneKey !== undefined && !standaloneKey.success) refuse('session_key_not_transferable');
      if (session.encryptionMode === 'plain' && session.dataEncryptionKey !== null) refuse('account_mode_mismatch');
      if (params.getAccountMaterial === undefined) refuse('encryption_credential_required');
      // The shared credential owns its root key; zeroize only operation-local copies.
      const accountKey = new Uint8Array((await params.getAccountMaterial(options?.signal)).machineKey);
      const ephemeralSecrets: Uint8Array[] = [];
      const randomBytes = (length: number) => {
        const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length));
        ephemeralSecrets.push(bytes);
        return bytes;
      };
      let dataKey: Uint8Array | undefined;
      let plaintext: Uint8Array | undefined;
      try {
        if (standaloneKey?.success) dataKey = openSessionDataKey(standaloneKey.data, accountKey);
        let sessionOptions: string | undefined;
        // Layout-zero and shared-recipient rows have no optional owner projection.
        // A present envelope must still open successfully; corruption is not absence.
        if (session.ownerMetadata !== undefined) {
          const owner = openSessionOwnerMetadataEnvelopeV1({ accountMode: 'e2ee', envelope: session.ownerMetadata,
            material: { type: 'dataKey', machineKey: accountKey } });
          if (!owner.ok) refuse('session_options_unavailable');
          const projection = EmbedSessionOptionsV1Schema.parse({ v: 1, sessionId,
            owner: projectComposerOptionsInputV1(owner.ownerMetadata.runtime) });
          plaintext = new TextEncoder().encode(JSON.stringify(projection));
          sessionOptions = encodeBase64(sealBoxBundle({ plaintext, recipientPublicKey: publicKey, randomBytes }), 'base64url');
        }
        const sessionKey = dataKey === undefined ? undefined : encodeBase64(
          sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: publicKey, randomBytes }), 'base64');
        return { ...EmbedCredentialV1Schema.parse({ token: credential.token, expiresAt: credential.expiresAt,
          ...(sessionKey === undefined ? {} : { sessionKey }),
          ...(sessionOptions === undefined ? {} : { sessionOptions }) }),
          tokenId: credential.tokenId };
      } finally {
        accountKey.fill(0);
        dataKey?.fill(0);
        plaintext?.fill(0);
        for (const secret of ephemeralSecrets) secret.fill(0);
      }
      } catch (error) {
        // A refused handoff must not leave an unreturned child active. Cleanup is
        // independent of the caller's signal, which may already be aborted.
        try {
          await params.apiTokens.revokeChild(minted.apiToken.tokenId);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Embed credential admission failed and its child could not be revoked.');
        }
        throw error;
      }
    },
  };
  return Object.freeze(embed);
}
