import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ToolNormalizationProtocol } from '@happier-dev/protocol';

export type ToolTraceEventV1 = {
  v: 1;
  protocol: 'acp' | 'codex' | 'claude' | string;
  provider: string;
  kind: string;
  payload: unknown;
};

export type ToolTraceFixturesV1 = {
  v: 1;
  generatedAt: number;
  examples: Record<string, ToolTraceEventV1[]>;
};

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asToolNormalizationProtocol(protocol: string): ToolNormalizationProtocol {
  if (protocol === 'codex' || protocol === 'claude') return protocol;
  return 'acp';
}

export function loadFixtureV1(): ToolTraceFixturesV1 {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixturePath = path.join(here, '__fixtures__', 'tool-trace-fixtures.v1.json');
  const raw = readFileSync(fixturePath, 'utf8');
  return JSON.parse(raw) as ToolTraceFixturesV1;
}

export function getCallIdFromEvent(event: ToolTraceEventV1): string | null {
  const payload = asRecord(event.payload) ?? {};
  const callId = payload.callId;
  if (typeof callId === 'string') return callId;
  const permissionId = payload.permissionId;
  if (typeof permissionId === 'string') return permissionId;
  return null;
}

export function firstFixtureEvent(fixtures: ToolTraceFixturesV1, key: string): ToolTraceEventV1 | null {
  return fixtures.examples[key]?.[0] ?? null;
}
