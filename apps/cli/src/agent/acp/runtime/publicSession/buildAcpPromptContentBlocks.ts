import type { ContentBlock } from '@agentclientprotocol/sdk';
import {
  HappierStructuredInputV1Schema,
  normalizeSessionAttachmentUploadPath,
} from '@happier-dev/protocol/runtime';

import { configuration } from '@/configuration';
import { readVerifiedSessionAttachmentLocalImage } from '@/session/attachments/resolveTrustedSessionAttachmentLocalImagePaths';
import {
  normalizeSessionMediaMimeType,
  sniffSessionMediaMimeType,
} from '@/session/media/mime';

const MAX_IMAGE_INPUTS = 16;

type PromptProjectionFailureCode =
  | 'acp_image_input_unsupported'
  | 'acp_image_input_untrusted'
  | 'acp_image_input_invalid';

export class AcpPromptProjectionError extends Error {
  constructor(
    readonly code: PromptProjectionFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'AcpPromptProjectionError';
  }
}

function readUploadDigest(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value)
    ? value.toLowerCase()
    : null;
}

function readUploadSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function readTrustedLocalImage(params: Readonly<{
  cwd: string;
  image: Record<string, unknown>;
}>): Promise<Extract<ContentBlock, { type: 'image' }>> {
  const provenance = params.image.provenance;
  if (
    !provenance
    || typeof provenance !== 'object'
    || Array.isArray(provenance)
    || (provenance as Record<string, unknown>).kind !== 'sessionAttachmentUpload'
  ) {
    throw new AcpPromptProjectionError('acp_image_input_untrusted', 'ACP image input lacks trusted upload provenance');
  }
  const uploadPath = typeof params.image.path === 'string' ? params.image.path.trim() : '';
  const normalizedUploadPath = normalizeSessionAttachmentUploadPath(uploadPath);
  const sha256 = readUploadDigest(params.image.sha256);
  const declaredSize = readUploadSize(params.image.sizeBytes);
  if (!normalizedUploadPath || !sha256 || declaredSize === null) {
    throw new AcpPromptProjectionError('acp_image_input_untrusted', 'ACP image input lacks a verified upload envelope');
  }
  const bytes = await readVerifiedSessionAttachmentLocalImage({
    cwd: params.cwd,
    uploadPath: normalizedUploadPath,
    sha256,
    sizeBytes: declaredSize,
    maxBytes: configuration.filesUploadMaxFileBytes,
  });
  if (!bytes) {
    throw new AcpPromptProjectionError('acp_image_input_untrusted', 'ACP image upload could not be verified');
  }
  const mimeType = sniffSessionMediaMimeType(bytes);
  if (!mimeType || !mimeType.startsWith('image/')) {
    throw new AcpPromptProjectionError('acp_image_input_invalid', 'ACP image upload has an unsupported MIME type');
  }
  const declaredMimeType = normalizeSessionMediaMimeType(params.image.mimeType);
  if (params.image.mimeType !== undefined && declaredMimeType !== mimeType) {
    throw new AcpPromptProjectionError('acp_image_input_invalid', 'ACP image upload MIME type does not match its content');
  }
  return { type: 'image', data: bytes.toString('base64'), mimeType };
}

export async function buildAcpPromptContentBlocks(params: Readonly<{
  cwd: string;
  text: string;
  structuredInput?: unknown;
  acceptsImageInput: boolean;
}>): Promise<readonly ContentBlock[]> {
  const structured = params.structuredInput === undefined
    ? null
    : HappierStructuredInputV1Schema.safeParse(params.structuredInput);
  if (structured && !structured.success) {
    throw new AcpPromptProjectionError('acp_image_input_invalid', 'ACP structured input is malformed');
  }
  const images = structured?.success ? structured.data.imageInputs ?? [] : [];
  if (images.length > MAX_IMAGE_INPUTS) {
    throw new AcpPromptProjectionError('acp_image_input_invalid', 'ACP image input count exceeds the host bound');
  }
  if (images.length > 0 && !params.acceptsImageInput) {
    throw new AcpPromptProjectionError('acp_image_input_unsupported', 'ACP provider does not advertise image prompt support');
  }
  const blocks: ContentBlock[] = [];
  if (params.text.length > 0) blocks.push({ type: 'text', text: params.text });
  for (const image of images) {
    if (image.kind !== 'localImage') {
      throw new AcpPromptProjectionError('acp_image_input_untrusted', 'ACP remote image references are not trusted prompt inputs');
    }
    blocks.push(await readTrustedLocalImage({ cwd: params.cwd, image }));
  }
  if (blocks.length === 0) {
    throw new AcpPromptProjectionError('acp_image_input_invalid', 'ACP prompt must contain text or an authorized image');
  }
  return Object.freeze(blocks);
}
