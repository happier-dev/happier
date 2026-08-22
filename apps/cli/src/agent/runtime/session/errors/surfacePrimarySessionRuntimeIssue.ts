import { randomUUID } from 'node:crypto';

import type { AcpSendFn } from '@/agent/acp/bridge/acpSessionForwarding';
import { logger } from '@/ui/logger';
import type {
  AgentSessionRuntimeEvent,
  PrimaryTurnStatusV1,
  SessionRuntimeIssueV1,
} from '@happier-dev/protocol';

import {
  classifyPrimarySessionRuntimeIssue,
  type ClassifyPrimarySessionRuntimeIssueInput,
} from './classifyPrimarySessionRuntimeIssue';

type PrimarySessionRuntimeIssueRecord = Readonly<{
  latestTurnStatus: PrimaryTurnStatusV1;
  lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
  provider?: string;
  agentTurnId?: string | null;
}>;

type RuntimeIssueTurnEvent = Extract<AgentSessionRuntimeEvent, { kind: 'turn-failed' | 'turn-cancelled' }>;
type RuntimeIssueTurnEventDraft = RuntimeIssueTurnEvent extends infer Event
  ? Event extends RuntimeIssueTurnEvent
    ? Omit<Event, 'sequence' | 'sessionId' | 'emittedAtMs'>
    : never
  : never;

type RuntimeIssueSession = Readonly<{
  sessionId?: string;
}>;

export type SurfacePrimarySessionRuntimeIssueInput = Omit<ClassifyPrimarySessionRuntimeIssueInput, 'cause'> & Readonly<{
  cause?: ClassifyPrimarySessionRuntimeIssueInput['cause'] | 'cancelled' | null;
  session?: RuntimeIssueSession | null;
  sessionTurnId?: string | null;
  publishTranscriptAgentMessageCommitted?: AcpSendFn;
  publishRuntimeEvent?: (event: RuntimeIssueTurnEventDraft) => void | Promise<void>;
  recordIssue?: (record: PrimarySessionRuntimeIssueRecord) => void | Promise<void>;
}>;

function normalizeProviderFact(value: string | null | undefined): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : undefined;
}

function buildProviderRuntimeFacts(
  input: Readonly<{ provider?: string | null; agentTurnId?: string | null }>,
): Pick<PrimarySessionRuntimeIssueRecord, 'provider' | 'agentTurnId'> {
  const provider = normalizeProviderFact(input.provider);
  const agentTurnId = normalizeProviderFact(input.agentTurnId);
  return {
    ...(provider ? { provider } : {}),
    ...(agentTurnId ? { agentTurnId } : {}),
  };
}

function normalizeNonNegativeTimestamp(value: number | null | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    if (normalized >= 0) return normalized;
  }
  return Date.now();
}

function buildRuntimeEventBase(
  input: SurfacePrimarySessionRuntimeIssueInput,
): Readonly<{ turnId: string }> | null {
  const turnId = normalizeProviderFact(input.sessionTurnId);
  return turnId ? { turnId } : null;
}

async function publishRuntimeTurnEventBestEffort(
  input: SurfacePrimarySessionRuntimeIssueInput,
  event: RuntimeIssueTurnEventDraft | null,
): Promise<void> {
  if (!event || !input.publishRuntimeEvent) return;
  try {
    await input.publishRuntimeEvent(event);
  } catch (error) {
    logger.debug('[API] Failed to publish runtime turn event (non-fatal)', {
      kind: event.kind,
      error,
    });
  }
}

function publishTurnLifecycleMessage(
  publish: AcpSendFn | null | undefined,
  provider: string | null | undefined,
  type: 'turn_failed' | 'turn_cancelled',
  agentTurnId: string | null | undefined,
): void {
  const normalizedProvider = normalizeProviderFact(provider) ?? 'agent';
  const id = normalizeProviderFact(agentTurnId) ?? randomUUID();
  publish?.(normalizedProvider, { type, id }, { localId: `${id}:${type}` });
}

export { classifyPrimarySessionRuntimeIssue };

export async function surfacePrimarySessionRuntimeIssue(
  input: SurfacePrimarySessionRuntimeIssueInput,
): Promise<SessionRuntimeIssueV1 | null> {
  if (input.cause === 'cancelled') {
    publishTurnLifecycleMessage(
      input.publishTranscriptAgentMessageCommitted,
      input.provider,
      'turn_cancelled',
      input.agentTurnId,
    );
    const record = {
      ...buildProviderRuntimeFacts(input),
      latestTurnStatus: 'cancelled',
      lastRuntimeIssue: null,
    } satisfies PrimarySessionRuntimeIssueRecord;
    const runtimeEventBase = buildRuntimeEventBase(input);
    await publishRuntimeTurnEventBestEffort(input, runtimeEventBase
      ? {
          ...runtimeEventBase,
          kind: 'turn-cancelled',
          ...(record.agentTurnId ? { agentTurnId: record.agentTurnId } : {}),
          cause: 'providerCancelled',
        } satisfies RuntimeIssueTurnEventDraft
      : null);
    return null;
  }

  const issue = classifyPrimarySessionRuntimeIssue(input as ClassifyPrimarySessionRuntimeIssueInput);
  publishTurnLifecycleMessage(
    input.publishTranscriptAgentMessageCommitted,
    input.provider,
    'turn_failed',
    issue.agentTurnId ?? input.agentTurnId,
  );
  const record = {
    ...buildProviderRuntimeFacts({
      provider: issue.agentId ?? input.provider,
      agentTurnId: issue.agentTurnId ?? input.agentTurnId,
    }),
    latestTurnStatus: 'failed',
    lastRuntimeIssue: issue,
  } satisfies PrimarySessionRuntimeIssueRecord;
  const runtimeEventBase = buildRuntimeEventBase(input);
  await publishRuntimeTurnEventBestEffort(input, runtimeEventBase
    ? {
        ...runtimeEventBase,
        kind: 'turn-failed',
        ...(record.agentTurnId ? { agentTurnId: record.agentTurnId } : {}),
        diagnostic: {
          code: issue.code,
          severity: 'error',
          ...(issue.sanitizedPreview ? { message: issue.sanitizedPreview } : {}),
          details: {
            v: 1,
            source: issue.source,
            occurredAt: normalizeNonNegativeTimestamp(issue.occurredAt),
            ...(issue.agentId ? { agentId: issue.agentId } : {}),
            ...(issue.agentTurnId ? { agentTurnId: issue.agentTurnId } : {}),
          },
        },
      } satisfies RuntimeIssueTurnEventDraft
    : null);
  await input.recordIssue?.(record);
  return issue;
}
