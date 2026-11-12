import * as React from 'react';
import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import { Banner, Button, isPluginActionConfirmationDeclined, projectPluginActionControlExecutionV1, projectPluginActionRejectionV1, usePluginTranslation, type PluginActionExecution } from '@happier-dev/plugin-ui';
import { readTriageSourceOperationOutcomeV1, type SessionPullRequestNativeStatusV1,
  type TriagePullRequestOperationOfferV1, type TriagePullRequestOperationsV1,
  type TriageSourceOperationOutcomeV1 } from '@happier-dev/triage-protocol/v1';

import type { TriageDetailPrimaryWriteV1 } from './evidenceDisclosure.js';

export type TriagePullRequestPrimaryWriteInputV1 = Readonly<{
  operations: TriagePullRequestOperationsV1 | undefined;
  nativeStatus?: SessionPullRequestNativeStatusV1 | undefined;
  /** Current Resource availability, while its admitted retained facts remain displayable. */
  unavailableReason?: string;
  /** Rechecks the original offered choice against the caller's current admitted Resource. */
  execute(operationId: string, variantId?: string): Promise<unknown>;
  signal: AbortSignal;
  /** An explicit native re-read; true only for its current successful observation. */
  refresh?: () => Promise<boolean>;
  /** A separate lazy requirements read, when the source has one. */
  readRequirements?: () => Promise<boolean>;
  /** Source-specific effects after settlement, never another outcome parser or dispatch. */
  onSettled?: (execution: PluginActionExecution<unknown>, outcome: TriageSourceOperationOutcomeV1 | null,
    offer: TriagePullRequestOperationOfferV1) => void;
}>;

export type TriagePullRequestPrimaryWriteControllerV1 = Readonly<{
  primaryWrite: TriageDetailPrimaryWriteV1 | null;
  refresh(): Promise<void>;
}>;

type Feedback = Readonly<{ kind: 'source'; value: TriageSourceOperationOutcomeV1 }>
  | Readonly<{ kind: 'approval' | 'unreadable' }>
  | Readonly<{ kind: 'transport'; value: PluginActionExecution }>;
type Record = Readonly<{ signal: AbortSignal; pending: boolean; blocked: boolean; feedback: Feedback | null }>;
const actionKey = (offer: TriagePullRequestOperationOfferV1) => JSON.stringify([offer.actionRef.pluginId, offer.actionRef.localId]);

