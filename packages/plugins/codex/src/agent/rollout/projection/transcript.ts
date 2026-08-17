import type { JsonValue } from '@happier-dev/plugin-sdk';
import { AgentRuntimeJsonValueSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentExternalSessionTranscriptItem } from '@happier-dev/plugin-sdk/sessions/external';

import type { CodexRolloutAction } from './actions.js';
import { projectCodexRolloutActions } from './messages.js';

type CodexRolloutExternalMessageCandidate = Pick<
  AgentExternalSessionTranscriptItem,
  'id' | 'localId' | 'createdAtMs' | 'messageRole'
> & Readonly<{ raw: AgentExternalSessionTranscriptItem['raw'] }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function projectJsonValue(value: unknown): JsonValue {
  const parsed = AgentRuntimeJsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

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
  const record = asRecord(value);
  const ts = typeof record?.timestamp === 'string' ? String(record.timestamp) : '';
  if (!ts.trim()) return 0;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) && ms >= 0 ? Math.trunc(ms) : 0;
}

function stableOffsetId(prefix: string, offset: number, actionIndex: number): string {
  const padded = Math.max(0, Math.trunc(offset)).toString().padStart(12, '0');
  const idx = Math.max(0, Math.trunc(actionIndex)).toString().padStart(3, '0');
  return `${prefix}:${padded}:${idx}`;
}

export function mapCodexRolloutLineToExternalMessages(params: Readonly<{
  fileRelPath: string;
  lineStartOffsetBytes: number;
  lineValue: unknown;
  actions: ReadonlyArray<CodexRolloutAction>;
  sidechainId?: string | null;
}>): CodexRolloutExternalMessageCandidate[] {
  const createdAtMs = extractEnvelopeTimestampMs(params.lineValue);
  // External transcript rendering should include "debug-only" tool calls (e.g., Codex-internal read/write tools),
  // but must still filter harness/system blobs that Codex sometimes embeds as user messages.
  const projected = projectCodexRolloutActions(
    params.actions,
    { sidechainId: params.sidechainId ?? null },
  );

  const out: CodexRolloutExternalMessageCandidate[] = [];
  for (let i = 0; i < projected.length; i++) {
    const action = projected[i]!;
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
            data: {
              type: 'message',
              message: action.text,
              ...(action.sidechainId ? { sidechainId: action.sidechainId } : {}),
            },
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
              input: projectJsonValue(action.input),
              id: stableId,
              ...(action.sidechainId ? { sidechainId: action.sidechainId } : {}),
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
              output: projectJsonValue(action.output),
              id: stableId,
              ...(action.sidechainId ? { sidechainId: action.sidechainId } : {}),
              ...(action.isError === undefined ? {} : { isError: action.isError }),
            },
          },
        },
      });
      continue;
    }
  }

  return out;
}
