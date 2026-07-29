import { applyDisplayTitleSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';

import type { Metadata } from '@/api/types';

const INITIAL_PROMPT_TITLE_MAX_CHARS = 80;

function readExistingDisplayTitle(metadata: Metadata): string | null {
  const summary = (metadata as { summary?: unknown }).summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const text = (summary as { text?: unknown }).text;
  return typeof text === 'string' && text.trim().length > 0 ? text.trim() : null;
}

function truncateTitleSeed(value: string): string {
  if (value.length <= INITIAL_PROMPT_TITLE_MAX_CHARS) return value;
  const slice = value.slice(0, INITIAL_PROMPT_TITLE_MAX_CHARS).trimEnd();
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace >= Math.floor(INITIAL_PROMPT_TITLE_MAX_CHARS * 0.6)) {
    return slice.slice(0, lastSpace).trimEnd();
  }
  return slice;
}

export function deriveInitialPromptTitleSeed(value: unknown): string | null {
  const prompt = typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  if (!prompt) return null;
  const firstLine = prompt
    .split(/\r?\n/g)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;
  return truncateTitleSeed(firstLine);
}

export function applyInitialPromptTitleSeedToMetadata<TMetadata extends Metadata>(
  metadata: TMetadata,
  titleSeed: string | null,
): TMetadata {
  if (!titleSeed || readExistingDisplayTitle(metadata)) return metadata;
  return applyDisplayTitleSessionMetadata(metadata, {
    title: titleSeed,
    staleBehavior: 'bump-if-value-changed',
  });
}
