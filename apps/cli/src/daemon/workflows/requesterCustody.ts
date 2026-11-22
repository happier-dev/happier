import type { ActionExecutorContext, ApprovalExecutionOriginV1 } from '@happier-dev/protocol';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createCredentialedWorkflowActionAdmissionReader, readWorkflowActionInvocationEffect } from './workflowActionAdmission';
import type { StoredCredentials } from '@/persistence';
import { AsyncLock } from '@/utils/lock';
import { z } from 'zod/mini';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { getAutomationDefinition } from '@/api/automations';
import { observeAccountChanges, type AccountChangeNotification } from '@/api/observeAccountChanges';
import { ChangeKindSchema } from '@happier-dev/protocol/changes';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from '@happier-dev/protocol/actions/externalActionLimits';
import { isTerminalAutomationRunStateV3 } from '@happier-dev/protocol/automations/automationRunStateV3';
import { WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { SessionInitialTriggerAdmissionV1 } from '@happier-dev/protocol/sessions/creation/sessionInitialTriggerAdmissionV1';
import type { RequesterWorkAttributionV1 } from '../lifecycle/requesterWorkAttribution';
import { readPrivateOwnerFile, replacePrivateBearerFile } from '../privateBearerFile';
import { createWorkflowRunStorageClient } from './workflowRunStorageClient';
import { CustodyStoredReadSchema } from '../sessionEncryption/requesterSessionCustody';
import { createRequesterSessionCredentialCustody, listRequesterSessionCredentialBindings, requesterSessionCredentialPath, resolveRequesterSessionCredentials, retireRequesterSessionCredentialCustody } from '../sessionEncryption/requesterSessionCredentials';

type ScopeBinding = Readonly<{ happyHomeDir: string; serverId: string; machineId: string; installationId: string; scopeId: string;
  accountId?: string; homeServerIdentityId?: string; serverHttpBaseUrl?: string; signal?: AbortSignal }>;
const activeScopes = new Map<string, { count: number; retire: boolean }>();
// Serialize local edits while the Home inventory read runs outside the lock.
const custodyMutation = new AsyncLock();
const custodyChanges = new Set<() => void>();
const notifyCustodyChange = () => { for (const listener of custodyChanges) listener(); };
const binding = (input: ScopeBinding, attribution: RequesterWorkAttributionV1) => ({ happyHomeDir: input.happyHomeDir,
  sessionId: input.scopeId, attribution, scope: 'workflow_trigger' as const });

function holdExecutionScope(input: ScopeBinding, value: ReturnType<typeof binding>, retire = false) {
  const path = requesterSessionCredentialPath(value);
  const active = activeScopes.get(path) ?? { count: 0, retire };
  active.count++;
  activeScopes.set(path, active);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    active.count--;
    if (active.count) return;
    if (active.retire) await settleWorkflowRequesterCredentialRetirement(input);
    else activeScopes.delete(path);
  };
}

export async function listWorkflowRequesterCredentialScopes(input: Omit<ScopeBinding, 'scopeId'>) {
  return await listRequesterSessionCredentialBindings({ ...input, scope: 'workflow_trigger' });
}

export async function retainWorkflowRequesterCredentials(input: Readonly<{
  scopeId: string; credentials: StoredCredentials; attribution: RequesterWorkAttributionV1; happyHomeDir: string; homeServerIdentityId?: string; automationId?: string;
  machineAdmission?: SavedSecretOperationContextV1['machineAdmission'];
}>): Promise<Awaited<ReturnType<typeof createRequesterSessionCredentialCustody>>> {
  if (input.machineAdmission && input.machineAdmission.actorAccountId !== input.attribution.accountId) {
    throw new Error('requester_session_custody_mismatch');
  }
  const retained = await custodyMutation.inLock(async () => {
    const original = await readBinding({ ...input.attribution, happyHomeDir: input.happyHomeDir,
      scopeId: input.scopeId, homeServerIdentityId: input.homeServerIdentityId });
    const alreadyPublished = original && original.stored.automationId === input.automationId
      && !original.stored.automationScopePending && !original.stored.retireWhenIdle;
    // Trigger custody is installed before Home publishes it. Direct Runs
    // keep the admission they first captured, including an unavailable role.
    const record = await createRequesterSessionCredentialCustody({ ...input,
      ...(input.automationId && !alreadyPublished ? { automationScopePending: true } : {}),
      machineAdmission: !input.automationId && original ? original.stored.machineAdmission : input.machineAdmission,
      sessionId: input.scopeId, scope: 'workflow_trigger' });
    const active = activeScopes.get(record.path);
    if (active) active.retire = false;
    return record;
  });
  notifyCustodyChange();
  return { ...retained, cleanup: async () => {
    await custodyMutation.inLock(retained.cleanup);
    notifyCustodyChange();
  } };
}

