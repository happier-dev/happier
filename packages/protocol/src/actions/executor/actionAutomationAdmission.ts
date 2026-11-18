import { z } from '../../zodRuntimePolicy.js';
import { automationSubjectKeyV1, automationSubjectKeyMatchesV1,
  type AutomationSubjectV1, type AutomationSubjectContextV1 } from '../../automations/automationSubjectV1.js';
import type { ActionApprovalPolicyScopeV1 } from '../actionApprovalPolicy.js';
import type { ActionExecutorContext } from './types.js';
import type { ActionSettlementV1 } from './actionSettlement.js';
import { AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1, AutomationActionAdmitRequestV1Schema,
  AutomationActionAdmitResultV1Schema, type AutomationActionAdmitResultV1,
  type AutomationActionAdmitRequestV1 } from '../../automations/automationActionOccurrenceV1.js';
import type { AutomationActionOccurrenceEvidenceV1 } from '../../automations/automationActionOccurrenceV1.js';
import { ActionAutomationTriggerReferenceV1Schema, ActionAutomationConsentReferenceV1Schema,
  ActionAutomationIndexV1Schema, ActionAutomationIndexChangeV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1,
  type ActionAutomationIndexSelectionV1 } from '../../automations/automationActionTriggerV1.js';
import type { ChangeEntry } from '../../changes/index.js';
import { artifactKindsMayIncludeKindV1, readArtifactKindsChangeHintV1 } from '../../changes/index.js';
import { WORKFLOW_DEFINITION_ARTIFACT_KIND_V1 } from '../../artifacts/artifactKindV1.js';
import type { ActionAutomationRunV1, ActionAutomationConsentReviewV1 } from '../../approvals/approvalAutomaticChecks.js';
import type { WorkflowFinalResultV1, WorkflowRunStateV1 } from '../../workflows/workflowProgressV1.js';
import { readActionAutomationExecutionMachineV1 } from './actionSettlement.js';
import type { ActionAutomationNoticeV1 } from '../actionExecutionResult.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { isSharedRequesterActionV1, readActionWorkflowOriginRunIdV1 } from '../actionRequestAttributionV1.js';

