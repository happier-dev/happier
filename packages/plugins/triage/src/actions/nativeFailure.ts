import { isPluginError } from '@happier-dev/plugin-sdk';
import { isActionOutcomeUnknownErrorCodeV1 } from '@happier-dev/plugin-sdk/errors';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { SessionMessageSendResultV1ProtocolSchema } from '@happier-dev/plugin-sdk/sessions';
import { isPluginActionApprovalRequestCreated, type ActionExecuteResult, type PluginClientActionContext } from '@happier-dev/plugin-sdk/actions';
import type { FailureActionOutcome, FailureAgentAction } from '@happier-dev/plugin-sdk/ui';
import {
  TriageSessionHandoffInputV1Schema, TriageSessionHandoffResultV1Schema, TriageSessionHandoffChoicesV1Schema,
  triageFailureSubjectActionSubjectV1, triageFailureSubjectEntryV1,
  TriageReadSourceSessionLinksResultV1Schema, TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1,
  buildTriageActionEditorLaunchInputV1, TRIAGE_APP_PAGE_DESTINATION_V1,
  type TriageSessionHandoffInputV1,
} from '@happier-dev/triage-protocol/v1';
import { TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1, TriageConfiguredStartRecoveryV1Schema,
  type TriageConfiguredStartRecoveryV1 } from './configuredActionRunProtocol.js';
import { TriageNativeFailureInputV1Schema, type TriageNativeFailureInputV1 } from './nativeFailureProtocol.js';

type Context = Extract<TriageNativeFailureInputV1, { kind: 'launch' }>['context'];
type Placement = Extract<TriageNativeFailureInputV1, { kind: 'launch' }>['placement'];
type Operation = { handoff: TriageSessionHandoffInputV1; recovery?: TriageConfiguredStartRecoveryV1;
  pending?: Promise<ActionExecuteResult>; placementRequired?: true };

const unknownOutcome = (): ActionExecuteResult => ({ ok: false, errorCode: 'action_outcome_unknown', error: 'action_outcome_unknown' });
const subjectKey = (context: Context) => JSON.stringify(context.kind === 'failure'
  ? triageFailureSubjectEntryV1(context.subject).entryRef : context.kind === 'entry' ? context.entry : context.kind === 'healthAlert' ? context.notice.artifactId : context);

