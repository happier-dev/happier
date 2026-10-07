import {
  HappierStructuredInputV1Schema,
  readStructuredInputMentionSourcesV1,
} from '@happier-dev/plugin-sdk/sessions';
import type { AgentSessionInputFilesService } from '@happier-dev/plugin-sdk/agents/runtime';

export type OpenCodePromptPart =
  | Readonly<{ type: 'text'; text: string; synthetic?: boolean }>
  | Readonly<{ type: 'skill'; id?: string; name: string; path?: string; text: string }>
  | Readonly<{ type: 'agent'; name: string }>
  | Readonly<{ type: 'file'; mime: string; filename?: string; url: string }>;

export class OpenCodePromptProjectionError extends Error {
  constructor(
    readonly code:
      | 'opencode_structured_input_invalid'
      | 'opencode_image_input_untrusted'
      | 'opencode_image_input_unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'OpenCodePromptProjectionError';
  }
}

export function buildOpenCodePromptParts(params: Readonly<{
  text: string;
  structuredInput?: unknown;
  inputFiles?: AgentSessionInputFilesService;
  signal?: AbortSignal;
}>): readonly OpenCodePromptPart[] | Promise<readonly OpenCodePromptPart[]> {
  const structured = params.structuredInput === undefined
    ? null
    : HappierStructuredInputV1Schema.safeParse(params.structuredInput);
  if (structured && !structured.success) {
    throw new OpenCodePromptProjectionError(
      'opencode_structured_input_invalid',
      'OpenCode structured input did not match the supported contract',
    );
  }

  const images = structured?.data.imageInputs ?? [];
  if (images.some((image) => image.kind !== 'localImage')) {
    throw new OpenCodePromptProjectionError(
      'opencode_image_input_untrusted',
      'OpenCode server mode does not accept remote image references',
    );
  }
  if (images.length > 0 && !params.inputFiles) {
    throw new OpenCodePromptProjectionError(
      'opencode_image_input_unsupported',
      'OpenCode server mode cannot consume verified image uploads safely',
    );
  }

  // D-4: when the envelope carries `mentions[]` it is the authoritative reference
  // enumeration and the legacy per-kind arrays are ignored, so a dual-written envelope
  // cannot emit a second part for the same reference.
  const mentionSources = readStructuredInputMentionSourcesV1(structured?.data ?? null);

  const parts: OpenCodePromptPart[] = [];
  if (params.text.length > 0) parts.push({ type: 'text', text: params.text });
  const finishProjection = (): readonly OpenCodePromptPart[] => {
    for (const mention of mentionSources.vendorPluginMentions) {
      parts.push({ type: 'agent', name: mention.vendorPluginRef });
    }
    for (const skill of mentionSources.skillMentions) {
      parts.push({
        type: 'skill',
        ...(skill.id && skill.idSource !== 'generated' ? { id: skill.id } : {}),
        name: skill.name,
        ...(skill.path ? { path: skill.path } : {}),
        text: `Use the ${skill.name} skill for this request.`,
      });
    }
    if (parts.length === 0) {
      throw new OpenCodePromptProjectionError(
        'opencode_structured_input_invalid',
        'OpenCode input requires text or supported structured content',
      );
    }
    return Object.freeze(parts);
  };
  if (images.length === 0) return finishProjection();
  return (async () => {
    for (const image of images) {
      const verified = await params.inputFiles!.readVerifiedImage(
        image,
        params.signal ? { signal: params.signal } : undefined,
      );
      if (!verified) {
        throw new OpenCodePromptProjectionError(
          'opencode_image_input_untrusted',
          'OpenCode image upload could not be verified',
        );
      }
      parts.push({
        type: 'file',
        mime: verified.mimeType,
        ...(verified.filename ? { filename: verified.filename } : {}),
        url: verified.url,
      });
    }
    return finishProjection();
  })();
}