/** Action owners know only their admitted requester and the execution target. */
export function createWorkflowRequesterCustody(input: Omit<Parameters<typeof retainWorkflowRequesterCredentials>[0], 'scopeId'>
  & Readonly<{ serverHttpBaseUrl: string }>) {
  return {
    retainInitialTriggers: async (initialTriggers: readonly SessionInitialTriggerAdmissionV1[]) =>
      await retainWorkflowInitialTriggerCredentials({ ...input, initialTriggers }),
    retain: async ({ scopeId, machineId, automationId }: Readonly<{ scopeId: string; machineId: string; automationId?: string }>) => {
      if (machineId === input.attribution.machineId) await retainWorkflowRequesterCredentials({ ...input, scopeId, automationId });
    },
    retire: async ({ scopeId, machineId }: Readonly<{ scopeId: string; machineId: string }>, options?: Readonly<{ signal?: AbortSignal }>) => {
      if (machineId === input.attribution.machineId) await retireWorkflowRequesterCredentials({ ...input,
        ...input.attribution, scopeId, signal: options?.signal });
    },
  };
}

type InitialTrigger = SessionInitialTriggerAdmissionV1['triggers'][number];
export async function retainWorkflowInitialTriggerCredentials(input: Omit<Parameters<typeof retainWorkflowRequesterCredentials>[0], 'scopeId'>
  & Readonly<{ initialTriggers: readonly (Pick<SessionInitialTriggerAdmissionV1, 'automationId' | 'enabled' | 'assignments'> & {
    triggers: readonly (Pick<InitialTrigger, 'triggerId'> & { trigger: Pick<InitialTrigger['trigger'], 'enabled'> })[];
  })[] }>): Promise<Readonly<{ cleanupOnFailure(): Promise<void> }>> {
  const cleanups: (() => Promise<void>)[] = [];
  const cleanupOnFailure = async () => { for (const cleanup of cleanups) await cleanup(); };
  try {
    for (const admission of input.initialTriggers) {
      if (!admission.enabled || !admission.assignments?.some(assignment => assignment.machineId === input.attribution.machineId
        && assignment.enabled !== false)) continue;
      for (const trigger of admission.triggers) if (trigger.trigger.enabled) {
        const retained = await retainWorkflowRequesterCredentials({ ...input, scopeId: trigger.triggerId, automationId: admission.automationId });
        cleanups.push(retained.cleanup);
      }
    }
    return { cleanupOnFailure };
  } catch (error) {
    await cleanupOnFailure();
    throw error;
  }
}

async function readBinding(input: ScopeBinding) {
  const path = requesterSessionCredentialPath({ happyHomeDir: input.happyHomeDir, sessionId: input.scopeId,
    attribution: { serverId: input.serverId }, scope: 'workflow_trigger' });
  try {
    const stored = CustodyStoredReadSchema.parse(JSON.parse(await readPrivateOwnerFile(path)) as unknown);
    if (stored.attribution.serverId !== input.serverId || stored.attribution.machineId !== input.machineId
      || stored.attribution.installationId !== input.installationId
      || input.accountId !== undefined && stored.attribution.accountId !== input.accountId
      || input.homeServerIdentityId !== undefined && stored.homeServerIdentityId !== input.homeServerIdentityId) return null;
    if (stored.scope !== 'workflow_trigger' || stored.sessionId !== input.scopeId) return null;
    return { path, stored, value: binding(input, stored.attribution) };
  } catch { return null; }
}

async function markWorkflowRequesterCredentialsForRetirement(record: NonNullable<Awaited<ReturnType<typeof readBinding>>>): Promise<void> {
  const active = activeScopes.get(record.path) ?? { count: 0, retire: true };
  active.retire = true;
  activeScopes.set(record.path, active);
  await replacePrivateBearerFile({ path: record.path, contents: JSON.stringify({ ...record.stored, retireWhenIdle: true }) });
}

