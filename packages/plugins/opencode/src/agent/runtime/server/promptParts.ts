import {
  HappierStructuredInputV1Schema,
  readStructuredInputMentionSourcesV1,
} from '@happier-dev/plugin-sdk/sessions';

export type OpenCodePromptPart =
  | Readonly<{ type: 'text'; text: string }>
  | Readonly<{ type: 'agent'; name: string }>;

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
}>): readonly OpenCodePromptPart[] {
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
  if (images.length > 0) {
    // The public AgentRuntime context does not expose the host's trusted-upload byte resolver.
    // Passing the path to OpenCode would bypass digest/size/MIME verification, so server mode
    // must stay unavailable until it can consume the canonical media projection seam.
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
  for (const mention of mentionSources.vendorPluginMentions) {
    parts.push({ type: 'agent', name: mention.vendorPluginRef });
  }
  for (const skill of mentionSources.skillMentions) {
    parts.push({
      type: 'text',
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
}