/** Retry custody belongs to the same Triage generation and admitted origin as its Session handoff. */
export function createTriageNativeFailureOwner() {
  const operations = new Map<string, Operation>();
  async function execute(context: PluginClientActionContext, localId: string, input: unknown): Promise<ActionExecuteResult> {
    try {
      return { ok: true, result: await context.ui.executeAction('action.invoke', {
        action: { pluginId: context.plugin.id, localId }, input,
      }, { signal: context.signal }) };
    } catch (error) {
      if (!isPluginError(error)) return unknownOutcome();
      const details = error.details;
      return { ok: false, errorCode: error.code, error: error.message,
        ...(details && typeof details === 'object' && !Array.isArray(details)
          && 'effectAttempted' in details && typeof details.effectAttempted === 'boolean' ? { effectAttempted: details.effectAttempted } : {}) };
    }
  }
  function runOperation(key: string, operation: Operation, context: PluginClientActionContext): Promise<ActionExecuteResult> {
    if (operation.pending) return operation.pending;
    const pending = (async () => {
      const result = await execute(context, TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1, { v: 1,
        handoff: operation.handoff, ...(operation.recovery === undefined ? {} : { resumeStart: operation.recovery }) });
      if (operations.get(key) !== operation) return result;
      if (!result.ok) {
        if (operation.recovery === undefined && !isActionOutcomeUnknownErrorCodeV1(result.errorCode)
          && result.effectAttempted !== true) operations.delete(key);
        return result;
      }
      const value = result.result;
      const handoff = value && typeof value === 'object' && 'handoff' in value
        ? TriageSessionHandoffResultV1Schema.safeParse(value.handoff) : null;
      if (!handoff?.success) {
        if (isPluginActionApprovalRequestCreated(value)) operations.delete(key);
        return result;
      }
      if (handoff.data.kind === 'placement_choice_required') operation.placementRequired = true;
      else if (handoff.data.kind === 'composed' || handoff.data.kind === 'sendResult') operations.delete(key);
      else if (value && typeof value === 'object' && 'recovery' in value && value.recovery !== undefined) {
        const recovery = TriageConfiguredStartRecoveryV1Schema.safeParse(value.recovery);
        if (recovery.success) operation.recovery = recovery.data;
      } else if (handoff.data.kind !== 'uncertain') operations.delete(key);
      return result;
    })();
    operation.pending = pending;
    void pending.then(() => { if (operation.pending === pending) operation.pending = undefined; });
    return pending;
  }
  async function readChoices(subject: Context, context: PluginClientActionContext) {
    const actionSubject = subject.kind === 'failure' ? triageFailureSubjectActionSubjectV1(subject.subject) : undefined;
    const result = await execute(context, 'actions/read-v1', { v: 1, projection: 'sessionHandoff', task: 'investigate',
      ...(actionSubject === undefined ? {} : { subject: actionSubject }) });
    if (!result.ok) return unavailable(result.errorCode ?? 'unknown_error');
    const parsed = TriageSessionHandoffChoicesV1Schema.safeParse(result.result);
    if (!parsed.success) return unavailable('invalid_result');
    return parsed.data.kind === 'unavailable' ? unavailable(parsed.data.reason) : parsed.data;
  }
  function resume(subject: Context, placement: Placement, context: PluginClientActionContext): Promise<ActionExecuteResult> | null {
    const key = subjectKey(subject);
    const operation = operations.get(key);
    if (!operation) return null;
    if (operation.pending) return operation.pending;
    if (operation.placementRequired) {
      if (placement) {
        const { agentTargetKey, ...where } = placement;
        operation.handoff = TriageSessionHandoffInputV1Schema.parse({ ...operation.handoff,
          ...(agentTargetKey ? { agentChoice: { kind: 'target', targetKey: agentTargetKey } } : {}),
          context: operation.handoff.context.kind === 'entry' ? operation.handoff.context : { ...operation.handoff.context, ...where } });
      }
      operation.placementRequired = undefined;
      return runOperation(key, operation, context);
    }
    return operation.recovery === undefined ? Promise.resolve(unknownOutcome()) : runOperation(key, operation, context);
  }
  return {
    dispose: () => operations.clear(),
    async invoke(input: TriageNativeFailureInputV1, context: PluginClientActionContext): Promise<JsonValue> {
      if (input.kind === 'edit') {
        await context.ui.openSurface(TRIAGE_APP_PAGE_DESTINATION_V1, buildTriageActionEditorLaunchInputV1(input.actionId),
          { subPath: '', signal: context.signal });
        return { kind: 'edited' } as const;
      }
      if (input.kind === 'readLinkedSession') {
        if (input.context.kind !== 'failure') return { kind: 'linkedSession', session: null } as const;
        const result = await execute(context, TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1,
          { v: 1, entryRef: triageFailureSubjectEntryV1(input.context.subject).entryRef });
        const parsed = result.ok ? TriageReadSourceSessionLinksResultV1Schema.safeParse(result.result) : null;
        const latest = parsed?.success ? parsed.data.links.reduce<(typeof parsed.data.links)[number] | null>((previous, link) =>
          !previous || link.linkedAtMs > previous.linkedAtMs ? link : previous, null) : null;
        const account = latest ? await context.ui.context({ signal: context.signal }) : null;
        return { kind: 'linkedSession', session: latest && account?.accountScope
          ? { serverId: account.accountScope.serverId, sessionId: latest.sessionId } : null } as const;
      }
      if (input.kind === 'readAgentActions') {
        const choices = await readChoices(input.context, context);
        if (choices.kind === 'unavailable') return { kind: 'presentation', outcome: choices } as const;
        const isDefault = (id: string) => input.includeDefault && id === choices.defaultActionId;
        const actions: readonly FailureAgentAction[] = [
          ...choices.actions.filter(item => isDefault(item.selection.configuredActionId)),
          ...choices.actions.filter(item => item.forSubject === true && !isDefault(item.selection.configuredActionId)),
        ].map(item => ({ actionId: item.selection.configuredActionId, label: item.label,
          ...(item.titleKey === undefined ? {} : { titleKey: item.titleKey }),
          launchMode: item.launchMode ?? 'review', startable: item.startable ?? true }));
        return { kind: 'actions', actions } as const;
      }
      if (input.kind !== 'launch') throw new Error('Unsupported native failure operation');
      const subject = input.context;
      if (subject.kind === 'entries' || subject.kind === 'repository')
        return { kind: 'presentation', outcome: unavailable('invalid_input') };
      const retained = resume(subject, input.placement, context);
      if (retained) return { kind: 'presentation', outcome: present(await retained) } as const;
      const choices = await readChoices(input.context, context);
      if (choices.kind === 'unavailable') return { kind: 'presentation', outcome: choices } as const;
      const wanted = input.actionId ?? choices.defaultActionId;
      const selection = choices.actions.find(action => action.selection.configuredActionId === wanted)?.selection;
      if (!selection) return { kind: 'presentation', outcome: unavailable('configuredActionUnavailable') } as const;
      const { agentTargetKey, ...placement } = input.placement ?? {};
      const handoff = TriageSessionHandoffInputV1Schema.parse({ task: 'investigate', ...selection,
        ...(input.delivery ? { delivery: input.delivery } : {}),
        ...(agentTargetKey ? { agentChoice: { kind: 'target', targetKey: agentTargetKey } } : {}),
        context: subject.kind === 'entry' ? subject : { ...subject, ...placement },
        evidence: [subject.kind === 'entry' ? { kind: 'alertEntry', entry: subject.entry }
          : subject.kind === 'failure' ? { kind: 'failure', subject: subject.subject } : { kind: 'alert', notice: subject.notice }] });
      const operation = { handoff };
      const key = subjectKey(subject);
      operations.set(key, operation);
      const outcome = present(await runOperation(key, operation, context));
      return { kind: 'presentation', outcome: outcome?.kind === 'unavailable'
        ? { ...outcome, configuredActionId: selection.configuredActionId } : outcome } as const;
    },
  };
}

