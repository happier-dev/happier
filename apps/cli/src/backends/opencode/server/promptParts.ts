import path from 'node:path';

import {
  HappierStructuredInputV1EnvelopeSchema,
  readHappierStructuredInputV1FromMeta,
  readStructuredInputMentionSourcesV1,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import { readTrustedSessionAttachmentLocalImages } from '@/session/attachments/resolveTrustedSessionAttachmentLocalImagePaths';
import {
  normalizeSessionMediaMimeType,
  sniffSessionMediaMimeType,
} from '@/session/sessionMedia/sessionMediaMime';

type UnknownRecord = Record<string, unknown>;

export type OpenCodePromptPart =
  | Readonly<{ type: 'text'; text: string; synthetic?: boolean }>
  | Readonly<{ type: 'agent'; name: string }>
  | Readonly<{ type: 'skill'; id?: string; name: string; path?: string; text: string }>
  | Readonly<{ type: 'file'; mime: string; filename?: string; url: string }>;

export class OpenCodePromptProjectionError extends Error {
  constructor(
    readonly code:
      | 'opencode_structured_input_invalid'
      | 'opencode_image_input_untrusted'
      | 'opencode_image_input_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'OpenCodePromptProjectionError';
  }
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function asRecordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((entry): entry is UnknownRecord => entry !== null)
    : [];
}

function readNonBlankString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeUploadPath(value: unknown): string | null {
  const uploadPath = readNonBlankString(value);
  return uploadPath ? uploadPath.replace(/[\\]+/gu, '/') : null;
}

export function buildOpenCodePromptParts(params: Readonly<{
  cwd: string;
  text: string;
  metadata?: unknown;
}>): readonly OpenCodePromptPart[] | Promise<readonly OpenCodePromptPart[]> {
  const metadata = asRecord(params.metadata);
  const rawStructuredInput = metadata?.happierStructuredInputV1;
  const structured = rawStructuredInput === undefined
    ? null
    : HappierStructuredInputV1EnvelopeSchema.safeParse(rawStructuredInput);
  if (structured && !structured.success) {
    throw new OpenCodePromptProjectionError(
      'opencode_structured_input_invalid',
      'OpenCode structured input did not match the supported contract',
    );
  }

  const imageInputs = structured?.data.imageInputs?.length
    ? asRecordArray(structured.data.imageInputs)
    : asRecordArray(structured?.data.attachments);
  const parts: OpenCodePromptPart[] = [];
  if (params.text.length > 0) parts.push({ type: 'text', text: params.text });
  const mentionSources = readStructuredInputMentionSourcesV1(readHappierStructuredInputV1FromMeta(metadata));
  const finishProjection = (): readonly OpenCodePromptPart[] => {
    for (const mention of mentionSources.vendorPluginMentions) {
      const name = readNonBlankString(mention.vendorPluginRef);
      if (name) parts.push({ type: 'agent', name });
    }
    for (const skill of mentionSources.skillMentions) {
      const name = readNonBlankString(skill.name ?? skill.displayName);
      if (name) {
        const id = skill.idSource === 'generated' ? null : readNonBlankOpaqueIdentifier(skill.id);
        const skillPath = readNonBlankString(skill.path);
        parts.push({
          type: 'skill',
          name,
          ...(id ? { id } : {}),
          ...(skillPath ? { path: skillPath } : {}),
          text: `Use the ${name} skill for this request.`,
        });
      }
    }
    return Object.freeze(parts);
  };
  if (imageInputs.length === 0) return finishProjection();

  return (async () => {
    const trustedImages = await readTrustedSessionAttachmentLocalImages({
      cwd: params.cwd,
      metadata,
      maxBytes: configuration.filesImageReadMaxBytes,
    });
    const emittedPaths = new Set<string>();
    for (const image of imageInputs) {
      const uploadPath = normalizeUploadPath(image.path ?? image.localPath);
      if (!uploadPath) {
        throw new OpenCodePromptProjectionError(
          'opencode_image_input_untrusted',
          'OpenCode server mode does not accept remote image references',
        );
      }
      if (emittedPaths.has(uploadPath)) continue;
      emittedPaths.add(uploadPath);
      const bytes = trustedImages.get(uploadPath);
      if (!bytes) {
        throw new OpenCodePromptProjectionError(
          'opencode_image_input_untrusted',
          'OpenCode image upload could not be verified',
        );
      }
      const mime = sniffSessionMediaMimeType(bytes);
      if (!mime?.startsWith('image/')) {
        throw new OpenCodePromptProjectionError(
          'opencode_image_input_invalid',
          'OpenCode image upload has an unsupported MIME type',
        );
      }
      const declaredMime = normalizeSessionMediaMimeType(image.mimeType);
      if (image.mimeType !== undefined && declaredMime !== mime) {
        throw new OpenCodePromptProjectionError(
          'opencode_image_input_invalid',
          'OpenCode image upload MIME type does not match its content',
        );
      }
      parts.push({
        type: 'file',
        mime,
        filename: path.posix.basename(uploadPath),
        url: `data:${mime};base64,${bytes.toString('base64')}`,
      });
    }
    return finishProjection();
  })();
}
