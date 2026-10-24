import { randomUUID } from 'node:crypto';

import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { FailTurnInput, SessionTurnLifecycle } from '@/agent/runtime/session/turn/types';
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
  provider?: string;
  providerTurnId?: string | null;
}>;

type RuntimeIssueSession = Readonly<{
  sendAgentMessage?: (provider: ACPProvider, body: ACPMessageData) => void;
  sessionTurnLifecycle?: SessionTurnLifecycle;
}>;

export type SurfacePrimarySessionRuntimeIssueInput = Omit<ClassifyPrimarySessionRuntimeIssueInput, 'cause'> & Readonly<{
  cause?: ClassifyPrimarySessionRuntimeIssueInput['cause'] | 'cancelled' | null;
  session?: RuntimeIssueSession | null;
  recordIssue?: (record: PrimarySessionRuntimeIssueRecord) => void | Promise<void>;
  /**
   * Session-scoped issues (host death, readiness timeout) may occur with no
   * active turn; opting in allocates and fails a session-owned turn so the
   * issue is surfaced instead of becoming a silent no-op.
   */
  allocateTurnWhenIdle?: boolean;
  suppressUntrustedDuplicate?: FailTurnInput['suppressUntrustedDuplicate'];
  onFailureTurn?: FailTurnInput['onFailureTurn'];
}>;

function normalizeProviderFact(value: string | null | undefined): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : undefined;
}

function buildProviderRuntimeFacts(
  input: Readonly<{ provider?: string | null; providerTurnId?: string | null }>,
): Pick<PrimarySessionRuntimeIssueRecord, 'provider' | 'providerTurnId'> {
  const provider = normalizeProviderFact(input.provider);
  const providerTurnId = normalizeProviderFact(input.providerTurnId);
  return {
    ...(provider ? { provider } : {}),
    ...(providerTurnId ? { providerTurnId } : {}),
  };
}

function sendTurnLifecycleMessage(
  session: RuntimeIssueSession | null | undefined,
  provider: string | null | undefined,
  type: 'turn_failed' | 'turn_cancelled',
  providerTurnId: string | null | undefined,
  issue?: SessionRuntimeIssueV1 | null,
): void {
  const normalizedProvider = typeof provider === 'string' && provider.trim() ? provider.trim() : 'agent';
  const id = normalizeProviderFact(providerTurnId) ?? randomUUID();
  session?.sendAgentMessage?.(
    normalizedProvider as ACPProvider,
    {
      type,
      id,
      ...(type === 'turn_failed' && issue ? { issue } : {}),
    } as unknown as ACPMessageData,
  );
}

export { classifyPrimarySessionRuntimeIssue };

export async function surfacePrimarySessionRuntimeIssue(
  input: SurfacePrimarySessionRuntimeIssueInput,
): Promise<SessionRuntimeIssueV1 | null> {
  if (input.cause === 'cancelled') {
    if (input.session?.sessionTurnLifecycle) {
      await input.session.sessionTurnLifecycle.cancelTurn(buildProviderRuntimeFacts(input));
      return null;
    }
    sendTurnLifecycleMessage(input.session, input.provider, 'turn_cancelled', input.providerTurnId);
    return null;
  }

  let issue = classifyPrimarySessionRuntimeIssue(input as ClassifyPrimarySessionRuntimeIssueInput);
  const record = {
    ...buildProviderRuntimeFacts({
      provider: issue.provider ?? input.provider,
      providerTurnId: issue.providerTurnId ?? input.providerTurnId,
    }),
    latestTurnStatus: 'failed',
    lastRuntimeIssue: issue,
  } satisfies PrimarySessionRuntimeIssueRecord;
  if (input.session?.sessionTurnLifecycle) {
    await input.session.sessionTurnLifecycle.failTurn({
      provider: record.provider,
      providerTurnId: record.providerTurnId,
      issue,
      ...(input.allocateTurnWhenIdle ? { allocateWhenIdle: true } : {}),
      ...(input.suppressUntrustedDuplicate ? { suppressUntrustedDuplicate: true } : {}),
      ...(input.onFailureTurn ? { onFailureTurn: (failure) => {
        issue = failure.issue;
        input.onFailureTurn?.(failure);
      } } : {}),
    });
    await input.recordIssue?.({ ...record, lastRuntimeIssue: issue });
    return issue;
  }
  sendTurnLifecycleMessage(input.session, input.provider, 'turn_failed', issue.providerTurnId ?? input.providerTurnId, issue);
  await input.recordIssue?.(record);
  return issue;
}

export async function recordSessionTurnInProgress(
  input: Readonly<{
    session?: RuntimeIssueSession | null;
    provider?: string | null;
    providerTurnId?: string | null;
}>,
): Promise<void> {
  if (input.session?.sessionTurnLifecycle) {
    await input.session.sessionTurnLifecycle.beginTurn(buildProviderRuntimeFacts(input));
  }
}

export async function recordSessionTurnCompleted(
  input: Readonly<{
    session?: RuntimeIssueSession | null;
    provider?: string | null;
    providerTurnId?: string | null;
}>,
): Promise<void> {
  if (input.session?.sessionTurnLifecycle) {
    await input.session.sessionTurnLifecycle.completeTurn(buildProviderRuntimeFacts(input));
  }
}