export async function retireWorkflowRequesterCredentials(input: ScopeBinding): Promise<void> {
  await custodyMutation.inLock(async () => {
    const record = await readBinding(input);
    if (record) await markWorkflowRequesterCredentialsForRetirement(record);
  });
  await settleWorkflowRequesterCredentialRetirement(input);
}

const RunPageSchema = z.object({ runs: z.array(WorkflowRunSummaryV1Schema), nextCursor: z.optional(z.string()) });

/** Reconnect consumes the exact saved schedule; an unknown pending admission is retained. */
export async function reconcileWorkflowRequesterCredentialScope(input: ScopeBinding): Promise<void> {
  const stored = await readBinding(input);
  if (!stored) return;
  if (stored.stored.retireWhenIdle) return await settleWorkflowRequesterCredentialRetirement(input);
  const serverHttpBaseUrl = input.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const credentials = await resolveRequesterSessionCredentials({ ...stored.value, serverHttpBaseUrl,
    verifyMachineAdmissionCurrent: async () => true, signal: input.signal });
  if (!credentials) return;
  const automationId = stored.stored.automationId;
  if (automationId) {
    const automation = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => getAutomationDefinition({
      token: credentials.token, automationId, signal: input.signal,
    }));
    const published = !!automation?.enabled
      && automation.assignments.some(assignment => assignment.machineId === input.machineId && assignment.enabled)
      && automation.triggers.some(trigger => trigger.id === input.scopeId && trigger.enabled);
    // Until Home has published this exact binding, absence could mean either
    // an in-flight Save or an unresolved write. The author rolls back refusals.
    const pending = stored.stored.automationScopePending === true;
    if (pending ? !published : published) return;
    const retired = await custodyMutation.inLock(async () => {
      input.signal?.throwIfAborted();
      const current = await readBinding(input);
      if (!current || !sameStrictJsonValue(current.stored, stored.stored)) return false;
      if (published) {
        await replacePrivateBearerFile({
          path: current.path, contents: JSON.stringify({ ...current.stored, automationScopePending: undefined }),
        });
        return false;
      }
      await markWorkflowRequesterCredentialsForRetirement(current);
      return true;
    });
    if (retired) await settleWorkflowRequesterCredentialRetirement(input);
    return;
  }
  const storage = createWorkflowRunStorageClient({ token: credentials.token, serverHttpBaseUrl });
  let cursor: string | undefined;
  do {
    const page = RunPageSchema.parse(await storage.execute({ operation: 'list', request: {
      runId: input.scopeId, machineId: input.machineId, ...(cursor ? { cursor } : {}),
    }, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES }, { signal: input.signal }));
    if (page.runs.some(run => run.id === input.scopeId && isTerminalAutomationRunStateV3(run.state)
      && run.workflowCustodyState !== 'pending')) {
      await retireWorkflowRequesterCredentials(input);
      return;
    }
    cursor = page.nextCursor;
  } while (cursor);
}

/** A disable retires future use; already admitted queued/active work keeps custody. */
export async function settleWorkflowRequesterCredentialRetirement(input: ScopeBinding): Promise<void> {
  const stored = await readBinding(input);
  if (!stored?.stored.retireWhenIdle) return;
  const active = activeScopes.get(stored.path) ?? { count: 0, retire: true };
  activeScopes.set(stored.path, active);
  if (!active.retire || active.count) return;
  const serverHttpBaseUrl = input.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const credentials = await resolveRequesterSessionCredentials({ ...stored.value, serverHttpBaseUrl,
    verifyMachineAdmissionCurrent: async () => true, signal: input.signal });
  if (!credentials) { activeScopes.delete(stored.path); return; }
  const storage = createWorkflowRunStorageClient({ token: credentials.token, serverHttpBaseUrl });
  let cursor: string | undefined;
  do {
    const page = RunPageSchema.parse(await storage.execute({ operation: 'list', request: {
      ...(stored.stored.automationId ? { triggerId: input.scopeId } : { runId: input.scopeId }),
      machineId: input.machineId, ...(cursor ? { cursor } : {}),
    }, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES }, { signal: input.signal }));
    if (page.runs.some(run => !isTerminalAutomationRunStateV3(run.state) || run.workflowCustodyState === 'pending')) return;
    cursor = page.nextCursor;
  } while (cursor);
  // A re-save clears this same scope's retirement intent, including while the
  // admitted-work inventory was in flight.
  await custodyMutation.inLock(async () => {
    if (activeScopes.get(stored.path) !== active || !active.retire || active.count) return;
    await retireRequesterSessionCredentialCustody(stored.value);
    activeScopes.delete(stored.path);
    notifyCustodyChange();
  });
}

