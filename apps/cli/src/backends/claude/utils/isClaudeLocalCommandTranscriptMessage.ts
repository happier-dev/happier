import type { RawJSONLines } from '../types';
import { readClaudeControlCommandRowShape } from './controlCommandRows';

function firstClaudeMessageText(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = (value as Record<string, unknown>).message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const text = record.text ?? record.content;
    if (typeof text === 'string') return text;
  }
  return null;
}

export function isClaudeLocalCommandTranscriptMessage(message: RawJSONLines): boolean {
  if (message.type !== 'user') return false;
  const shape = readClaudeControlCommandRowShape(message);
  if (shape?.kind === 'shell_command' || shape?.kind === 'shell_output') return false;
  if (shape !== null) return true;
  const text = firstClaudeMessageText(message);
  if (!text) return false;
  const trimmed = text.trim();
  return trimmed.startsWith('<local-command-caveat>');
}
