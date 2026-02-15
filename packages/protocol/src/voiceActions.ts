import { z } from 'zod';
import { listVoiceActionBlockSpecs } from './actions/actionSpecs.js';

export const VOICE_ACTIONS_BLOCK = {
  startTag: '<voice_actions>',
  endTag: '</voice_actions>',
} as const;

function buildVoiceAssistantActionSchema(): z.ZodTypeAny {
  // Centralized: the action block schema is derived from Action Specs.
  // Each spec that opts into surface.voice_action_block must bind a stable voiceClientToolName and inputSchema.
  const voiceActionBlockOptions = listVoiceActionBlockSpecs().flatMap((spec) => {
    const toolName = spec.bindings?.voiceClientToolName;
    if (!toolName) return [];
    return [
      z.object({
        t: z.literal(toolName),
        args: spec.inputSchema,
      }),
    ];
  });

  return z.discriminatedUnion('t', voiceActionBlockOptions as any);
}

let memoizedVoiceAssistantActionSchema: z.ZodTypeAny | undefined;
function getVoiceAssistantActionSchema(): z.ZodTypeAny {
  if (!memoizedVoiceAssistantActionSchema) {
    memoizedVoiceAssistantActionSchema = buildVoiceAssistantActionSchema();
  }
  return memoizedVoiceAssistantActionSchema;
}

export const VoiceAssistantActionSchema = z.lazy(() => getVoiceAssistantActionSchema());

export type VoiceAssistantAction = z.infer<typeof VoiceAssistantActionSchema>;

const VoiceAssistantActionsEnvelopeSchema = z.object({
  actions: z.array(VoiceAssistantActionSchema).default([]),
});

export function extractVoiceActionsFromAssistantText(
  assistantTextRaw: string,
): Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }> {
  const assistantText = String(assistantTextRaw ?? '');

  const startIndex = assistantText.lastIndexOf(VOICE_ACTIONS_BLOCK.startTag);
  if (startIndex < 0) return { assistantText: assistantText.trim(), actions: [] };

  const endIndex = assistantText.indexOf(VOICE_ACTIONS_BLOCK.endTag, startIndex);
  if (endIndex < 0) return { assistantText: assistantText.trim(), actions: [] };

  const jsonRaw = assistantText
    .slice(startIndex + VOICE_ACTIONS_BLOCK.startTag.length, endIndex)
    .trim();

  try {
    const parsedJson = JSON.parse(jsonRaw) as unknown;
    const parsed = VoiceAssistantActionsEnvelopeSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return { assistantText: assistantText.trim(), actions: [] };
    }

    const stripped = `${assistantText.slice(0, startIndex)}${assistantText.slice(endIndex + VOICE_ACTIONS_BLOCK.endTag.length)}`;
    return { assistantText: stripped.trim(), actions: parsed.data.actions };
  } catch {
    return { assistantText: assistantText.trim(), actions: [] };
  }
}
