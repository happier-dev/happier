import axios from '@/api/client/credentialAxios';
import { Readable } from 'node:stream';
import { decodeBase64 } from '@/api/encryption';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { openResourceDataKey } from '@/api/encryption/resourceDataKey';
import { openSessionStoredContent } from '@/session/transport/encryption/sessionStoredContentCodec';
import type { StoredCredentials } from '@/persistence';
import { DiscussionCreateResponseV1Schema, DiscussionDetailsResponseV1Schema, DiscussionPostResponseV1Schema,
  DiscussionAgentPublisherResponseV1Schema, type DiscussionAgentPublisherPublicationV1 } from '@happier-dev/protocol/discussions/api';
import { signDiscussionAttachmentAgentUploadV1 } from '@happier-dev/protocol/discussions/attachmentsUpload';
import type { DiscussionAttachmentSourceV1 } from '@happier-dev/protocol/discussions/attachments';
import { DiscussionMessageContentV1Schema, readDiscussionAttachmentReferencesV1 } from '@happier-dev/protocol/discussions/content';
import { DISCUSSION_UPLOAD_CONTENT_TYPE_V1, DISCUSSION_UPLOAD_PATH_V1 } from '@happier-dev/transfers';
import { createDiscussionAttachmentFileReader, prepareDiscussionAttachmentUpload } from './discussionAttachmentUpload';

function publicationFacts(publication: DiscussionAgentPublisherPublicationV1) {
  if ('operation' in publication) {
    const { request: _request, ...facts } = publication;
    return facts;
  }
  const { request: _request, discussionId: _discussionId, ...facts } = publication;
  return facts;
}

/** The existing host publisher calls this only after active-turn or approved-replay admission. */
export async function uploadDiscussionAgentAttachments(input: Readonly<{
  publication: DiscussionAgentPublisherPublicationV1;
  sources: readonly DiscussionAttachmentSourceV1[];
  credentials: StoredCredentials;
  serverUrl: string;
  serverIdentityId: string;
  machineId: string;
  signal?: AbortSignal;
}>) {
  const installation = readInstallationIdentityIfExistsSync();
  const accountId = readAccountIdFromToken(input.credentials.token);
  const denied = () => ({ v: 1 as const, ok: false as const, error: 'discussion_post_denied' as const });
  if (!installation || !accountId || input.signal?.aborted) return denied();
  const publication = input.publication;
  const headers = { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${input.credentials.token}` };
  const baseUrl = input.serverUrl.replace(/\/+$/, '');
  const create = 'operation' in publication;
  const stored = create ? publication.request.firstMessage.content : publication.request.content;
  let mode: 'plain' | 'e2ee' = stored.t === 'plain' ? 'plain' : 'e2ee';
  let dataEncryptionKey = create ? publication.request.dataEncryptionKey ?? null : null;
  if (!create) {
    const response = await axios.get(`${baseUrl}/v1/discussions/${encodeURIComponent(publication.discussionId)}`,
      { headers, signal: input.signal, validateStatus: () => true });
    if (response.status !== 200) return denied();
    const summary = DiscussionDetailsResponseV1Schema.parse(response.data).discussion;
    if (summary.id !== publication.discussionId || !summary.keyReadiness) return denied();
    mode = summary.encryptionMode;
    dataEncryptionKey = summary.dataEncryptionKey;
  }
  const key = await openResourceDataKey({ credentials: input.credentials, mode, dataEncryptionKey });
  const content = DiscussionMessageContentV1Schema.parse(openSessionStoredContent({ content: stored,
    ...(key.mode === 'plain' ? { mode: 'plain', ctx: null } : { mode: 'e2ee',
      ctx: { encryptionKey: key.dataKey, encryptionVariant: 'dataKey' } }) }));
  const references = readDiscussionAttachmentReferencesV1(content);
  const operation = create ? 'create' : publication.request.replyTarget ? 'reply' : 'post';
  const prepared = prepareDiscussionAttachmentUpload({ operation, key, references, signal: input.signal,
    request: create ? publication.request : { ...publication.request, discussionId: publication.discussionId },
    readAttachmentSource: createDiscussionAttachmentFileReader({ references, sources: input.sources }),
    bindAgent: metadata => {
      const agent = { machineId: input.machineId, installationId: installation.installationId, publication: publicationFacts(publication) };
      const signature = signDiscussionAttachmentAgentUploadV1({ homeId: input.serverIdentityId, accountId,
        metadata: { ...metadata, agent }, privateKey: decodeBase64(installation.privateKey, 'base64url') });
      return { ...agent, signature };
    },
  });
  input.signal?.throwIfAborted();
  const response = await axios.request<unknown>({ method: 'POST', url: baseUrl + DISCUSSION_UPLOAD_PATH_V1,
    headers: { ...headers, 'Content-Type': DISCUSSION_UPLOAD_CONTENT_TYPE_V1 }, data: Readable.from(prepared.body),
    signal: input.signal, validateStatus: () => true });
  if (response.status !== 200) {
    const failure = DiscussionAgentPublisherResponseV1Schema.safeParse({ v: 1, ok: false,
      error: response.data && typeof response.data === 'object' && 'error' in response.data ? response.data.error : undefined });
    return failure.success ? failure.data : denied();
  }
  return DiscussionAgentPublisherResponseV1Schema.parse({ v: 1, ok: true,
    value: create ? DiscussionCreateResponseV1Schema.parse(response.data) : DiscussionPostResponseV1Schema.parse(response.data) });
}
