import { z } from 'zod';

export const VOICE_ACTIONS_BLOCK = {
  startTag: '<voice_actions>',
  endTag: '</voice_actions>',
} as const;

export const VoiceAssistantActionSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('messageClaudeCode'),
    args: z.object({
      message: z.string().min(1),
    }),
  }),
  z.object({
    t: z.literal('processPermissionRequest'),
    args: z.object({
      decision: z.enum(['allow', 'deny']),
      requestId: z.string().min(1).optional(),
    }),
  }),
]);

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

