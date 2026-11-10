import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { SESSION_DATA_KEY_NONCE_BYTES, SESSION_DATA_KEY_TAG_BYTES } from '../crypto/sessionDataKeyBundleV0.js';
import { MAX_ATTACHMENT_UPLOAD_FILE_BYTES_V1 } from '../transfers/attachments/attachmentLimitsV1.js';
import { DiscussionCreateRequestV1Schema, DiscussionPostRequestV1Schema, DiscussionAgentPublisherPublicationV1Schema,
  DiscussionAgentCreateRequestV1Schema, DiscussionAgentPostPublicationV1Schema, type DiscussionAgentPublisherPublicationV1 } from './api.js';
import { DiscussionAttachmentBindingV1Schema, DiscussionAttachmentReadRequestV1Schema } from './attachments.js';
import { DiscussionIdSchema } from './references.js';
import { DiscussionReplyTargetV1Schema } from './replyTargets.js';
import { MachineInstallationProofSignatureSchema } from '../machines/identity/installationKeySchemas.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { encodeCanonicalLengthDelimited } from '../crypto/canonicalDigest.js';
import { signEd25519Message, verifyEd25519Signature } from '../crypto/ed25519.js';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';

/** Existing AES-GCM byte framing: version byte, nonce and authentication tag. */
export const DISCUSSION_ATTACHMENT_ENCRYPTED_OVERHEAD_BYTES_V1 = 1 + SESSION_DATA_KEY_NONCE_BYTES + SESSION_DATA_KEY_TAG_BYTES;

/** Clear metadata reveals structural lengths and ids only, never names/MIME/plaintext hashes. */
export const DiscussionAttachmentUploadSegmentV1Schema = lazyZodSchema(() => z.extend(DiscussionAttachmentBindingV1Schema, {
  storedSizeBytes: z.number().check(z.int(), z.nonnegative()),
}).check(z.refine(segment => segment.t === 'plain'
  ? segment.storedSizeBytes <= MAX_ATTACHMENT_UPLOAD_FILE_BYTES_V1
  : segment.storedSizeBytes >= DISCUSSION_ATTACHMENT_ENCRYPTED_OVERHEAD_BYTES_V1
    && segment.storedSizeBytes <= MAX_ATTACHMENT_UPLOAD_FILE_BYTES_V1 + DISCUSSION_ATTACHMENT_ENCRYPTED_OVERHEAD_BYTES_V1,
  'Attachment bytes exceed the supported per-file boundary or encrypted framing is incomplete')));
export type DiscussionAttachmentUploadSegmentV1 = z.infer<typeof DiscussionAttachmentUploadSegmentV1Schema>;

const segments = z.array(DiscussionAttachmentUploadSegmentV1Schema).check(z.refine(entries =>
  new Set(entries.map(entry => entry.blobId)).size === entries.length, 'Attachment upload blob ids must be unique'));
const postInput = lazyZodSchema(() => z.safeExtend(DiscussionPostRequestV1Schema, { discussionId: DiscussionIdSchema }));
const agentUpload = lazyZodSchema(() => z.strictObject({
  machineId: DiscussionIdSchema, installationId: DiscussionIdSchema,
  // The stored request appears once in input, preserving the shared metadata budget.
  publication: z.union([
    z.omit(DiscussionAgentCreateRequestV1Schema, { request: true, attachmentSources: true }),
    z.omit(DiscussionAgentPostPublicationV1Schema, { request: true, discussionId: true }),
  ]),
  signature: MachineInstallationProofSignatureSchema,
}));

