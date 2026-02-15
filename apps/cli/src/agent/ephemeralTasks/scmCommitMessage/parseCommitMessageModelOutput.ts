import { z } from 'zod';

import { SCM_COMMIT_MESSAGE_MAX_LENGTH } from '@happier-dev/protocol';

const ModelOutputSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(20_000).optional(),
  message: z.string().max(SCM_COMMIT_MESSAGE_MAX_LENGTH).optional(),
  confidence: z.number().min(0).max(1).optional(),
}).passthrough();

export type CommitMessageModelOutput = z.infer<typeof ModelOutputSchema>;

function clamp(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + '…';
}

export function parseCommitMessageModelOutput(rawText: string): CommitMessageModelOutput | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = null;
  }

  const result = ModelOutputSchema.safeParse(parsed);
  if (!result.success) {
    // Fallback: interpret plain text as title + body.
    const lines = trimmed.split('\n');
    const title = clamp(lines[0] ?? 'Commit', 200).trim() || 'Commit';
    const body = lines.slice(1).join('\n').trim();
    const message = clamp(body ? `${title}\n\n${body}` : title, SCM_COMMIT_MESSAGE_MAX_LENGTH);
    return { title, body, message };
  }

  const body = typeof result.data.body === 'string' ? result.data.body.trim() : '';
  const message = typeof result.data.message === 'string'
    ? result.data.message.trim()
    : (body ? `${result.data.title}\n\n${body}` : result.data.title);

  return {
    ...result.data,
    body,
    message: clamp(message, SCM_COMMIT_MESSAGE_MAX_LENGTH),
    title: clamp(result.data.title.trim(), 200),
  };
}