export { ActionAutomationTriggerReferenceV1Schema } from '../../automations/automationActionTriggerV1.js';
export { ActionAutomationIndexV1Schema, ActionAutomationIndexChangeV1Schema,
  AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '../../automations/automationActionTriggerV1.js';
export type ActionAutomationTriggerReferenceV1 = z.infer<typeof ActionAutomationTriggerReferenceV1Schema> & Readonly<{
  /** Host-local identity recovered from the admitted matching context, never part of a server tuple. */
  subject?: AutomationSubjectV1;
}>;
export type ActionAutomationConsentReferenceV1 = z.infer<typeof ActionAutomationConsentReferenceV1Schema>;
export type ActionAutomationIndexRowV1 = ActionAutomationTriggerReferenceV1 | ActionAutomationConsentReferenceV1;
export type ActionAutomationIndexChangeV1 = Readonly<{
  automationId: string;
  /** One complete replacement of this Automation's structural rows; empty means removal. */
  rows: readonly ActionAutomationIndexRowV1[];
}>;

/** Both hosts consume the structural tuple carried by the existing Automation update. */
export function readActionAutomationIndexUpdateV1(body: unknown): ActionAutomationIndexChangeV1 | undefined {
  const record = readRecord(body);
  if (record.t === 'automation-delete' && typeof record.automationId === 'string') {
    return { automationId: record.automationId, rows: [] };
  }
  const parsed = ActionAutomationIndexChangeV1Schema.safeParse(record.actionIndex);
  return parsed.success ? parsed.data : undefined;
}
export type ActionAutomationSelectedTriggerV1 = ActionAutomationTriggerReferenceV1 & Readonly<{
  consent?: Readonly<{ status: 'current' | 'missing' | 'stale'; row?: ActionAutomationTriggerReferenceV1;
    review?: ActionAutomationConsentReviewV1 }>;
}>;
export type ActionAutomationConsentResolutionV1 = Readonly<{ current: true; row: ActionAutomationTriggerReferenceV1 }>
  | Readonly<{ current: false; review?: ActionAutomationConsentReviewV1 }>;
export type ActionAutomationSelectionV1 = Readonly<{
  status: 'ready' | 'unavailable';
  subjects: readonly AutomationSubjectContextV1[];
  before: readonly ActionAutomationSelectedTriggerV1[];
  after: readonly ActionAutomationSelectedTriggerV1[];
  notices?: readonly ActionAutomationNoticeV1[];
  /** Account-opened matching belongs to this admitted invocation, never its stored Artifact. */
  privateMatching?: ActionAutomationPrivateMatchingV1;
}>;
export type ActionAutomationPrivateMatchingV1 = (evidence: AutomationActionOccurrenceEvidenceV1,
  selected: readonly ActionAutomationSelectedTriggerV1[]) => Promise<Readonly<{
    matched: readonly ActionAutomationSelectedTriggerV1[];
    notices: readonly ActionAutomationNoticeV1[];
  }>>;
export type ActionAutomationPrepareMatchingV1 = (selection: ActionAutomationSelectionV1,
  context: ActionExecutorContext) => Promise<ActionAutomationPrivateMatchingV1>;

/** A missing private owner is visible; a structural tuple never proves an empty filter. */
export function unavailableActionAutomationMatchingV1(reason: string): ActionAutomationPrivateMatchingV1 {
  return async (_evidence, selected) => ({ matched: [], notices: selected.map(row => ({ code: 'action_automation_skipped',
    reason, automationId: row.automationId, triggerId: row.triggerId, workflowId: row.workflowId })) });
}
export async function matchActionAutomationTriggersV1(selection: ActionAutomationSelectionV1,
  evidence: AutomationActionOccurrenceEvidenceV1, selected: readonly ActionAutomationSelectedTriggerV1[]) {
  return (selection.privateMatching ?? unavailableActionAutomationMatchingV1('privateDefinitionUnavailable'))(evidence, selected);
}
export type ActionAutomationSelectArgsV1 = Readonly<{
  actionId: string;
  input: unknown;
  context: ActionExecutorContext;
  /** ActionSpec placement is the canonical owner of whether this Action has a Machine. */
  executionPlacement?: 'machine' | 'session' | 'account' | 'client';
  approvalScope?: ActionApprovalPolicyScopeV1;
  /** Additional facts from the admitted operand's owner, never guessed from arbitrary input ids. */
  subjects?: readonly AutomationSubjectContextV1[];
  /** Existing Session origin owner; acquired only when this Action bucket needs matching context. */
  loadSubjectFacts?: () => Promise<readonly AutomationSubjectContextV1[]>;
  resolveConsent?: (args: Readonly<{ selection: ActionAutomationSelectedTriggerV1; context: ActionExecutorContext }>)
    => Promise<ActionAutomationConsentResolutionV1>;
  prepareMatching?: ActionAutomationPrepareMatchingV1;
  /** Native completion combines its Action buckets before opening selected private rows once. */
  deferPrivateMatching?: true;
  /** Existing ActionSpec completion declares a later domain event instead of an immediate after bucket. */
  includeAfter?: false;
  /** Terminal native observations consume only after checks, including their selector notices. */
  includeBefore?: false;
  signal?: AbortSignal;
}>;
export type ActionAutomationStartResultV1 = Readonly<{
  runs: readonly ActionAutomationRunV1[];
  notices: readonly ActionAutomationNoticeV1[];
}>;
export type ActionAutomationStartV1 = (args: Readonly<{
  selected: readonly ActionAutomationTriggerReferenceV1[];
  actionId: string;
  input: unknown;
  context: ActionExecutorContext;
  approvalArtifactId?: string;
  result?: import('../actionExecutionResult.js').ActionExecuteResult;
}>) => Promise<ActionAutomationStartResultV1>;
export type ActionAutomationAllowConsentV1 = (args: Readonly<{
  selection: ActionAutomationSelectedTriggerV1;
  context: ActionExecutorContext;
  executionContext: ActionExecutorContext;
  decisionInput: Readonly<{ artifactId: string; decision: 'approve';
    triggerConsent: Readonly<{ automationId: string; triggerId: ActionAutomationTriggerReferenceV1['triggerId']; decision: 'allow' }> }>;
}>) => Promise<ActionAutomationTriggerReferenceV1>;
export type ActionAutomationRunObservationV1 = Readonly<{
  state: WorkflowRunStateV1;
  finalResult?: WorkflowFinalResultV1;
  resultId?: string;
  errorCode?: string | null;
}>;
export type ActionAutomationWaitV1 = (args: Readonly<{
  run: ActionAutomationRunV1;
  context: ActionExecutorContext;
}>) => Promise<ActionAutomationRunObservationV1>;
export type ActionAutomationCancelV1 = (args: Parameters<ActionAutomationWaitV1>[0]) => Promise<void>;
export type ActionAutomationPortV1 = Readonly<{
  prepareMatching?: ActionAutomationPrepareMatchingV1;
  select(args: ActionAutomationSelectArgsV1): Promise<ActionAutomationSelectionV1>;
  hasAfterActions?: (actionIds: readonly string[]) => Promise<boolean>;
  settle(args: Readonly<{ selection: ActionAutomationSelectionV1; event: ActionSettlementV1;
    context: ActionExecutorContext }>): Promise<readonly ActionAutomationNoticeV1[] | void>;
  start?: ActionAutomationStartV1;
  allowConsent?: ActionAutomationAllowConsentV1;
  wait?: ActionAutomationWaitV1;
  cancel?: ActionAutomationCancelV1;
  /** Terminal native Event consumers reuse this port's authenticated occurrence transport. */
  admitOccurrence?: (input: AutomationActionAdmitRequestV1, context: ActionExecutorContext) => Promise<AutomationActionAdmitResultV1>;
}>;

/** The Session binder, approval-scope owner and profile binding supply all identities. */
export function projectActionAutomationSubjectsV1(args: ActionAutomationSelectArgsV1): readonly AutomationSubjectContextV1[] {
  const subjects: AutomationSubjectContextV1[] = [...(args.subjects ?? [])];
  for (const target of args.context.sessionTargetsV1?.targets ?? []) {
    subjects.push({ role: 'operand', subject: { kind: 'session', serverId: target.serverId, sessionId: target.sessionId } });
  }
  const serverId = args.context.serverIdentityId ?? args.context.serverId;
  if (serverId && args.approvalScope) {
    const scope = args.approvalScope;
    subjects.push({ role: 'operand', subject: scope.kind === 'machine'
      ? { kind: 'machine', serverId, machineId: scope.machineId }
      : { kind: 'environment', serverId, environmentId: scope.environmentId } });
  }
  const profile = args.context.approvalProfile;
  if (serverId && profile?.resolution.status === 'available') subjects.push({ role: 'context', subject: {
    kind: 'approvalProfile', serverId, profileId: profile.resolution.requestedId,
  } });
  const unique = new Map<string, AutomationSubjectContextV1>();
  for (const context of subjects) unique.set(`${context.role}:${automationSubjectKeyV1(context.subject)}`, context);
  return Object.freeze([...unique.values()]);
}

/** One Account index; existing transport recovery selects changed scopes or invalidates an unknown snapshot. */
export function createActionAutomationPortV1(options: Readonly<{
  accountId: string;
  seed(): Promise<unknown>;
  refresh?(selection: ActionAutomationIndexSelectionV1): Promise<unknown>;
  subscribe?(apply: (change: ActionAutomationIndexChangeV1) => void, invalidate: () => void): () => void;
  settle: ActionAutomationPortV1['settle'];
  start?: ActionAutomationPortV1['start'];
  allowConsent?: ActionAutomationPortV1['allowConsent'];
}>): ActionAutomationPortV1 & Readonly<{ dispose(): void; reconnect(): void; invalidate(): void; apply(change: ActionAutomationIndexChangeV1): void;
  refreshChanges(changes: readonly Pick<ChangeEntry, 'kind' | 'entityId' | 'hint'>[]): Promise<void>;
  retainConsent(row: ActionAutomationTriggerReferenceV1): void }> {
  const buckets = new Map<string, Set<ActionAutomationTriggerReferenceV1>>();
  const rowsByAutomation = new Map<string, readonly ActionAutomationIndexRowV1[]>();
  const consents = new Map<string, Map<string, ActionAutomationIndexRowV1>>();
  const changedWhileSeeding = new Set<string>();
  let loading: Promise<void> | undefined;
  let state: 'unloaded' | 'loading' | 'ready' | 'unavailable' = 'unloaded';
  let failureReason = 'automation_index_unavailable';
  const invalidate = () => {
    // Unknown secondary-Home recovery has no cursor scopes. Awaiting invocations
    // keep their result; the next admission re-uses the existing seed owner.
    if (state === 'loading') {
      const pending = loading;
      void pending?.then(() => { if (loading === pending) loading = undefined; });
    } else if (state === 'ready' || state === 'unavailable') loading = undefined;
  };
  const consentKey = (row: Readonly<{ automationId: string; triggerId: string }>) => JSON.stringify([row.automationId, row.triggerId]);
  const retainConsentReference = (row: ActionAutomationIndexRowV1) => {
    if (!row.consentFor) return;
    const source = consentKey(row.consentFor);
    let references = consents.get(source);
    if (!references) { references = new Map(); consents.set(source, references); }
    references.set(consentKey(row), row);
  };
  const apply = (change: ActionAutomationIndexChangeV1) => {
    for (const row of rowsByAutomation.get(change.automationId) ?? []) {
      if (row.consentFor) {
        const source = consentKey(row.consentFor);
        const references = consents.get(source);
        references?.delete(consentKey(row));
        if (references?.size === 0) consents.delete(source);
      }
      else if ('actionIds' in row) for (const actionId of row.actionIds) {
        const bucket = buckets.get(actionId);
        bucket?.delete(row);
        if (bucket?.size === 0) buckets.delete(actionId);
      }
    }
    if (change.rows.length === 0) rowsByAutomation.delete(change.automationId);
    else rowsByAutomation.set(change.automationId, change.rows);
    for (const row of change.rows) {
      if (row.consentFor) { retainConsentReference(row); continue; }
      if (!('actionIds' in row)) continue;
      for (const actionId of row.actionIds) {
        let bucket = buckets.get(actionId);
        if (!bucket) { bucket = new Set(); buckets.set(actionId, bucket); }
        bucket.add(row);
      }
    }
  };
  let unsubscribe: (() => void) | undefined;
  const readRows = async (read: () => Promise<unknown>, selection?: ActionAutomationIndexSelectionV1) => {
    state = 'loading';
    try {
      const seed = ActionAutomationIndexV1Schema.parse(await read());
      const grouped = new Map<string, ActionAutomationIndexRowV1[]>();
      for (const row of seed.rows) {
        const group = grouped.get(row.automationId) ?? [];
        group.push(row); grouped.set(row.automationId, group);
      }
      if (selection) {
        const automationIds = new Set(selection.automationIds);
        const workflowIds = new Set(selection.workflowDefinitionIds);
        for (const [automationId, rows] of rowsByAutomation) {
          if (!changedWhileSeeding.has(automationId)
            && (automationIds.has(automationId) || rows.some(row => workflowIds.has(row.workflowId)))) {
            apply({ automationId, rows: [] });
          }
        }
      }
      for (const [automationId, rows] of grouped) if (!changedWhileSeeding.has(automationId)) apply({ automationId, rows });
      state = 'ready';
    } catch (error) {
      // Report only a typed boundary code. Exception text may contain private HTTP data.
      if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') failureReason = error.code;
      state = 'unavailable';
    } finally { changedWhileSeeding.clear(); }
  };
  const load = () => loading ??= readRows(async () => {
    unsubscribe = options.subscribe?.(change => {
      if (state === 'unloaded' || state === 'loading') changedWhileSeeding.add(change.automationId);
      apply(change);
    }, invalidate);
    return await options.seed();
  });
  const resetIndex = () => {
    unsubscribe?.();
    unsubscribe = undefined;
    loading = undefined;
    state = 'unloaded';
    failureReason = 'automation_index_unavailable';
    buckets.clear(); rowsByAutomation.clear(); consents.clear(); changedWhileSeeding.clear();
  };
  const ensureLoaded = async (signal?: AbortSignal, progress?: ActionExecutorContext['operationProgress']): Promise<void> => {
      signal?.throwIfAborted();
      if ((state === 'unavailable' || state === 'ready') && loading === undefined) resetIndex();
      if (state === 'unloaded' || state === 'loading') {
        progress?.update({ label: 'Checking automations…' });
        const pending = load();
        if (signal) {
          await new Promise<void>((resolve, reject) => {
            const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
            signal.addEventListener('abort', abort, { once: true });
            pending.then(() => { signal.removeEventListener('abort', abort); resolve(); }, reject);
            if (signal.aborted) abort();
          });
        } else await pending;
      }
      signal?.throwIfAborted();
  };
  return {
    async hasAfterActions(actionIds: readonly string[]) {
      await ensureLoaded();
      if (state === 'unavailable') throw new Error(failureReason);
      return actionIds.some(actionId => [...(buckets.get(actionId) ?? [])].some(row => row.phase === 'after'));
    },
    async select(args) {
      const signal = args.signal ?? args.context.signal;
      await ensureLoaded(signal, args.context.operationProgress);
      if (state === 'unavailable') return { status: 'unavailable', subjects: projectActionAutomationSubjectsV1(args), before: [], after: [],
        notices: [{ code: 'action_automations_not_checked', reason: failureReason }] };
      const before: ActionAutomationSelectedTriggerV1[] = [];
      const after: ActionAutomationSelectedTriggerV1[] = [];
      const notices: ActionAutomationNoticeV1[] = [];
      // One Action bucket read serves both phases; matching consumes C1 identities.
      const candidates = [...(buckets.get(args.actionId) ?? [])];
      let additionalSubjects: readonly AutomationSubjectContextV1[] = [];
      if (args.loadSubjectFacts && candidates.some(row => args.includeAfter !== false || row.phase !== 'after')) {
        additionalSubjects = await args.loadSubjectFacts();
        signal?.throwIfAborted();
      }
      const subjects = projectActionAutomationSubjectsV1({ ...args, subjects: [...(args.subjects ?? []), ...additionalSubjects] });
      const machineId = args.executionPlacement === undefined || args.executionPlacement === 'machine' || args.executionPlacement === 'session'
        ? readActionAutomationExecutionMachineV1(args.context) : undefined;
      const sharedRequester = isSharedRequesterActionV1(args.context);
      for (const row of candidates) {
        if (row.phase === 'after' && args.includeAfter === false) continue;
        if (row.phase === 'before' && args.includeBefore === false) continue;
        const own = row.ownerAccountId === options.accountId;
        const subjectKey = row.subjectKey;
        const matchedSubject = subjectKey ? subjects.find(context =>
          automationSubjectKeyMatchesV1(subjectKey, [context], own ? undefined : row.workflowId))?.subject : undefined;
        if (own ? row.subjectKey !== undefined && !matchedSubject : !row.reachesOthers || !matchedSubject) continue;
        const skip = (reason: string) => notices.push({ code: 'action_automation_skipped', reason,
          automationId: row.automationId, triggerId: row.triggerId, workflowId: row.workflowId });
        if (!machineId) {
          // A person may explicitly override a light check, but an automatic
          // before/wait admission cannot turn a missing Machine into success.
          if (args.context.authority === 'account_automation' && row.phase === 'before' && row.mode !== 'notify') {
            return Object.freeze({ status: 'unavailable' as const, subjects, before: [], after: [],
              notices: [{ code: 'action_automations_not_checked' as const, reason: 'machineRequired' }] });
          }
          skip('machineRequired'); continue;
        }
        const references = own ? [] : [...(consents.get(consentKey(row))?.values() ?? [])];
        // Equal revisions avoid a Workflow read at the incumbent private consent
        // owner. Ordering never proves consent current; every candidate is opened there.
        references.sort((left, right) => Number(right.consentedWorkflowRevision === row.workflowRevision)
          - Number(left.consentedWorkflowRevision === row.workflowRevision));
        const consent = references[0];
        const reference = matchedSubject ? { ...row, subject: matchedSubject } : row;
        let selected: ActionAutomationSelectedTriggerV1 = own ? reference : { ...reference, consent: {
          status: consent ? 'stale' : 'missing', ...(consent ? { row: { ...reference, ...consent } } : {}),
        } };
        if (!own && consent && args.resolveConsent) {
          for (const candidate of references) {
            const current = await args.resolveConsent({ selection: { ...reference,
              consent: { status: 'stale', row: { ...reference, ...candidate } } }, context: args.context });
            signal?.throwIfAborted();
            if (current.current) {
              retainConsentReference(current.row);
              selected = { ...reference, consent: { status: 'current', row: current.row } };
              break;
            }
            if (current.review && candidate === consent) {
              selected = { ...reference, consent: { status: 'stale', row: { ...reference, ...candidate }, review: current.review } };
            }
          }
        }
        if (!own && sharedRequester && selected.consent?.status !== 'current') {
          skip('actorConsentUnavailableForRequester');
          continue;
        }
        (row.phase === 'before' ? before : after).push(selected);
      }
      const selection: ActionAutomationSelectionV1 = { status: 'ready', subjects, before: Object.freeze(before), after: Object.freeze(after),
        notices: Object.freeze(notices) };
      return Object.freeze({ ...selection,
        ...(args.prepareMatching && !args.deferPrivateMatching && (before.length || after.length)
          ? { privateMatching: await args.prepareMatching(selection, args.context) } : {}) });
    },
    async settle(args) { if (args.selection.after.length > 0) return await options.settle(args); },
    ...(options.start ? { start: options.start } : {}),
    ...(options.allowConsent ? { allowConsent: options.allowConsent } : {}),
    apply(change) { if (state === 'unloaded' || state === 'loading') changedWhileSeeding.add(change.automationId); apply(change); },
    async refreshChanges(changes) {
      const refresh = options.refresh;
      if (!refresh || state === 'unloaded' || state === 'unavailable' || state === 'ready' && loading === undefined) return;
      const selection: ActionAutomationIndexSelectionV1 = {
        automationIds: [...new Set(changes.filter(change => change.kind === 'automation').map(change => change.entityId))],
        workflowDefinitionIds: [...new Set(changes.filter(change => change.kind === 'artifact'
          && artifactKindsMayIncludeKindV1(readArtifactKindsChangeHintV1(change.hint), [WORKFLOW_DEFINITION_ARTIFACT_KIND_V1]))
          .map(change => change.entityId))],
      };
      if (selection.automationIds.length === 0 && selection.workflowDefinitionIds.length === 0) return;
      if (state === 'loading') await loading;
      if (state !== 'ready') return;
      loading = readRows(() => refresh(selection), selection);
      await loading;
    },
    retainConsent(row) {
      if (!row.consentFor) return;
      retainConsentReference(row);
      const existing = rowsByAutomation.get(row.automationId) ?? [];
      rowsByAutomation.set(row.automationId, [...existing.filter(item => item.triggerId !== row.triggerId), row]);
    },
    reconnect() {
      // The existing transport owns this boundary. A failure from a seed already
      // in flight on the old connection must also be retryable at next admission.
      // Keep its unavailable result visible to invocations already awaiting it.
      if (state === 'loading') {
        const pending = loading;
        void pending?.then(() => { if (state === 'unavailable' && loading === pending) loading = undefined; });
      } else if (state === 'unavailable') loading = undefined;
    },
    invalidate,
    dispose() { unsubscribe?.(); buckets.clear(); rowsByAutomation.clear(); consents.clear(); },
  };
}

/** Admission outcomes name the executing reference; notices retain the selected source identity. */
export function projectActionAutomationAdmitOutcomesV1(response: AutomationActionAdmitResultV1,
  admitted: readonly Readonly<{ row: ActionAutomationSelectedTriggerV1; trigger: ActionAutomationTriggerReferenceV1 }>[]): ActionAutomationStartResultV1 {
  const originalReferences = new Map(admitted.map(({ row, trigger }) =>
    [JSON.stringify([trigger.automationId, trigger.triggerId]), row] as const));
  const runs: ActionAutomationRunV1[] = [];
  const notices: ActionAutomationNoticeV1[] = [];
  for (const result of response.results) {
    const source = originalReferences.get(JSON.stringify([result.automationId, result.triggerId]));
    if (!source) continue;
    if (result.kind === 'skipped') notices.push({ code: 'action_automation_skipped', reason: result.reason,
      automationId: source.automationId, triggerId: source.triggerId, workflowId: source.workflowId });
    else runs.push({ automationId: source.automationId, triggerId: source.triggerId, runId: result.runId });
  }
  return { runs, notices };
}

/** Both hosts share occurrence construction; adapters supply only their existing authenticated HTTP owner. */
export function createActionAutomationHttpPortV1(options: Readonly<{
  accountId: string;
  request(path: string, init: Readonly<{ method: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal }>): Promise<unknown>;
  subscribe?: Parameters<typeof createActionAutomationPortV1>[0]['subscribe'];
  allowConsent?: ActionAutomationAllowConsentV1;
}>): ReturnType<typeof createActionAutomationPortV1> {
  const admitOccurrence: NonNullable<ActionAutomationPortV1['admitOccurrence']> = async (input, context) => (
    AutomationActionAdmitResultV1Schema.parse(await options.request(AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1,
      { method: 'POST', body: AutomationActionAdmitRequestV1Schema.parse(input), signal: context.signal }))
  );
  const port = createActionAutomationPortV1({ accountId: options.accountId,
    seed: () => options.request(AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, { method: 'GET' }),
    refresh: selection => options.request(AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, { method: 'POST', body: selection }),
    subscribe: options.subscribe,
    ...(options.allowConsent ? { allowConsent: options.allowConsent } : {}),
    start: async ({ selected, actionId, context }) => {
      const selection = context.actionAutomationAdmission?.selection;
      const requestId = context.actionRequestId;
      if (!selection || !requestId || selected.length === 0) return { runs: [], notices: [] };
      const selectedKeys = new Set(selected.map(row => JSON.stringify([row.automationId, row.triggerId])));
      const admitted = selection.before.flatMap(row => {
        if (!selectedKeys.has(JSON.stringify([row.automationId, row.triggerId]))) return [];
        const trigger = row.ownerAccountId === options.accountId ? row
          : row.consent?.status === 'current' ? row.consent.row : undefined;
        return trigger ? [{ row, trigger }] : [];
      });
      if (admitted.length === 0) return { runs: [], notices: [] };
      const machineId = readActionAutomationExecutionMachineV1(context);
      const originRunId = readActionWorkflowOriginRunIdV1(context);
      const body = AutomationActionAdmitRequestV1Schema.parse({
        triggers: admitted.map(({ trigger }) => ({ automationId: trigger.automationId,
          triggerId: trigger.triggerId, triggerRevision: trigger.triggerRevision })),
        evidence: { v: 1, kind: 'action', actionId, requestId, phase: 'before', occurredAt: Date.now(),
          ...(machineId ? { machineId } : {}), ...(originRunId ? { originRunId } : {}),
          subjects: selection.subjects.map(({ role, subject }) => ({ role, kind: subject.kind, key: automationSubjectKeyV1(subject) })),
        },
      });
      const matching = await matchActionAutomationTriggersV1(selection, body.evidence, admitted.map(item => item.row));
      const matched = admitted.filter(item => matching.matched.includes(item.row));
      if (matched.length === 0) return { runs: [], notices: matching.notices };
      const response = await admitOccurrence({ ...body, triggers: matched.map(({ trigger }) => ({
        automationId: trigger.automationId, triggerId: trigger.triggerId, triggerRevision: trigger.triggerRevision,
      })) }, context);
      const outcomes = projectActionAutomationAdmitOutcomesV1(response, matched);
      return { ...outcomes, notices: [...matching.notices, ...outcomes.notices] };
    },
    settle: async ({ selection, event, context }) => {
      const admitted = selection.after.flatMap(row => {
        const trigger = row.ownerAccountId === options.accountId ? row
          : row.consent?.status === 'current' ? row.consent.row : undefined;
        return trigger ? [{ row, trigger }] : [];
      });
      if (admitted.length === 0) return;
      const triggers = admitted.map(({ trigger }) => ({ automationId: trigger.automationId,
        triggerId: trigger.triggerId, triggerRevision: trigger.triggerRevision }));
      const input = AutomationActionAdmitRequestV1Schema.parse({ triggers, evidence: {
        v: 1, kind: 'action', actionId: event.actionId, requestId: event.requestId,
        phase: event.phase, status: event.status, ...(event.outcome === undefined ? {} : { outcome: event.outcome }), ...(event.errorCode ? { errorCode: event.errorCode } : {}),
        ...(event.originRunId ? { originRunId: event.originRunId } : {}),
        ...(event.machineId ? { machineId: event.machineId } : {}), occurredAt: event.occurredAt,
        subjects: selection.subjects.map(({ role, subject }) => ({ role, kind: subject.kind, key: automationSubjectKeyV1(subject) })),
      } });
      const matching = await matchActionAutomationTriggersV1(selection, input.evidence, admitted.map(item => item.row));
      const matched = admitted.filter(item => matching.matched.includes(item.row));
      if (matched.length === 0) return matching.notices;
      const response = await admitOccurrence({ ...input, triggers: matched.map(({ trigger }) => ({
        automationId: trigger.automationId, triggerId: trigger.triggerId, triggerRevision: trigger.triggerRevision,
      })) }, context);
      return [...matching.notices, ...projectActionAutomationAdmitOutcomesV1(response, matched).notices];
    },
  });
  return { ...port, admitOccurrence };
}
