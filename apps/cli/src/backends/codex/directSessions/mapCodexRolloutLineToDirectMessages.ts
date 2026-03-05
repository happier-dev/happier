import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { mapCodexRolloutEventToActions } from '../localControl/rolloutMapper';

function shouldFilterHarnessBlob(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  // Known harness/system blobs embedded as user content (replay sessions, agent harness, etc).
  const patterns = [
    '# AGENTS.md instructions',
    '<environment_context>',
    '<turn_aborted>',
    '<INSTRUCTIONS>',
    'You are GPT-',
    'Codex CLI is an open source project',
  ];
  return patterns.some((p) => t.includes(p));
}

function extractEnvelopeTimestampMs(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  const ts = typeof (value as any).timestamp === 'string' ? String((value as any).timestamp) : '';
  if (!ts.trim()) return 0;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) && ms >= 0 ? Math.trunc(ms) : 0;
}

function stableOffsetId(prefix: string, offset: number, actionIndex: number): string {
  const padded = Math.max(0, Math.trunc(offset)).toString().padStart(12, '0');
  const idx = Math.max(0, Math.trunc(actionIndex)).toString().padStart(3, '0');
  return `${prefix}:${padded}:${idx}`;
}

export function mapCodexRolloutLineToDirectMessages(params: Readonly<{
  fileRelPath: string;
  lineStartOffsetBytes: number;
  lineValue: unknown;
}>): DirectTranscriptRawMessageV1[] {
  const createdAtMs = extractEnvelopeTimestampMs(params.lineValue);
  // Direct transcript rendering should include "debug-only" tool calls (e.g., Codex-internal read/write tools),
  // but must still filter harness/system blobs that Codex sometimes embeds as user messages.
  const actions = mapCodexRolloutEventToActions(params.lineValue, { debug: true });

  const out: DirectTranscriptRawMessageV1[] = [];
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    const idPrefix = `codex:${params.fileRelPath}`;
    const stableId = stableOffsetId(idPrefix, params.lineStartOffsetBytes, i);

    if (action.type === 'user-text') {
      if (shouldFilterHarnessBlob(action.text)) continue;
      out.push({
        id: stableId,
        localId: stableId,
        createdAtMs,
        raw: {
          role: 'user',
          content: { type: 'text', text: action.text },
        },
      });
      continue;
    }

    if (action.type === 'assistant-text') {
      out.push({
        id: stableId,
        localId: stableId,
        createdAtMs,
        raw: {
          role: 'agent',
          content: {
            type: 'codex',
            data: { type: 'message', message: action.text },
          },
        },
      });
      continue;
    }

    if (action.type === 'tool-call') {
      out.push({
        id: stableId,
        localId: stableId,
        createdAtMs,
        raw: {
          role: 'agent',
          content: {
            type: 'codex',
            data: {
              type: 'tool-call',
              callId: action.callId,
              name: action.name,
              input: action.input,
              id: stableId,
            },
          },
        },
      });
      continue;
    }

    if (action.type === 'tool-result') {
      out.push({
        id: stableId,
        localId: stableId,
        createdAtMs,
        raw: {
          role: 'agent',
          content: {
            type: 'codex',
            data: {
              type: 'tool-call-result',
              callId: action.callId,
              output: action.output,
              id: stableId,
            },
          },
        },
      });
      continue;
    }
  }

  return out;
}

