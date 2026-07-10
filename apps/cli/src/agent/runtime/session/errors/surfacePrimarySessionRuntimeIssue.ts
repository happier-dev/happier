import { randomUUID } from 'node:crypto';

import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import { logger } from '@/ui/logger';
import type {
  PrimaryTurnStatusV1,
  RuntimeEventV1,
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

type RuntimeIssueTurnEvent = Extract<RuntimeEventV1, { kind: 'turn-failed' | 'turn-cancelled' }>;

type RuntimeIssueSession = Readonly<{
  sessionId?: string;
  sendAgentMessage?: (provider: ACPProvider, body: ACPMessageData) => void;
}>;

export type SurfacePrimarySessionRuntimeIssueInput = Omit<ClassifyPrimarySessionRuntimeIssueInput, 'cause'> & Readonly<{
  cause?: ClassifyPrimarySessionRuntimeIssueInput['cause'] | 'cancelled' | null;
  session?: RuntimeIssueSession | null;
  sessionTurnId?: string | null;
  emitAcpLifecycleMarker?: boolean;
  publishRuntimeEvent?: (event: RuntimeIssueTurnEvent) => void | Promise<void>;
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
): Pick<RuntimeEventV1, 'sessionId' | 'emittedAtMs'> & Readonly<{ turnId: string }> | null {
  const sessionId = normalizeProviderFact(input.session?.sessionId);
  const turnId = normalizeProviderFact(input.sessionTurnId);
  if (!sessionId || !turnId) return null;
  return {
    sessionId,
    emittedAtMs: normalizeNonNegativeTimestamp(input.occurredAt),
    turnId,
  };
}

async function publishRuntimeTurnEventBestEffort(
  input: SurfacePrimarySessionRuntimeIssueInput,
  event: RuntimeIssueTurnEvent | null,
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

function sendTurnLifecycleMessage(
  session: RuntimeIssueSession | null | undefined,
  provider: string | null | undefined,
  type: 'turn_failed' | 'turn_cancelled',
  agentTurnId: string | null | undefined,
): void {
  const normalizedProvider = normalizeProviderFact(provider) ?? 'agent';
  const id = normalizeProviderFact(agentTurnId) ?? randomUUID();
  session?.sendAgentMessage?.(
    normalizedProvider as ACPProvider,
    { type, id } as unknown as ACPMessageData,
  );
}

export { classifyPrimarySessionRuntimeIssue };

export async function surfacePrimarySessionRuntimeIssue(
  input: SurfacePrimarySessionRuntimeIssueInput,
): Promise<SessionRuntimeIssueV1 | null> {
  if (input.cause === 'cancelled') {
    if (input.emitAcpLifecycleMarker === true) {
      sendTurnLifecycleMessage(input.session, input.provider, 'turn_cancelled', input.agentTurnId);
    }
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
          reason: 'cancelled',
        } satisfies RuntimeIssueTurnEvent
      : null);
    return null;
  }

  const issue = classifyPrimarySessionRuntimeIssue(input as ClassifyPrimarySessionRuntimeIssueInput);
  if (input.emitAcpLifecycleMarker === true) {
    sendTurnLifecycleMessage(input.session, input.provider, 'turn_failed', issue.agentTurnId ?? input.agentTurnId);
  }
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
        issue,
      } satisfies RuntimeIssueTurnEvent
    : null);
  await input.recordIssue?.(record);
  return issue;
}
