import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { z } from 'zod/mini';

import { SCM_COMMIT_MESSAGE_MAX_LENGTH } from '@happier-dev/protocol/scm';

import { parseTrailingJsonObject } from '@/agent/executionRuns/profiles/shared/parseTrailingJsonObject';

const ModelOutputSchema = lazyZodSchema(() => z.looseObject({
  title: z.string().check(z.minLength(1), z.maxLength(200)),
  body: z.optional(z.string().check(z.maxLength(20_000))),
  message: z.optional(z.string().check(z.maxLength(SCM_COMMIT_MESSAGE_MAX_LENGTH))),
  confidence: z.optional(z.number().check(z.minimum(0), z.maximum(1))),
}));

export type CommitMessageModelOutput = z.infer<typeof ModelOutputSchema>;

function clamp(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + '…';
}

export function parseCommitMessageModelOutput(rawText: string): CommitMessageModelOutput | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  // The shared Run-output reader tolerates the prose or code fence a model puts around its JSON.
  const parsed = parseTrailingJsonObject(trimmed);

  const result = ModelOutputSchema.safeParse(parsed);
  if (!result.success) {
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