/** Alternate byte representation of the same admitted storage mutation, not a second writer. */
export const DiscussionAttachmentUploadRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('create'), input: DiscussionCreateRequestV1Schema, attachments: segments, agent: z.optional(agentUpload) }),
  z.strictObject({ operation: z.literal('post'), input: postInput, attachments: segments, agent: z.optional(agentUpload) }),
  z.strictObject({ operation: z.literal('reply'), input: z.safeExtend(postInput, { replyTarget: DiscussionReplyTargetV1Schema }), attachments: segments, agent: z.optional(agentUpload) }),
  z.strictObject({ operation: z.literal('encryption-conversion'), input: DiscussionAttachmentReadRequestV1Schema, attachments: segments }),
]).check(z.superRefine((value, context) => {
  if (value.operation === 'encryption-conversion') {
    if (value.attachments.length !== 1 || value.attachments[0]?.blobId !== value.input.blobId) {
      context.addIssue({ code: 'custom', path: ['attachments'], message: 'Conversion stages exactly the qualified attachment' });
    }
    return;
  }
  const message = value.operation === 'create' ? value.input.firstMessage : value.input;
  const bindings = message.attachments ?? [];
  if (bindings.length !== value.attachments.length || value.attachments.some((segment, index) =>
    segment.blobId !== bindings[index]?.blobId || segment.t !== bindings[index]?.t || segment.t !== message.content.t)) {
    context.addIssue({ code: 'custom', path: ['attachments'], message: 'Ordered upload segments must match the exact message bindings and mode' });
  }
  if (value.agent) {
    const publication = value.agent.publication;
    if ((value.operation === 'create') !== ('operation' in publication)) {
      context.addIssue({ code: 'custom', path: ['agent'], message: 'Agent uploads bind the exact admitted publication' });
    }
  }
})));
export type DiscussionAttachmentUploadRequestV1 = z.infer<typeof DiscussionAttachmentUploadRequestV1Schema>;

/** Reuse the existing publisher contract without copying its stored request into upload metadata. */
export function readDiscussionAttachmentAgentPublicationV1(metadata: DiscussionAttachmentUploadRequestV1): DiscussionAgentPublisherPublicationV1 | null {
  if (metadata.operation === 'encryption-conversion' || !metadata.agent) return null;
  if (metadata.operation === 'create') return DiscussionAgentPublisherPublicationV1Schema.parse({ ...metadata.agent.publication, request: metadata.input });
  const { discussionId, ...request } = metadata.input;
  return DiscussionAgentPublisherPublicationV1Schema.parse({ ...metadata.agent.publication, discussionId, request });
}

/** Existing installation identity attests only this exact Home/Account publication and byte framing. */
export function discussionAttachmentAgentSigningPayloadV1(input: Readonly<{
  homeId: string; accountId: string;
  metadata: Pick<DiscussionAttachmentUploadRequestV1, 'operation' | 'input' | 'attachments'> & Readonly<{
    agent?: Omit<z.infer<typeof agentUpload>, 'signature'> & Readonly<{ signature?: string }>;
  }>;
}>): Uint8Array {
  const metadata = input.metadata;
  if (metadata.operation === 'encryption-conversion' || !metadata.agent) throw new Error('Agent upload identity is required');
  const { signature: _signature, ...agent } = metadata.agent;
  return encodeCanonicalLengthDelimited(['happier-discussion-attachment-upload-v1', input.homeId, input.accountId,
    createCanonicalJsonSigningInput({ ...metadata, agent })]);
}

export function signDiscussionAttachmentAgentUploadV1(input: Parameters<typeof discussionAttachmentAgentSigningPayloadV1>[0]
  & Readonly<{ privateKey: Uint8Array }>): string {
  return encodeBase64(signEd25519Message(discussionAttachmentAgentSigningPayloadV1(input), input.privateKey), 'base64url');
}

export function verifyDiscussionAttachmentAgentUploadV1(input: Parameters<typeof discussionAttachmentAgentSigningPayloadV1>[0]
  & Readonly<{ publicKey: Uint8Array; signature: string }>): boolean {
  try {
    return verifyEd25519Signature(discussionAttachmentAgentSigningPayloadV1(input), decodeBase64(input.signature, 'base64url'), input.publicKey);
  } catch { return false; }
}