const unavailable = (code: string): Extract<FailureActionOutcome, { kind: 'unavailable' }> => ({ kind: 'unavailable', code,
  ...(code === 'configuredActionUnavailable' ? { recovery: 'configure' } : {}) });

/** Domain outcomes are normalized at Triage, not reinterpreted by native failure presenters. */
export function presentTriageNativeFailureResult(result: ActionExecuteResult): FailureActionOutcome | null {
  if (!result.ok) return unavailable(result.errorCode ?? 'unknown_error');
  if (isPluginActionApprovalRequestCreated(result.result)) return { kind: 'approval', artifactId: result.result.artifactId };
  const value = result.result;
  const handoff = value && typeof value === 'object' && 'handoff' in value ? TriageSessionHandoffResultV1Schema.safeParse(value.handoff) : null;
  if (!handoff?.success) return unavailable('invalid_result');
  switch (handoff.data.kind) {
    case 'entryExecution': return unavailable('invalid_result');
    case 'placement_choice_required': return handoff.data;
    case 'composed': return { kind: 'started', handoff: handoff.data };
    case 'sendResult': return 'status' in handoff.data.result
      ? handoff.data.result.status === 'rejected' ? { ...unavailable((handoff.data.result as Extract<ReturnType<typeof SessionMessageSendResultV1ProtocolSchema.parse>, { status: 'rejected' }>).code), handoff: handoff.data }
        : { kind: 'started', handoff: handoff.data }
      : unavailable('invalid_result');
    case 'cancelled': return null;
    case 'selectionRequired': return { kind: 'selectionRequired', fields: handoff.data.fields };
    case 'uncertain': return { kind: 'uncertain' };
    case 'unavailable': return { ...unavailable(handoff.data.detail?.cause ?? handoff.data.reason),
      ...(handoff.data.detail ? { detail: handoff.data.detail } : {}) };
  }
}
const present = presentTriageNativeFailureResult;

export async function handleTriageNativeFailure(input: unknown, context: PluginClientActionContext): Promise<JsonValue> {
  const parsed = TriageNativeFailureInputV1Schema.parse(input);
  const lease = context.ephemeralSharedScope?.acquireExecutionBound?.('triage.native-failure.v1', () => {
    const value = createTriageNativeFailureOwner();
    return { value, dispose: value.dispose, retainWhenIdle: true };
  });
  if (!lease || context.signal.aborted) return { kind: 'presentation', outcome: unavailable('action_account_scope_changed') } as const;
  try { return await lease.value.invoke(parsed, context); }
  finally { lease.release(); }
}
