import type { JsonValue } from '@happier-dev/plugin-sdk';
import { AgentRuntimeJsonValueSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentExternalSessionTranscriptItem } from '@happier-dev/plugin-sdk/sessions/external';
import { createExternalSessionUnsupportedTranscriptItem } from '@happier-dev/plugin-sdk/sessions/file-stores';

import type { CodexRolloutAction } from './actions.js';
import { projectCodexRolloutActions, type CodexProjectedRolloutEvent } from './messages.js';

type CodexRolloutExternalMessageCandidate = Pick<
  AgentExternalSessionTranscriptItem,
  'id' | 'localId' | 'createdAtMs' | 'messageRole'
> & Readonly<{ createdAtMs: number; raw: AgentExternalSessionTranscriptItem['raw'] }>;

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

export function readCodexRolloutLineTimestampMs(value: unknown): number | null {
  const record = asRecord(value);
  const ts = typeof record?.timestamp === 'string' ? String(record.timestamp) : '';
  if (!ts.trim()) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) && ms >= 0 ? Math.trunc(ms) : null;
}

function stableOffsetId(prefix: string, offset: number, actionIndex: number): string {
  const padded = Math.max(0, Math.trunc(offset)).toString().padStart(12, '0');
  const idx = Math.max(0, Math.trunc(actionIndex)).toString().padStart(3, '0');
  return `${prefix}:${padded}:${idx}`;
}

/** Recognize only identities minted by this rollout projection, never paths supplied by a caller. */
export function isCodexRolloutTranscriptItemFromFile(itemId: string | undefined, fileRelPath: string): boolean {
  const prefix = `codex:${fileRelPath}`;
  if (!itemId?.startsWith(`${prefix}:`)) return false;
  const coordinates = /^(\d+):(\d+)$/.exec(itemId.slice(prefix.length + 1));
  if (!coordinates) return false;
  const offset = Number(coordinates[1]);
  const index = Number(coordinates[2]);
  return Number.isSafeInteger(offset) && Number.isSafeInteger(index)
    && stableOffsetId(prefix, offset, index) === itemId;
}

export function mapCodexRolloutLineToExternalMessages(params: Readonly<{
  fileRelPath: string;
  lineStartOffsetBytes: number;
  lineValue: unknown;
  actions: ReadonlyArray<CodexRolloutAction>;
  unsupportedRecord?: boolean;
  precedingTimestampMs?: number;
  sidechainId?: string | null;
}>): CodexRolloutExternalMessageCandidate[] {
  const createdAtMs = readCodexRolloutLineTimestampMs(params.lineValue)
    ?? (params.unsupportedRecord ? params.precedingTimestampMs : undefined) ?? 0;
  if (params.unsupportedRecord) {
    const id = stableOffsetId(`codex:${params.fileRelPath}`, params.lineStartOffsetBytes, 0);
    return [createExternalSessionUnsupportedTranscriptItem({ agentId: 'codex', id, localId: id, createdAtMs })];
  }
  // External transcript rendering should include "debug-only" tool calls (e.g., Codex-internal read/write tools),
  // but must still filter harness/system blobs that Codex sometimes embeds as user messages.
  const projected = projectCodexRolloutActions(
    params.actions,
    { sidechainId: params.sidechainId ?? null },
  );

  return mapCodexProjectedEventsToExternalMessages({ projected, createdAtMs,
    idForIndex: index => stableOffsetId(`codex:${params.fileRelPath}`, params.lineStartOffsetBytes, index) });
}

export function mapCodexProjectedEventsToExternalMessages(params: Readonly<{
  projected: readonly CodexProjectedRolloutEvent[];
  createdAtMs: number;
  idForIndex: (index: number) => string;
}>): CodexRolloutExternalMessageCandidate[] {
  const { projected, createdAtMs } = params;
  const out: CodexRolloutExternalMessageCandidate[] = [];
  for (let i = 0; i < projected.length; i++) {
    const action = projected[i]!;
    const stableId = params.idForIndex(i);

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

    // A Codex sub-agent is a real nested run, so it projects through the
    // transcript's ONE nested-run presentation: the canonical `SubAgent` tool
    // call whose tool id is the child thread id. The child rollout file's rows
    // carry `sidechainId = <thread id>`, and the host attaches a sidechain to
    // the parent tool call with the matching id — so keying the pair on
    // `threadId` is what makes the child transcript render under its spawn.
    if (action.type === 'subagent-spawn') {
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
              callId: action.threadId,
              name: 'SubAgent',
              input: {
                ...(action.prompt === null ? {} : { prompt: action.prompt }),
                ...(action.nickname === null ? {} : { nickname: action.nickname }),
                ...(action.role === null ? {} : { role: action.role }),
              },
              id: stableId,
            },
          },
        },
      });
      continue;
    }

    if (action.type === 'subagent-complete') {
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
              callId: action.threadId,
              output: {
                status: action.status,
                ...(action.summaryText === null ? {} : { summary: action.summaryText }),
              },
              id: stableId,
              ...(action.status === 'interrupted' ? { isError: true } : {}),
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
