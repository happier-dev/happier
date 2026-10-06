import type { ContentBlock } from '@agentclientprotocol/sdk';
import { HappierStructuredInputV1Schema } from '@happier-dev/protocol/runtime/input/structuredInputV1';

import { configuration } from '@/configuration';
import { verifySessionStructuredImageInput } from '@/session/attachments/resolveTrustedSessionAttachmentLocalImagePaths';

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

async function readTrustedLocalImage(params: Readonly<{
  cwd: string;
  sessionId?: string;
  image: Record<string, unknown>;
}>): Promise<Extract<ContentBlock, { type: 'image' }>> {
  const verification = await verifySessionStructuredImageInput({
    cwd: params.cwd,
    sessionId: params.sessionId,
    image: params.image,
    maxBytes: configuration.filesUploadMaxFileBytes,
  });
  if (verification.status === 'untrusted') {
    throw new AcpPromptProjectionError('acp_image_input_untrusted', 'ACP image upload could not be verified');
  }
  if (verification.status === 'invalid') {
    throw new AcpPromptProjectionError('acp_image_input_invalid', 'ACP image upload has an unsupported MIME type');
  }
  return {
    type: 'image',
    data: verification.bytes.toString('base64'),
    mimeType: verification.mimeType,
  };
}

export async function buildAcpPromptContentBlocks(params: Readonly<{
  cwd: string;
  sessionId?: string;
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
  if (images.length > 0 && !params.acceptsImageInput) {
    throw new AcpPromptProjectionError('acp_image_input_unsupported', 'ACP provider does not advertise image prompt support');
  }
  const blocks: ContentBlock[] = [];
  if (params.text.length > 0) blocks.push({ type: 'text', text: params.text });
  for (const image of images) {
    if (image.kind !== 'localImage') {
      throw new AcpPromptProjectionError('acp_image_input_untrusted', 'ACP remote image references are not trusted prompt inputs');
    }
    blocks.push(await readTrustedLocalImage({ cwd: params.cwd, sessionId: params.sessionId, image }));
  }
  if (blocks.length === 0) {
    throw new AcpPromptProjectionError('acp_image_input_invalid', 'ACP prompt must contain text or an authorized image');
  }
  return Object.freeze(blocks);
}
