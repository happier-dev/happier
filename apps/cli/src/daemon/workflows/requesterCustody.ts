import type { StoredCredentials } from '@/persistence';
import { z } from 'zod/mini';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { getAutomationDefinition } from '@/api/automations';
import { observeAccountChanges } from '@/api/observeAccountChanges';
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
  accountId?: string; homeServerIdentityId?: string; serverHttpBaseUrl?: string }>;
const activeScopes = new Map<string, { count: number; retire: boolean }>();
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
}>): Promise<Awaited<ReturnType<typeof createRequesterSessionCredentialCustody>>> {
  const retained = await createRequesterSessionCredentialCustody({ ...input, sessionId: input.scopeId, scope: 'workflow_trigger' });
  const active = activeScopes.get(retained.path);
  if (active) active.retire = false;
  notifyCustodyChange();
  return { ...retained, cleanup: async () => { await retained.cleanup(); notifyCustodyChange(); } };
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
    retire: async ({ scopeId, machineId }: Readonly<{ scopeId: string; machineId: string }>) => {
      if (machineId === input.attribution.machineId) await retireWorkflowRequesterCredentials({ ...input,
        ...input.attribution, scopeId });
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

export async function retireWorkflowRequesterCredentials(input: ScopeBinding): Promise<void> {
  const stored = await readBinding(input);
  if (!stored) return;
  const active = activeScopes.get(stored.path) ?? { count: 0, retire: true };
  active.retire = true;
  activeScopes.set(stored.path, active);
  await replacePrivateBearerFile({ path: stored.path, contents: JSON.stringify({ ...stored.stored, retireWhenIdle: true }) });
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
    verifyMachineAdmissionCurrent: async () => true });
  if (!credentials) return;
  const automationId = stored.stored.automationId;
  if (automationId) {
    const automation = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => getAutomationDefinition({
      token: credentials.token, automationId,
    }));
    if (!automation || !automation.enabled
      || !automation.assignments.some(assignment => assignment.machineId === input.machineId && assignment.enabled)
      || !automation.triggers.some(trigger => trigger.id === input.scopeId && trigger.enabled)) {
      await retireWorkflowRequesterCredentials(input);
    }
    return;
  }
  const storage = createWorkflowRunStorageClient({ token: credentials.token, serverHttpBaseUrl });
  let cursor: string | undefined;
  do {
    const page = RunPageSchema.parse(await storage.execute({ operation: 'list', request: {
      runId: input.scopeId, machineId: input.machineId, ...(cursor ? { cursor } : {}),
    }, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES }));
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
    verifyMachineAdmissionCurrent: async () => true });
  if (!credentials) { activeScopes.delete(stored.path); return; }
  const storage = createWorkflowRunStorageClient({ token: credentials.token, serverHttpBaseUrl });
  let cursor: string | undefined;
  do {
    const page = RunPageSchema.parse(await storage.execute({ operation: 'list', request: {
      triggerId: input.scopeId, machineId: input.machineId, ...(cursor ? { cursor } : {}),
    }, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES }));
    if (page.runs.some(run => !isTerminalAutomationRunStateV3(run.state) || run.workflowCustodyState === 'pending')) return;
    cursor = page.nextCursor;
  } while (cursor);
  // A re-save clears this same scope's retirement intent, including while the
  // admitted-work inventory was in flight.
  if (activeScopes.get(stored.path) !== active || !active.retire || active.count) return;
  await retireRequesterSessionCredentialCustody(stored.value);
  activeScopes.delete(stored.path);
  notifyCustodyChange();
}

/** The incumbent guest Account socket lives only while this installation holds its custody. */
export function observeWorkflowRequesterCredentialCustody(input: Omit<ScopeBinding, 'scopeId'> & Readonly<{
  hostAccountId: string; onError(error: unknown): void;
}>): Readonly<{ dispose(): void }> {
  type Observation = { token: string; dispose(): Promise<void>; invalidate(): void };
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
              serverHttpBaseUrl: input.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(), verifyMachineAdmissionCurrent: async () => true });
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
          if (existing) { existing.invalidate(); continue; }
          let running = false;
          let pending = false;
          const invalidate = () => {
            pending = true;
            if (running || disposed) return;
            running = true;
            void (async () => {
              while (pending && !disposed) {
                pending = false;
                const current = await listWorkflowRequesterCredentialScopes(input);
                if (current.status !== 'ready') throw new Error(current.reason);
                for (const binding of current.bindings) if (binding.attribution.accountId === accountId) {
                  await reconcileWorkflowRequesterCredentialScope({ ...input, accountId, scopeId: binding.sessionId });
                }
              }
            })().catch(input.onError).finally(() => { running = false; });
          };
          const observation = observeAccountChanges({ token: credentials.token, serverUrl: input.serverHttpBaseUrl },
            { onChange: invalidate, onError: input.onError });
          if (disposed) { await observation.dispose(); break; }
          observations.set(accountId, { token: credentials.token, dispose: observation.dispose, invalidate });
          invalidate();
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
    verifyMachineAdmissionCurrent: async () => true });
  if (!credentials) return null;
  return { credentials, attribution: stored.value.attribution, release: holdExecutionScope(input, stored.value, stored.stored.retireWhenIdle) };
}
