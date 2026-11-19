import * as React from 'react';
import type { FailureActionOutcome, FailureActionPlacement, FailureAgentAction } from '@happier-dev/protocol/plugins/contributions/ui/failureActionPresentation';
import type { AccountNoticeArtifactHeaderV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import type { FailureAgentActionsReadResult } from '@/hooks/inbox/accountNoticeInvestigation';

type EnvironmentNoticePage = Extract<NonNullable<AccountNoticeArtifactHeaderV1['page']>, { page: 'environment' }>;

/**
 * What a notice can be investigated about: a failing service on one exact Machine, or a provider
 * alert (a Sentry or PostHog issue) whose stored evidence names its entry. Investigate is offered
 * only while the subject is open and the notice's investigation data hook admits it.
 */
export type NoticeInvestigationSubject =
  /** `service` is the service's name when the notice carries one; an adopted service carries only its opaque watch id. */
  | Readonly<{ kind: 'service'; machineId: string; service: string | null; open: boolean; investigable: boolean }>
  | Readonly<{ kind: 'environment'; environment: EnvironmentNoticePage['environment']; targetLinkId?: string; open: boolean; investigable: boolean }>
  | Readonly<{ kind: 'alert'; open: boolean; investigable: boolean }>;

export function readNoticeInvestigationSubject(
  header: AccountNoticeArtifactHeaderV1,
  eligible: boolean,
): NoticeInvestigationSubject | null {
  const open = header.healthPhase === 'open' && header.status === 'open' && !header.resolved;
  if (header.source.kind === 'host' && header.source.topic === 'service_health'
    && header.page && 'kind' in header.page && header.page.page === 'machine_service') {
    return { kind: 'service', machineId: header.page.machine.machineId,
      service: header.page.service.kind === 'deployment' ? header.page.service.composeService : null,
      open, investigable: open && eligible };
  }
  if (header.source.kind === 'host' && header.source.topic === 'service_health'
    && header.page && 'kind' in header.page && header.page.page === 'environment') {
    return { kind: 'environment', environment: header.page.environment,
      targetLinkId: header.page.targetLinkId, open, investigable: open && eligible };
  }
  if (header.source.kind === 'plugin' && header.healthPhase !== undefined) {
    return { kind: 'alert', open, investigable: open && eligible };
  }
  return null;
}

/** The contribution owns selection, retry custody, and domain outcomes. */
export type HealthNoticeInvestigationPlacement = FailureActionPlacement;
export type BoundHealthNoticeInvestigation = Readonly<{
  readAgentActions(includeDefault: boolean, options: Readonly<{ signal: AbortSignal }>): Promise<FailureAgentActionsReadResult>;
  launch(intent: Readonly<{ actionId?: string; delivery?: 'compose' | 'send' }>, options: Readonly<{
    signal: AbortSignal; placement?: HealthNoticeInvestigationPlacement;
  }>): Promise<FailureActionOutcome | null>;
}>;
export type HealthNoticeInvestigationOutcome = FailureActionOutcome;

export function useHealthNoticeInvestigate(
  investigation: BoundHealthNoticeInvestigation | null,
  subjectIdentity: unknown = null,
) {
  const [pending, setPending] = React.useState(false);
  const [outcome, setOutcome] =
    React.useState<HealthNoticeInvestigationOutcome | null>(null);
  const controller = React.useRef<AbortController | null>(null);
  // The record the person pressed; a placement retry continues that same record.
  const pressedActionId = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    setPending(false);
    setOutcome(null);
    pressedActionId.current = undefined;
    return () => {
      controller.current?.abort();
      controller.current = null;
    };
  }, [subjectIdentity]);
  const performInvestigation = React.useCallback(async (placement?: HealthNoticeInvestigationPlacement,
    delivery?: 'compose' | 'send') => {
    if (!investigation || controller.current) return;
    const own = new AbortController();
    controller.current = own;
    setPending(true);
    setOutcome(null);
    try {
      const result = await investigation.launch({
        ...(pressedActionId.current === undefined ? {} : { actionId: pressedActionId.current }),
        ...(delivery === undefined ? {} : { delivery }),
      }, { signal: own.signal, ...(placement ? { placement } : {}) });
      if (!own.signal.aborted) setOutcome(result);
    } catch {
      if (!own.signal.aborted)
        setOutcome({ kind: 'unavailable', code: 'unknown_error' });
    } finally {
      if (controller.current === own) controller.current = null;
      if (!own.signal.aborted) setPending(false);
    }
  }, [investigation]);
  const investigate = React.useCallback(() => {
    pressedActionId.current = undefined;
    return performInvestigation();
  }, [performInvestigation]);
  const investigateWithPlacement = React.useCallback((placement: HealthNoticeInvestigationPlacement) =>
    performInvestigation(placement), [performInvestigation]);
  /**
   * `AgentActionButton`'s launch: the record the person pressed (the default when none is named, or the record
   * pressed last for a follow-up launch), in the mode they chose.
   */
  const launch = React.useCallback((mode: 'start' | 'review', configuredActionId?: string) => {
    if (configuredActionId !== undefined) pressedActionId.current = configuredActionId;
    return performInvestigation(undefined, mode === 'start' ? 'send' : 'compose');
  }, [performInvestigation]);
  return { investigate, investigateWithPlacement, launch, pending, outcome };
}

export type InvestigationAgentAction = FailureAgentAction;

/**
 * The page's records, read once per subject so the buttons carry the person's names and launch modes. `undefined`
 * until the catalog first answers, so a page can hold the control's place instead of drawing a stand-in it then
 * replaces. Keep the producer's typed refusal and accept the legacy empty answer.
 */
export function useInvestigationAgentActions(
  investigation: BoundHealthNoticeInvestigation | null,
  options: Readonly<{ includeDefault: boolean; /** Bumped by the person's Retry: the same read again. */ attempt?: number }>,
): FailureAgentActionsReadResult | undefined {
  const [answer, setAnswer] = React.useState<FailureAgentActionsReadResult | undefined>(undefined);
  const includeDefault = options.includeDefault;
  const attempt = options.attempt ?? 0;
  React.useEffect(() => {
    if (!investigation) {
      setAnswer(undefined);
      return;
    }
    const own = new AbortController();
    // Keep the previous records during a new read, but clear a refusal belonging to the previous subject.
    setAnswer(current => current && 'kind' in current ? undefined : current);
    void investigation.readAgentActions(includeDefault, { signal: own.signal }).then((result) => {
      if (!own.signal.aborted) setAnswer(result);
    }, () => {
      if (!own.signal.aborted) setAnswer({ kind: 'unavailable', code: 'unknown_error' });
    });
    return () => own.abort();
  }, [investigation, includeDefault, attempt]);
  return answer;
}
