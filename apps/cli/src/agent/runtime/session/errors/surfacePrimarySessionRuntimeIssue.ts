import { randomUUID } from 'node:crypto';

import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import { logger } from '@/ui/logger';
import type {
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
}>;

type RuntimeIssueSession = Readonly<{
  sendAgentMessage?: (provider: ACPProvider, body: ACPMessageData) => void;
  updatePrimaryTurnRuntimeState?: (record: PrimarySessionRuntimeIssueRecord) => void | Promise<void>;
}>;

export type SurfacePrimarySessionRuntimeIssueInput = Omit<ClassifyPrimarySessionRuntimeIssueInput, 'cause'> & Readonly<{
  cause?: ClassifyPrimarySessionRuntimeIssueInput['cause'] | 'cancelled' | null;
  session?: RuntimeIssueSession | null;
  recordIssue?: (record: PrimarySessionRuntimeIssueRecord) => void | Promise<void>;
}>;

function sendTurnLifecycleMessage(
  session: RuntimeIssueSession | null | undefined,
  provider: string | null | undefined,
  type: 'turn_failed' | 'turn_cancelled',
): void {
  const normalizedProvider = typeof provider === 'string' && provider.trim() ? provider.trim() : 'agent';
  session?.sendAgentMessage?.(
    normalizedProvider as ACPProvider,
    { type, id: randomUUID() } as unknown as ACPMessageData,
  );
}

async function updatePrimaryTurnRuntimeStateBestEffort(
  session: RuntimeIssueSession | null | undefined,
  record: PrimarySessionRuntimeIssueRecord,
): Promise<void> {
  try {
    await session?.updatePrimaryTurnRuntimeState?.(record);
  } catch (error) {
    logger.debug('[API] Failed to update primary turn runtime state (non-fatal)', {
      latestTurnStatus: record.latestTurnStatus,
      error,
    });
  }
}

export { classifyPrimarySessionRuntimeIssue };

export async function surfacePrimarySessionRuntimeIssue(
  input: SurfacePrimarySessionRuntimeIssueInput,
): Promise<SessionRuntimeIssueV1 | null> {
  if (input.cause === 'cancelled') {
    sendTurnLifecycleMessage(input.session, input.provider, 'turn_cancelled');
    await updatePrimaryTurnRuntimeStateBestEffort(input.session, {
      latestTurnStatus: 'cancelled',
      lastRuntimeIssue: null,
    });
    return null;
  }

  const issue = classifyPrimarySessionRuntimeIssue(input as ClassifyPrimarySessionRuntimeIssueInput);
  sendTurnLifecycleMessage(input.session, input.provider, 'turn_failed');
  const record = {
    latestTurnStatus: 'failed',
    lastRuntimeIssue: issue,
  } satisfies PrimarySessionRuntimeIssueRecord;
  await updatePrimaryTurnRuntimeStateBestEffort(input.session, record);
  await input.recordIssue?.(record);
  return issue;
}

export async function recordPrimaryTurnInProgress(
  input: Readonly<{ session?: RuntimeIssueSession | null }>,
): Promise<void> {
  await updatePrimaryTurnRuntimeStateBestEffort(input.session, {
    latestTurnStatus: 'in_progress',
  });
}

export async function recordPrimaryTurnCompleted(
  input: Readonly<{ session?: RuntimeIssueSession | null }>,
): Promise<void> {
  await updatePrimaryTurnRuntimeStateBestEffort(input.session, {
    latestTurnStatus: 'completed',
  });
}
