import type { ActionSpec } from './actionSpecs.js';

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function describeActionForVoiceTool(spec: Pick<ActionSpec, 'title' | 'description' | 'inputHints'>): string {
  return (
    normalizeText(spec.inputHints?.description) ??
    normalizeText(spec.description) ??
    normalizeText(spec.inputHints?.title) ??
    normalizeText(spec.title) ??
    'Voice action'
  );
}
