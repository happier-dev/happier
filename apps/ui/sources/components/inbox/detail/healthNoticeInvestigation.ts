import * as React from 'react';
import type { SessionMessageSendResultV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { TriageSessionHandoffResultV1Schema } from '@happier-dev/triage-protocol/v1';
import {
  ActionApprovalRequestCreatedResultSchema,
  type ActionExecuteResult,
} from '@happier-dev/protocol/actions/actionExecutionResult';

import type { TriageSessionHandoffChoicesV1, TriageSessionHandoffSelectionV1,
  TriageSessionHandoffInputV1, TriageSessionHandoffResultV1 } from '@happier-dev/triage-protocol/v1';
import type { AccountNoticeArtifactHeaderV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';

type EnvironmentNoticePage = Extract<NonNullable<AccountNoticeArtifactHeaderV1['page']>, { page: 'environment' }>;

/**
 * What a notice can be investigated about: a failing service on one exact Machine, or a provider
 * alert (a Sentry or PostHog issue) whose stored evidence names its entry. Investigate is offered
 * only while the subject is open and the notice's investigation data hook admits it.
 */
export type NoticeInvestigationSubject =
  | Readonly<{ kind: 'service'; machineId: string; service: string; open: boolean; investigable: boolean }>
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
      service: header.page.service.kind === 'deployment' ? header.page.service.composeService : header.page.service.serviceId,
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

/** The notice's investigation, bound to its exact entry by the Inbox model (or a dev fixture). */
export type HealthNoticeInvestigationPlacement = Partial<Pick<
  Extract<TriageSessionHandoffInputV1['context'], { kind: 'healthAlert' }>, 'machine' | 'workspace'>> & Readonly<{
    agentTargetKey?: Extract<TriageSessionHandoffInputV1['agentChoice'], { kind: 'target' }>['targetKey'];
  }>;

export type BoundHealthNoticeInvestigation = Readonly<{
  readChoices(options: Readonly<{ signal: AbortSignal }>): Promise<TriageSessionHandoffChoicesV1>;
  resume(options: Readonly<{ signal: AbortSignal }>): Promise<ActionExecuteResult> | null;
  run(selection: TriageSessionHandoffSelectionV1, options: Readonly<{
    signal: AbortSignal; placement?: HealthNoticeInvestigationPlacement;
  }>): Promise<ActionExecuteResult>;
}>;

/**
 * What the notice says after Investigate was pressed. A started handoff says nothing here: the
 * configured Triage owner has already opened the New Session draft (or the existing Session), and
 * that page is the answer. Every other outcome keeps the notice readable and says what happened.
 */
export type HealthNoticeInvestigationOutcome =
  | Extract<TriageSessionHandoffResultV1, { kind: 'placement_choice_required' }>
  | Readonly<{ kind: 'started'; handoff: Extract<TriageSessionHandoffResultV1, { kind: 'composed' | 'sendResult' }> }>
  | Readonly<{ kind: 'approval'; artifactId: string }>
  | Readonly<{ kind: 'selectionRequired'; fields: Extract<TriageSessionHandoffResultV1, { kind: 'selectionRequired' }>['fields'] }>
  | Readonly<{ kind: 'uncertain' }>
  | Readonly<{ kind: 'unavailable'; code: string;
    handoff?: Extract<TriageSessionHandoffResultV1, { kind: 'sendResult' }>;
    detail?: Extract<TriageSessionHandoffResultV1, { kind: 'unavailable' }>['detail'] }>;

export function readHealthNoticeInvestigationOutcome(
  result: ActionExecuteResult,
): HealthNoticeInvestigationOutcome | null {
  if (!result.ok)
    return { kind: 'unavailable', code: result.errorCode ?? 'unknown_error' };
  const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
  if (approval.success)
    return { kind: 'approval', artifactId: approval.data.artifactId };
  const value = result.result;
  const handoff =
    value && typeof value === 'object' && 'handoff' in value
      ? TriageSessionHandoffResultV1Schema.safeParse(
          (value as { handoff: unknown }).handoff,
        )
      : null;
  if (!handoff?.success) return { kind: 'unavailable', code: 'invalid_result' };
  switch (handoff.data.kind) {
    case 'entryExecution':
      // Notice investigations use the configured non-entry handoff, never an entry batch.
      return { kind: 'unavailable', code: 'invalid_result' };
    case 'placement_choice_required':
      return handoff.data;
    case 'composed':
      return { kind: 'started', handoff: handoff.data };
    case 'sendResult':
      if (!('status' in handoff.data.result)) return { kind: 'unavailable', code: 'invalid_result' };
      return handoff.data.result.status === 'rejected'
        // The parsed schema and rejected status prove this exact arm despite its ProtocolJsonValue intersection.
        ? { kind: 'unavailable', code: (handoff.data.result as Extract<SessionMessageSendResultV1, { status: 'rejected' }>).code, handoff: handoff.data }
        : { kind: 'started', handoff: handoff.data };
    case 'cancelled':
      return null;
    case 'selectionRequired':
      return { kind: 'selectionRequired', fields: handoff.data.fields };
    case 'uncertain':
      return { kind: 'uncertain' };
    case 'unavailable':
      return { kind: 'unavailable', code: handoff.data.detail?.cause ?? handoff.data.reason,
        ...(handoff.data.detail ? { detail: handoff.data.detail } : {}) };
  }
}

/**
 * One press: ask Triage which Investigate it offers (no read on mount), run the catalog's default
 * selection, and report the outcome. The Session, Agent and Machine placement stay with the
 * configured owner; this never picks a fallback.
 */
export function useHealthNoticeInvestigate(
  investigation: BoundHealthNoticeInvestigation | null,
  subjectIdentity: unknown = null,
) {
  const [pending, setPending] = React.useState(false);
  const [outcome, setOutcome] =
    React.useState<HealthNoticeInvestigationOutcome | null>(null);
  const controller = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    setPending(false);
    setOutcome(null);
    return () => {
      controller.current?.abort();
      controller.current = null;
    };
  }, [subjectIdentity]);
  const performInvestigation = React.useCallback(async (placement?: HealthNoticeInvestigationPlacement) => {
    if (!investigation || controller.current) return;
    const own = new AbortController();
    controller.current = own;
    setPending(true);
    setOutcome(null);
    try {
      const retained = investigation.resume({ signal: own.signal });
      if (retained) {
        const result = await retained;
        if (!own.signal.aborted) setOutcome(readHealthNoticeInvestigationOutcome(result));
        return;
      }
      const choices = await investigation.readChoices({
        signal: own.signal,
      });
      if (own.signal.aborted) return;
      const selection =
        choices.kind === 'choices'
          ? choices.actions.find(
              (action) =>
                action.selection.configuredActionId === choices.defaultActionId,
            )?.selection
          : undefined;
      if (!selection) {
        setOutcome({
          kind: 'unavailable',
          code:
            choices.kind === 'choices'
              ? 'configuredActionUnavailable'
              : choices.reason,
        });
        return;
      }
      const result = await investigation.run(selection, {
        signal: own.signal,
        ...(placement ? { placement } : {}),
      });
      if (!own.signal.aborted)
        setOutcome(readHealthNoticeInvestigationOutcome(result));
    } catch {
      if (!own.signal.aborted)
        setOutcome({ kind: 'unavailable', code: 'unknown_error' });
    } finally {
      if (controller.current === own) controller.current = null;
      if (!own.signal.aborted) setPending(false);
    }
  }, [investigation]);
  const investigate = React.useCallback(() => performInvestigation(), [performInvestigation]);
  const investigateWithPlacement = React.useCallback((placement: HealthNoticeInvestigationPlacement) =>
    performInvestigation(placement), [performInvestigation]);
  return { investigate, investigateWithPlacement, pending, outcome };
}
