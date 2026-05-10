import { summarizeExternalSessionTitleText } from './summarizeExternalSessionTitleText';

const BOILERPLATE_PATTERNS = [
  '# session title',
  'at the start of the session',
  'change_title tool',
  'happier voice is a voice interface',
  'core behavior:',
  '<environment_context>',
  '<instructions>',
  '<turn_aborted>',
  '# agents.md instructions',
] as const;

export function readExternalSessionTitleCandidate(value: string): string | null {
  const title = summarizeExternalSessionTitleText(value);
  if (!title) return null;

  const normalized = title.toLowerCase();
  if (BOILERPLATE_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return null;
  }

  return title;
}