/** The incumbent guest Account socket lives only while this installation holds its custody. */
export function observeWorkflowRequesterCredentialCustody(input: Omit<ScopeBinding, 'scopeId'> & Readonly<{
  hostAccountId: string; onError(error: unknown): void;
}>): Readonly<{ dispose(): void }> {
  type Scope = Extract<Awaited<ReturnType<typeof listWorkflowRequesterCredentialScopes>>, { status: 'ready' }>['bindings'][number];
  type Observation = { token: string; dispose(): Promise<void>; updateScopes(scopes: readonly Scope[]): void };
  const observations = new Map<string, Observation>();
  let disposed = false;
  let refreshing = false;
  let refreshPending = false;
  const refresh = async () => {
    refreshPending = true;
    if (refreshing) return;
    refreshing = true;
    try {
      while (refreshPending && !disposed) {
        refreshPending = false;
        const inventory = await listWorkflowRequesterCredentialScopes(input);
        if (inventory.status !== 'ready') throw new Error(inventory.reason);
        const accounts = new Map<string, Array<(typeof inventory.bindings)[number]>>();
        for (const scope of inventory.bindings) if (scope.attribution.accountId !== input.hostAccountId) {
          const account = accounts.get(scope.attribution.accountId) ?? [];
          account.push(scope);
          accounts.set(scope.attribution.accountId, account);
        }
        for (const [accountId, observation] of observations) if (!accounts.has(accountId)) {
          observations.delete(accountId);
          await observation.dispose();
        }
        for (const [accountId, scopes] of accounts) {
          if (disposed) break;
          let credentials: StoredCredentials | null = null;
          for (const scope of scopes) {
            const stored = await readBinding({ ...input, accountId, scopeId: scope.sessionId });
            if (stored) credentials = await resolveRequesterSessionCredentials({ ...stored.value,
              serverHttpBaseUrl: input.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(), verifyMachineAdmissionCurrent: async () => true, signal: input.signal });
            if (credentials || disposed) break;
          }
          if (disposed) break;
          const previous = observations.get(accountId);
          if (!credentials || previous && previous.token !== credentials.token) {
            observations.delete(accountId);
            await previous?.dispose();
          }
          if (!credentials) continue;
          const existing = observations.get(accountId);
          if (existing) { existing.updateScopes(scopes); continue; }
          let running = false;
          const cancellation = new AbortController();
          let accountScopes = new Map(scopes.map(scope => [scope.sessionId, scope]));
          const pending = new Set<string>();
          const enqueue = (targets: Iterable<Scope>) => {
            for (const scope of targets) pending.add(scope.sessionId);
            if (!pending.size || running || cancellation.signal.aborted) return;
            running = true;
            void (async () => {
              while (pending.size && !cancellation.signal.aborted) {
                const scopeId = pending.values().next().value!;
                pending.delete(scopeId);
                if (accountScopes.has(scopeId))
                  await reconcileWorkflowRequesterCredentialScope({ ...input, accountId, scopeId, signal: cancellation.signal });
              }
            })().catch(error => { if (!cancellation.signal.aborted) input.onError(error); }).finally(() => {
              running = false;
              if (pending.size && !cancellation.signal.aborted) enqueue([]);
            });
          };
          const invalidate = (change?: AccountChangeNotification) => {
            if (change && change.t !== 'account-change') return;
            // Missing or future hints are coarse gaps. Known typed changes
            // select only custody already associated with their producer ids.
            if (!change || !change.changeKinds || !change.entityIds
              || change.changeKinds.some(kind => !ChangeKindSchema.safeParse(kind).success)) {
              enqueue(accountScopes.values());
              return;
            }
            const kinds = change.changeKinds;
            const ids = new Set(change.entityIds);
            enqueue([...accountScopes.values()].filter(scope => scope.automationId
              ? kinds.includes('automation') && ids.has(scope.automationId)
              : kinds.includes('account') && ids.has(`workflow-run:${scope.sessionId}`)));
          };
          const observation = observeAccountChanges({ token: credentials.token, serverUrl: input.serverHttpBaseUrl },
            { onChange: invalidate, onError: input.onError });
          if (disposed) { await observation.dispose(); break; }
          observations.set(accountId, { token: credentials.token, dispose: async () => {
            cancellation.abort();
            await observation.dispose();
          }, updateScopes: next => {
            const added = next.filter(scope => !accountScopes.has(scope.sessionId)
              || accountScopes.get(scope.sessionId)?.automationId !== scope.automationId);
            accountScopes = new Map(next.map(scope => [scope.sessionId, scope]));
            enqueue(added);
          } });
        }
      }
    } finally { refreshing = false; }
  };
  const changed = () => { void refresh().catch(input.onError); };
  custodyChanges.add(changed);
  changed();
  return { dispose: () => {
    disposed = true;
    custodyChanges.delete(changed);
    for (const observation of observations.values()) void observation.dispose().catch(input.onError);
    observations.clear();
  } };
}