/** One source-independent presenter. Only the public source result reader interprets native outcomes. */
export function useTriagePullRequestPrimaryWriteV1(input: TriagePullRequestPrimaryWriteInputV1): TriagePullRequestPrimaryWriteControllerV1 {
  const text = usePluginTranslation();
  const [records, setRecords] = React.useState<ReadonlyMap<string, Record>>(() => new Map<string, Record>());
  const current = React.useRef(records);
  const [last, setLast] = React.useState<Record | null>(null);
  const latest = React.useRef(last);
  // The current mounted offer retires captured UI choices; the domain executor still owns Action admission.
  const shown = React.useRef(input);
  shown.current = input;
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const publish = React.useCallback((key: string, record: Record) => {
    if (!mounted.current || record.signal.aborted || record.signal !== shown.current.signal) return;
    const displayed = shown.current.operations;
    const offers = displayed ? [displayed.primary, ...displayed.alternatives] : [];
    const keys = new Set(offers.map(actionKey));
    const next = new Map([...current.current].filter(([id, item]) => keys.has(id) && item.signal === shown.current.signal));
    next.set(key, record); current.current = next; latest.current = record;
    setRecords(next); setLast(record);
  }, []);
  const review = React.useCallback(async (read: (() => Promise<boolean>) | undefined): Promise<void> => {
    if (!read || input.signal.aborted || shown.current.signal !== input.signal) return;
    const reviewed = current.current; const reviewedLast = latest.current;
    if (!await read() || !mounted.current || input.signal.aborted || shown.current.signal !== input.signal) return;
    const next = new Map(current.current);
    let changed = false;
    for (const [key, item] of next) {
      if (item.blocked && reviewed.get(key) === item) {
        // Keep the existing Action record as the choice-retirement boundary:
        // removing it would revive callbacks captured before the write.
        next.set(key, { ...item, blocked: false, feedback: null });
        changed = true;
      }
    }
    if (changed) { current.current = next; setRecords(next); }
    if (latest.current === reviewedLast && reviewedLast?.blocked) { latest.current = null; setLast(null); }
  }, [input.signal]);
  const refresh = React.useCallback(() => review(input.refresh), [review, input.refresh]);
  const readRequirements = React.useCallback(() => review(input.readRequirements ?? input.refresh),
    [review, input.readRequirements, input.refresh]);
  const primaryWrite = React.useMemo((): TriageDetailPrimaryWriteV1 | null => {
  if (!input.operations) return null;
  const unknown = text('happier.triage.operation.unknown', 'The outcome is unknown. Re-read before trying again.');
  const offer = (source: TriagePullRequestOperationOfferV1): TriageDetailPrimaryWriteV1 => {
    const key = actionKey(source);
    const record = records.get(key);
    const state = record?.signal === input.signal ? record : undefined;
    const disabledReason = input.signal.aborted ? text('happier.triage.operation.retired', 'This choice is no longer available.')
      : input.unavailableReason ?? (state?.blocked ? unknown : source.disabledReason === null ? null
        : source.disabledReasonKey === undefined ? source.disabledReason : text(source.disabledReasonKey, source.disabledReason));
    const variant = (id?: string) => {
      const choices = id === undefined ? source.variants.filter(item => source.variants.length === 1 && item.method === undefined)
        : source.variants.filter(item => item.id === id);
      return choices.length === 1 ? choices[0] : undefined;
    };
    const methods = source.variants.flatMap(item => item.method === undefined ? [] : [{ id: item.id,
      title: item.method.titleKey === undefined ? item.method.title : text(item.method.titleKey, item.method.title) }]);
    const offered = () => {
      const displayed = shown.current.operations;
      return shown.current.signal === input.signal && shown.current.unavailableReason === undefined
        && current.current.get(key) === record
        && displayed !== undefined && [displayed.primary, ...displayed.alternatives].includes(source);
    };
    const settle = (execution: PluginActionExecution<unknown>) => {
      const outcome = execution.status === 'success' ? readTriageSourceOperationOutcomeV1(execution.result) : null;
      const feedback: Feedback | null = isPluginActionConfirmationDeclined(execution) ? null
        : execution.status !== 'success' ? { kind: 'transport', value: execution }
        : outcome ? { kind: 'source', value: outcome }
          : isPluginActionApprovalRequestCreated(execution.result) ? { kind: 'approval' } : { kind: 'unreadable' };
      const blocked = feedback?.kind === 'unreadable' || feedback?.kind === 'source' && feedback.value.kind === 'uncertain'
        || feedback?.kind === 'transport' && feedback.value.status === 'outcomeUnknown';
      publish(key, { signal: input.signal,
        pending: feedback?.kind === 'transport' && feedback.value.status === 'pending', blocked, feedback });
      if (mounted.current && !input.signal.aborted && shown.current.signal === input.signal) {
        shown.current.onSettled?.(execution, outcome, source);
      }
    };
    const prepare = (id?: string) => {
      const active = current.current.get(key);
      if (!mounted.current || input.signal.aborted || !offered() || source.disabledReason !== null
        || active?.signal === input.signal && (active.pending || active.blocked)) return null;
      const choice = variant(id);
      if (!choice) return null;
      publish(key, { signal: input.signal, pending: true, blocked: false, feedback: null });
      return { input: choice.input };
    };
    return { id: source.id, title: source.titleKey === undefined ? source.title : text(source.titleKey, source.title),
      disabledReason, pending: state?.pending ?? false, actionRef: source.actionRef, signal: input.signal,
      controllerFor: id => ({ prepare: () => prepare(id),
        onSettled: execution => settle(projectPluginActionControlExecutionV1(execution, text)) }),
      ...(methods.length ? { methods } : {}),
      inputFor: id => disabledReason !== null || input.signal.aborted || !offered()
        || current.current.get(key)?.signal === input.signal && current.current.get(key)?.blocked ? null : variant(id)?.input ?? null,
      execute: async id => {
        if (!prepare(id)) return;
        let execution: PluginActionExecution<unknown>;
        try { execution = { status: 'success', result: await input.execute(source.id, id) }; }
        catch (error) { execution = projectPluginActionRejectionV1(error, text); }
        settle(execution);
      } };
  };
  const primary = offer(input.operations.primary);
  const settled = last?.signal === input.signal ? last : null;
  const blocked = [...records.values()].find(item => item.signal === input.signal && item.blocked);
  const recent = settled?.feedback;
  const feedback = recent && (recent.kind !== 'transport' || recent.value.status === 'error' || recent.value.status === 'outcomeUnknown')
    ? recent : blocked?.feedback;
  let node: React.ReactNode;
  const recovery = blocked && input.refresh ? <Button title="Re-read" variant="plain" size="small" onPress={refresh} /> : undefined;
  if (feedback?.kind === 'source') node = <Banner title={feedback.value.presentation.title}
    description={feedback.value.presentation.description} tone={feedback.value.presentation.tone}
    {...(feedback.value.presentation.titleKey === undefined ? {} : { titleKey: feedback.value.presentation.titleKey })}
    {...(feedback.value.presentation.descriptionKey === undefined ? {} : { descriptionKey: feedback.value.presentation.descriptionKey })}
    {...(feedback.value.kind === 'refused' && feedback.value.unmetRequirements !== undefined
      ? { points: feedback.value.unmetRequirements.map(item => [item.label]) } : {})}
    {...(recovery ? { action: recovery } : {})} />;
  else if (feedback?.kind === 'unreadable') node = <Banner title="Outcome unknown" description={unknown} tone="warning" {...(recovery ? { action: recovery } : {})} />;
  else if (feedback?.kind === 'approval') node = <Banner title="Approval requested" description="The host is waiting for approval." tone="neutral"
    {...(recovery ? { action: recovery } : {})} />;
  else if (feedback?.kind === 'transport' && (feedback.value.status === 'error' || feedback.value.status === 'outcomeUnknown')) {
    node = <Banner title={feedback.value.status === 'outcomeUnknown' ? 'Outcome unknown' : 'Change not completed'}
      description={feedback.value.message} tone="warning" {...(recovery ? { action: recovery } : {})} />;
  }
  return { ...primary, alternatives: input.operations.alternatives.map(offer),
    unmetRequirements: input.operations.unmetRequirements,
    ...(input.nativeStatus === undefined ? {} : { nativeStatus: input.nativeStatus }),
    ...(input.refresh === undefined && input.readRequirements === undefined ? {} : { readRequirements }),
    readiness: { label: input.operations.readiness === 'ready' ? 'Ready to merge'
      : input.operations.readiness === 'blocked' ? 'Merge requirements unmet' : 'Merge requirements unknown',
      enabled: primary.disabledReason === null, reason: primary.disabledReason },
    ...(node === undefined ? {} : { feedback: node }),
  };
  }, [input.operations, input.nativeStatus, input.unavailableReason, input.execute, input.signal,
    input.refresh, input.readRequirements, text, records, last, publish, refresh, readRequirements]);
  return React.useMemo(() => ({ primaryWrite, refresh }), [primaryWrite, refresh]);
}