export async function acquireWorkflowRequesterCredentials(input: ScopeBinding & Readonly<{ serverHttpBaseUrl: string }>) {
  const stored = await readBinding(input);
  if (!stored) return null;
  const credentials = await resolveRequesterSessionCredentials({ ...stored.value, serverHttpBaseUrl: input.serverHttpBaseUrl,
    // Admission was decided for this occurrence by Home. Recovery binds the
    // private file to the installed daemon; it does not re-evaluate grants.
    verifyMachineAdmissionCurrent: async () => true, signal: input.signal });
  if (!credentials) return null;
  return { credentials, attribution: stored.value.attribution,
    ...(stored.stored.machineAdmission ? { machineAdmission: {
      actorAccountId: stored.value.attribution.accountId, ...stored.stored.machineAdmission } } : {}),
    release: holdExecutionScope(input, stored.value, stored.stored.retireWhenIdle) };
}


/** Durable native consent reopens the original Run's private custody, never the deciding person's context. */
export async function acquireWorkflowApprovalRequester(input: Readonly<{
  credentials: StoredCredentials; serverHttpBaseUrl: string; happyHomeDir: string; installationId: string;
  origin: ApprovalExecutionOriginV1; qualifiedActionId: string; actionInput: unknown; signal?: AbortSignal;
}>): Promise<Readonly<{ context: Pick<ActionExecutorContext, 'admittedHostWorkflowRequester' | 'verifyMachineAdmissionCurrent'
  | 'executionRunWorkflowRunId' | 'actionRequestId'>; release(): Promise<void> }> | null> {
  const origin = input.origin;
  if (origin.caller.kind !== 'workflowRun' || origin.caller.authorization.principal.kind !== 'host'
    || origin.externalActionExecutionAuthorization || !origin.accountId || !origin.machineId || !origin.serverIdentityId) return null;
  const runId = origin.caller.runId;
  const context = { runtimeAccountId: origin.accountId, actionCaller: origin.caller, executionRunWorkflowRunId: runId,
    actionRequestId: origin.requestId, ...(input.signal ? { signal: input.signal } : {}) };
  const admission = await createCredentialedWorkflowActionAdmissionReader(input)({ runId, context, phase: 'approval_replay' });
  const invocation = await admission?.readActionInvocation('approval_replay');
  const execution = invocation?.progress.execution;
  const effect = readWorkflowActionInvocationEffect(execution);
  if (!admission || admission.run.machineId !== origin.machineId || execution?.kind !== 'action'
    || execution.actionRequestId !== origin.requestId || effect?.actionId !== input.qualifiedActionId
    || !sameStrictJsonValue(effect.input, input.actionInput)) return null;
  const retained = await acquireWorkflowRequesterCredentials({ happyHomeDir: input.happyHomeDir, serverId: origin.serverId,
    machineId: origin.machineId, installationId: input.installationId, scopeId: runId,
    accountId: origin.accountId, homeServerIdentityId: origin.serverIdentityId,
    serverHttpBaseUrl: input.serverHttpBaseUrl, signal: input.signal });
  if (!retained) return null;
  if (!retained.machineAdmission?.role) { await retained.release(); return null; }
  return { context: { executionRunWorkflowRunId: runId, actionRequestId: origin.requestId,
    admittedHostWorkflowRequester: { ...retained.machineAdmission, role: retained.machineAdmission.role,
      machineId: retained.attribution.machineId, installationId: retained.attribution.installationId },
    // The exact admitted Run was opened above. Finite replay follows its local cancellation signal.
    verifyMachineAdmissionCurrent: async signal => !input.signal?.aborted && !signal?.aborted }, release: retained.release };
}
