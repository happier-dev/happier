import type {
  ConnectedServiceCredentialRevisionV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

import {
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  serializeConnectedServiceChildSelections,
} from '../connectedServiceChildEnvironment';
import { readConnectedServiceMaterializationIdentityV1 } from '../materialize/createConnectedServiceMaterializationIdentity';
import { parseConnectedServiceBindingSelections } from '../parseConnectedServicesBindings';
import { RuntimeAccountIdentityIndex } from '../quotas/identity/RuntimeAccountIdentityIndex';
import type {
  RuntimeAccountIdentityEntry,
  RuntimeAccountIdentityRecordInput,
  RuntimeAccountIdentityRecordResult,
} from '../quotas/identity/runtimeAccountIdentityTypes';
import {
  buildConnectedServiceRuntimeIdentityKey,
  buildRuntimeActiveBindings,
  buildRuntimeBoundProfiles,
  normalizeConnectedServicesBindingsRaw,
  normalizeRuntimeRegistryEnv,
  readConnectedServiceRuntimeTargetIdentity,
  readRuntimeChildSelections,
  stableRuntimeRegistryFingerprint,
} from './identity';
import type {
  ConnectedServiceRuntimeQuotaTarget,
  ConnectedServiceRuntimeRefreshTarget,
  ConnectedServiceRuntimeTarget,
  ConnectedServiceRuntimeTargetInput,
  ConnectedServiceRuntimeTargetUpdate,
} from './target';

export { readConnectedServiceRuntimeTargetIdentity } from './identity';
export type {
  ConnectedServiceRuntimeBindingIdentity,
  ConnectedServiceRuntimeBoundProfile,
  ConnectedServiceRuntimeQuotaTarget,
  ConnectedServiceRuntimeRefreshTarget,
  ConnectedServicesRuntimeBindingsV1Like,
  ConnectedServiceRuntimeTarget,
  ConnectedServiceRuntimeTargetInput,
  ConnectedServiceRuntimeTargetUpdate,
} from './target';
export type { ConnectedServiceRuntimeIdentity } from './identity';

export type ConnectedServiceRuntimeTargetRegistrationKey =
  | Readonly<{ kind: 'session'; pid: number }>
  | Readonly<{ kind: 'execution_run'; runKey: string }>;

export type ConnectedServiceRuntimeTargetRegistration = Readonly<{
  key: ConnectedServiceRuntimeTargetRegistrationKey;
  target: ConnectedServiceRuntimeTarget;
}>;

type IndexedTarget = Readonly<{
  target: ConnectedServiceRuntimeTarget;
  fingerprint: string;
}>;

function normalizePid(pidRaw: number): number | null {
  const pid = Math.trunc(Number(pidRaw));
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function buildTargetFingerprint(target: Omit<ConnectedServiceRuntimeTarget, 'revision'>): string {
  return stableRuntimeRegistryFingerprint(target);
}

function omitRevision(target: ConnectedServiceRuntimeTarget): Omit<ConnectedServiceRuntimeTarget, 'revision'> {
  const {
    revision: _revision,
    ...withoutRevision
  } = target;
  return withoutRevision;
}

function buildCredentialRevisionSelectionEnv(
  target: ConnectedServiceRuntimeTarget,
  input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
  }>,
): Readonly<Record<string, string>> | null {
  let changed = false;
  const selections = target.connectedServiceSelections.map((selection) => {
    const activeProfileId = selection.kind === 'profile'
      ? selection.profileId
      : selection.activeProfileId;
    if (
      selection.serviceId !== input.serviceId
      || activeProfileId !== input.profileId
      || selection.credentialRevision === input.credentialRevision
    ) {
      return selection;
    }
    changed = true;
    return {
      ...selection,
      credentialRevision: input.credentialRevision,
    };
  });
  if (!changed) return null;
  const serialized = serializeConnectedServiceChildSelections(
    new Map(selections.map((selection) => [selection.serviceId, selection])),
  );
  if (!serialized) return null;
  return {
    ...target.connectedServiceSelectionsEnv,
    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: serialized,
  };
}

function buildExactGroupApplicationSelectionEnv(
  target: ConnectedServiceRuntimeTarget,
  input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    profileId: string;
    generation: number;
    credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
  }>,
): Readonly<Record<string, string>> | null {
  let matched = false;
  const selections = target.connectedServiceSelections.map((selection) => {
    if (
      selection.kind !== 'group'
      || selection.serviceId !== input.serviceId
      || selection.groupId !== input.groupId
    ) {
      return selection;
    }
    matched = true;
    return {
      ...selection,
      activeProfileId: input.profileId,
      generation: input.generation,
      credentialRevision: input.credentialRevision,
    };
  });
  if (!matched) {
    const declared = parseConnectedServiceBindingSelections(target.connectedServicesBindingsRaw).find((selection) => (
      selection.kind === 'group'
      && selection.serviceId === input.serviceId
      && selection.groupId === input.groupId
    ));
    if (declared?.kind !== 'group') return null;
    // Recovered metadata can declare a pool without a previously materialized selection.
    selections.push({
      kind: 'group',
      serviceId: input.serviceId,
      groupId: input.groupId,
      activeProfileId: input.profileId,
      fallbackProfileId: declared.fallbackProfileId ?? input.profileId,
      generation: input.generation,
      credentialRevision: input.credentialRevision,
    });
  }
  const serialized = serializeConnectedServiceChildSelections(
    new Map(selections.map((selection) => [selection.serviceId, selection])),
  );
  if (!serialized) return null;
  return {
    ...target.connectedServiceSelectionsEnv,
    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: serialized,
  };
}

export class ConnectedServiceRuntimeRegistry {
  private readonly targetsByPid = new Map<number, IndexedTarget>();
  // Exact application changes the snapshot, not the recipient's registration lineage.
  // Other updates/replacements deliberately do not inherit this lineage.
  private readonly exactApplicationLineageByTarget = new WeakMap<ConnectedServiceRuntimeTarget, object>();
  private readonly pidBySessionId = new Map<string, number>();
  private readonly pidsByBrokerSelectionIdentity = new Map<string, Set<number>>();
  // Execution-run targets live in a SEPARATE keyspace: a run shares its RUNNER's pid with the
  // session target, so keying runs by pid would clobber the session registration (and releasing a
  // run would deregister the session — the divergent-identity clobber class from live incident #1).
  // Run targets are keyed by their stable run key, carry the runner pid for liveness semantics, and
  // are folded into the distribution views (listTargets/listRefreshTargets/listQuotaTargets) so
  // refresh redistribution + quota fanout cover materialized run roots exactly like session roots.
  private readonly runTargetsByRunKey = new Map<string, IndexedTarget>();
  // Broker selection identity → run keys (NF-1/R3-6 for the runs surface). Run targets are keyed by
  // run key (not pid, and several runs can share a runner pid), so their broker index is separate from
  // the pid-keyed session index but folds into the same getByBrokerSelectionIdentity resolution.
  private readonly runKeysByBrokerSelectionIdentity = new Map<string, Set<string>>();
  private readonly targetRegistrationListeners = new Set<(
    registration: ConnectedServiceRuntimeTargetRegistration,
  ) => void>();
  private readonly runtimeAccountIdentities: RuntimeAccountIdentityIndex;

  constructor(params: Readonly<{
    nowMs?: () => number;
    runtimeAccountIdentityTtlMs?: number;
  }> = {}) {
    this.runtimeAccountIdentities = new RuntimeAccountIdentityIndex({
      nowMs: params.nowMs ?? (() => Date.now()),
      ttlMs: params.runtimeAccountIdentityTtlMs,
    });
  }

  public registerTarget(input: ConnectedServiceRuntimeTargetInput): ConnectedServiceRuntimeTarget {
    const existing = this.getIndexedByPid(input.pid);
    const target = this.writeTarget(input.pid, input, existing?.target ?? null);
    this.emitTargetRegistration({ key: { kind: 'session', pid: target.pid }, target });
    return target;
  }

  public registerRunTarget(
    input: ConnectedServiceRuntimeTargetInput & Readonly<{ runKey: string }>,
  ): ConnectedServiceRuntimeTarget {
    const runKey = normalizeString(input.runKey);
    if (!runKey) {
      throw new Error('Execution-run runtime target registration requires a non-empty runKey');
    }
    const { runKey: _runKey, ...targetInput } = input;
    const previousEntry = this.runTargetsByRunKey.get(runKey) ?? null;
    const candidate = this.buildStandaloneTarget(targetInput, previousEntry?.target ?? null);
    const entry = previousEntry?.fingerprint === candidate.fingerprint ? previousEntry : candidate;
    if (previousEntry && entry !== previousEntry) {
      this.deleteRunBrokerSelectionIdentityIndex(runKey, previousEntry.target);
    }
    this.runTargetsByRunKey.set(runKey, entry);
    if (entry !== previousEntry) this.indexRunBrokerSelectionIdentity(runKey, entry.target);
    this.emitTargetRegistration({ key: { kind: 'execution_run', runKey }, target: entry.target });
    return entry.target;
  }

  public onTargetRegistration(
    listener: (registration: ConnectedServiceRuntimeTargetRegistration) => void,
  ): () => void {
    this.targetRegistrationListeners.add(listener);
    return () => this.targetRegistrationListeners.delete(listener);
  }

  public listTargetRegistrations(): ReadonlyArray<ConnectedServiceRuntimeTargetRegistration> {
    return [
      ...Array.from(this.targetsByPid.entries()).map(([pid, entry]) => ({
        key: { kind: 'session' as const, pid },
        target: entry.target,
      })),
      ...Array.from(this.runTargetsByRunKey.entries()).map(([runKey, entry]) => ({
        key: { kind: 'execution_run' as const, runKey },
        target: entry.target,
      })),
    ].sort((left, right) => {
      const pidDelta = left.target.pid - right.target.pid;
      if (pidDelta !== 0) return pidDelta;
      if (left.key.kind !== right.key.kind) return left.key.kind === 'session' ? -1 : 1;
      const leftKey = left.key.kind === 'session' ? `session:${left.key.pid}` : `run:${left.key.runKey}`;
      const rightKey = right.key.kind === 'session' ? `session:${right.key.pid}` : `run:${right.key.runKey}`;
      return leftKey.localeCompare(rightKey);
    });
  }

  public isCurrentTargetRegistration(registration: ConnectedServiceRuntimeTargetRegistration): boolean {
    return this.getCurrentTargetForRegistration(registration) !== null;
  }

  public getCurrentTargetForRegistration(
    registration: ConnectedServiceRuntimeTargetRegistration,
  ): ConnectedServiceRuntimeTarget | null {
    const current = registration.key.kind === 'session'
      ? this.targetsByPid.get(registration.key.pid)?.target
      : this.runTargetsByRunKey.get(registration.key.runKey)?.target;
    if (!current) return null;
    if (current === registration.target) return current;
    const lineage = this.exactApplicationLineageByTarget.get(registration.target);
    return lineage !== undefined && lineage === this.exactApplicationLineageByTarget.get(current)
      ? current
      : null;
  }

  public unregisterRunKey(runKeyRaw: string): ConnectedServiceRuntimeTarget | null {
    const runKey = normalizeString(runKeyRaw);
    if (!runKey) return null;
    const existing = this.runTargetsByRunKey.get(runKey);
    if (!existing) return null;
    this.runTargetsByRunKey.delete(runKey);
    this.deleteRunBrokerSelectionIdentityIndex(runKey, existing.target);
    return existing.target;
  }

  public updateTarget(input: ConnectedServiceRuntimeTargetUpdate): ConnectedServiceRuntimeTarget | null {
    const existing = this.getIndexedByPid(input.pid);
    if (!existing) return null;
    return this.writeTarget(input.pid, input, existing.target);
  }

  public adoptExactGroupApplicationForSession(input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    profileId: string;
    generation: number;
    credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
  }>): ConnectedServiceRuntimeTarget | null {
    const sessionId = normalizeString(input.sessionId);
    const groupId = normalizeString(input.groupId);
    const profileId = normalizeString(input.profileId);
    const generation = Math.trunc(Number(input.generation));
    if (
      !sessionId
      || !groupId
      || !profileId
      || !Number.isFinite(generation)
      || generation < 0
    ) {
      return null;
    }
    const existing = this.getBySessionId(sessionId);
    if (!existing) return null;
    if (existing.activeBindings.some((binding) => (
      binding.serviceId === input.serviceId
      && binding.groupId === groupId
      && binding.profileId === profileId
      && binding.generation === generation
      && binding.credentialRevision === input.credentialRevision
    ))) {
      return existing;
    }
    const connectedServiceSelectionsEnv = buildExactGroupApplicationSelectionEnv(existing, {
      serviceId: input.serviceId,
      groupId,
      profileId,
      generation,
      credentialRevision: input.credentialRevision,
    });
    if (!connectedServiceSelectionsEnv) return null;
    const updated = this.updateTarget({
      pid: existing.pid,
      connectedServiceSelectionsEnv,
    });
    if (updated) {
      const lineage = this.exactApplicationLineageByTarget.get(existing) ?? {};
      this.exactApplicationLineageByTarget.set(existing, lineage);
      this.exactApplicationLineageByTarget.set(updated, lineage);
    }
    return updated;
  }

  public adoptCredentialRevisionForProfile(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
    runtimeIdentityKeys?: ReadonlySet<string>;
  }>): number {
    let updatedTargetCount = 0;
    for (const [pid, entry] of this.targetsByPid) {
      if (input.runtimeIdentityKeys && !input.runtimeIdentityKeys.has(entry.target.runtimeIdentityKey)) continue;
      const connectedServiceSelectionsEnv = buildCredentialRevisionSelectionEnv(entry.target, input);
      if (!connectedServiceSelectionsEnv) continue;
      this.writeTarget(pid, { pid, connectedServiceSelectionsEnv }, entry.target);
      updatedTargetCount += 1;
    }
    for (const [runKey, entry] of this.runTargetsByRunKey) {
      if (input.runtimeIdentityKeys && !input.runtimeIdentityKeys.has(entry.target.runtimeIdentityKey)) continue;
      const connectedServiceSelectionsEnv = buildCredentialRevisionSelectionEnv(entry.target, input);
      if (!connectedServiceSelectionsEnv) continue;
      const next = this.buildStandaloneTarget({
        pid: entry.target.pid,
        connectedServiceSelectionsEnv,
      }, entry.target);
      this.runTargetsByRunKey.set(runKey, next);
      updatedTargetCount += 1;
    }
    return updatedTargetCount;
  }

  public adoptSessionId(input: Readonly<{ pid: number; sessionId?: string | null }>): ConnectedServiceRuntimeTarget | null {
    return this.updateTarget({
      pid: input.pid,
      sessionId: input.sessionId ?? null,
    });
  }

  public unregisterPid(pidRaw: number): ConnectedServiceRuntimeTarget | null {
    const pid = normalizePid(pidRaw);
    if (pid === null) return null;
    // A dead runner's execution runs are dead too: drop run targets bound to this pid.
    this.dropRunTargetsForPid(pid);
    return this.unregisterSessionTargetByPid(pid);
  }

  public unregisterSessionTargetByPid(pidRaw: number): ConnectedServiceRuntimeTarget | null {
    const pid = normalizePid(pidRaw);
    if (pid === null) return null;
    const existing = this.targetsByPid.get(pid);
    if (!existing) return null;
    this.targetsByPid.delete(pid);
    this.deleteSessionIndex(existing.target);
    return existing.target;
  }

  public transferPid(fromPidRaw: number, toPidRaw: number): ConnectedServiceRuntimeTarget | null {
    const fromPid = normalizePid(fromPidRaw);
    const toPid = normalizePid(toPidRaw);
    if (fromPid === null || toPid === null) return null;
    const existing = this.targetsByPid.get(fromPid);
    if (!existing) return null;
    if (fromPid === toPid) return existing.target;
    // A respawned runner does not carry its old process's runs; resumed runs re-materialize and
    // re-register under the new runner pid.
    this.dropRunTargetsForPid(fromPid);

    const replaced = this.targetsByPid.get(toPid);
    if (replaced) {
      this.deleteSessionIndex(replaced.target);
    }

    const nextBase = {
      ...existing.target,
      pid: toPid,
      revision: existing.target.revision + 1,
    };
    const fingerprint = buildTargetFingerprint(omitRevision(nextBase));
    this.targetsByPid.delete(fromPid);
    this.deleteSessionIndex(existing.target);
    const next = nextBase as ConnectedServiceRuntimeTarget;
    this.targetsByPid.set(toPid, { target: next, fingerprint });
    this.indexSession(next);
    return next;
  }

  public getByPid(pidRaw: number): ConnectedServiceRuntimeTarget | null {
    return this.getIndexedByPid(pidRaw)?.target ?? null;
  }

  public getBySessionId(sessionIdRaw: string): ConnectedServiceRuntimeTarget | null {
    const sessionId = normalizeString(sessionIdRaw);
    if (!sessionId) return null;
    const pid = this.pidBySessionId.get(sessionId);
    return typeof pid === 'number' ? this.getByPid(pid) : null;
  }

  /**
   * Resolve a LIVE runtime target by its broker selection identity (R3-6). Providers with a shared
   * managed server (OpenCode/Pi) present this stable identity — not a per-session id — at the daemon
   * bridge; the daemon uses the matched live target's CURRENT binding as the canonical selection.
   * Any live target carrying the identity is equivalent (they share the same connected-service
   * binding, which is what the identity keys on); the lowest live pid wins for determinism.
   */
  public getByBrokerSelectionIdentity(identityRaw: string): ConnectedServiceRuntimeTarget | null {
    const identity = normalizeString(identityRaw);
    if (!identity) return null;
    let resolved: ConnectedServiceRuntimeTarget | null = null;
    const consider = (target: ConnectedServiceRuntimeTarget | null): void => {
      if (target && (resolved === null || target.pid < resolved.pid)) {
        resolved = target;
      }
    };
    const pids = this.pidsByBrokerSelectionIdentity.get(identity);
    if (pids) {
      for (const pid of pids) consider(this.targetsByPid.get(pid)?.target ?? null);
    }
    // Fold in the run keyspace (NF-1): a run bound to a broker pool that no live session shares must
    // still authorize its broker token refresh. Lowest live pid wins across both keyspaces.
    const runKeys = this.runKeysByBrokerSelectionIdentity.get(identity);
    if (runKeys) {
      for (const runKey of runKeys) consider(this.runTargetsByRunKey.get(runKey)?.target ?? null);
    }
    return resolved;
  }

  public listTargets(): ReadonlyArray<ConnectedServiceRuntimeTarget> {
    return [
      ...Array.from(this.targetsByPid.values()).map((entry) => entry.target),
      ...Array.from(this.runTargetsByRunKey.values()).map((entry) => entry.target),
    ].sort((left, right) => left.pid - right.pid);
  }

  public listRefreshTargets(): ReadonlyArray<ConnectedServiceRuntimeRefreshTarget> {
    return this.listTargets().flatMap((target) => {
      if (!target.agentId || !target.materializationKey || target.boundProfiles.length === 0) {
        return [];
      }
      const view: ConnectedServiceRuntimeRefreshTarget = {
        ...target,
        agentId: target.agentId,
        materializationKey: target.materializationKey,
        bindings: target.boundProfiles,
        selectionsByServiceId: new Map(target.connectedServiceSelections.map((selection) => [selection.serviceId, selection])),
      };
      return [view];
    });
  }

  public listQuotaTargets(): ReadonlyArray<ConnectedServiceRuntimeQuotaTarget> {
    return this.listTargets().flatMap((target) => {
      if (target.boundProfiles.length === 0 && target.activeBindings.length === 0) {
        return [];
      }
      const view: ConnectedServiceRuntimeQuotaTarget = {
        ...target,
        bindings: target.connectedServicesBindingsRaw,
        connectedServiceSelectionsEnv: target.connectedServiceSelectionsEnv,
        runtimeAccountIdentitySelections: target.runtimeAccountIdentitySelections,
      };
      return [view];
    });
  }

  public recordRuntimeAccountIdentity(
    input: RuntimeAccountIdentityRecordInput,
  ): RuntimeAccountIdentityRecordResult {
    return this.runtimeAccountIdentities.record(input);
  }

  public readRuntimeAccountIdentity(sessionId: string): RuntimeAccountIdentityEntry | null {
    return this.runtimeAccountIdentities.readSessionIdentity(sessionId);
  }

  public listRuntimeIdentitiesByProviderAccount(input: Readonly<{
    serviceId: RuntimeAccountIdentityEntry['serviceId'];
    providerAccountId: string;
    groupId?: string | null;
    excludeSessionId?: string | null;
    currentGroupGenerationBySessionId?: ReadonlyMap<string, number | null>;
  }>): RuntimeAccountIdentityEntry[] {
    return this.runtimeAccountIdentities.listByProviderAccount(input);
  }

  public invalidateRuntimeAccountIdentity(sessionId: string): void {
    this.runtimeAccountIdentities.invalidateSession(sessionId);
  }

  public clearRuntimeAccountIdentities(): void {
    this.runtimeAccountIdentities.clear();
  }

  private getIndexedByPid(pidRaw: number): IndexedTarget | null {
    const pid = normalizePid(pidRaw);
    if (pid === null) return null;
    return this.targetsByPid.get(pid) ?? null;
  }

  private emitTargetRegistration(registration: ConnectedServiceRuntimeTargetRegistration): void {
    for (const listener of this.targetRegistrationListeners) listener(registration);
  }

  private dropRunTargetsForPid(pid: number): void {
    for (const [runKey, entry] of this.runTargetsByRunKey) {
      if (entry.target.pid === pid) {
        this.runTargetsByRunKey.delete(runKey);
        this.deleteRunBrokerSelectionIdentityIndex(runKey, entry.target);
      }
    }
  }

  private indexRunBrokerSelectionIdentity(runKey: string, target: ConnectedServiceRuntimeTarget): void {
    if (!target.brokerSelectionIdentity) return;
    const runKeys = this.runKeysByBrokerSelectionIdentity.get(target.brokerSelectionIdentity) ?? new Set<string>();
    runKeys.add(runKey);
    this.runKeysByBrokerSelectionIdentity.set(target.brokerSelectionIdentity, runKeys);
  }

  private deleteRunBrokerSelectionIdentityIndex(runKey: string, target: ConnectedServiceRuntimeTarget): void {
    if (!target.brokerSelectionIdentity) return;
    const runKeys = this.runKeysByBrokerSelectionIdentity.get(target.brokerSelectionIdentity);
    if (!runKeys) return;
    runKeys.delete(runKey);
    if (runKeys.size === 0) this.runKeysByBrokerSelectionIdentity.delete(target.brokerSelectionIdentity);
  }

  // Pure target composition shared by pid-keyed session targets and run-key-keyed run targets.
  private composeTargetBase(
    pid: number,
    patch: ConnectedServiceRuntimeTargetInput | ConnectedServiceRuntimeTargetUpdate,
    previous: ConnectedServiceRuntimeTarget | null,
  ): Readonly<{ base: Omit<ConnectedServiceRuntimeTarget, 'revision'>; fingerprint: string }> {
    const connectedServiceSelectionsEnv = patch.connectedServiceSelectionsEnv !== undefined
      ? normalizeRuntimeRegistryEnv(patch.connectedServiceSelectionsEnv)
      : previous?.connectedServiceSelectionsEnv ?? {};
    const connectedServiceSelections = readRuntimeChildSelections(connectedServiceSelectionsEnv);
    const connectedServicesBindingsRaw = patch.connectedServicesBindingsRaw !== undefined
      ? normalizeConnectedServicesBindingsRaw(patch.connectedServicesBindingsRaw)
      : previous?.connectedServicesBindingsRaw ?? {};
    const agentId = patch.agentId !== undefined ? patch.agentId ?? null : previous?.agentId ?? null;
    const sessionId = patch.sessionId !== undefined ? normalizeString(patch.sessionId) : previous?.sessionId ?? null;
    const brokerSelectionIdentity = patch.brokerSelectionIdentity !== undefined
      ? normalizeString(patch.brokerSelectionIdentity)
      : previous?.brokerSelectionIdentity ?? null;
    const materializationKey = patch.materializationKey !== undefined
      ? normalizeString(patch.materializationKey)
      : previous?.materializationKey ?? null;
    const connectedServiceMaterializationIdentityV1 = patch.connectedServiceMaterializationIdentityV1 !== undefined
      ? readConnectedServiceMaterializationIdentityV1(patch.connectedServiceMaterializationIdentityV1)
      : previous?.connectedServiceMaterializationIdentityV1 ?? null;
    const sessionDirectory = patch.sessionDirectory !== undefined
      ? normalizeString(patch.sessionDirectory)
      : previous?.sessionDirectory ?? null;
    const runtimeAccountIdentitySelections = patch.runtimeAccountIdentitySelections !== undefined
      ? Array.from(patch.runtimeAccountIdentitySelections ?? [])
      : previous?.runtimeAccountIdentitySelections ?? [];
    const accessTokenRefresh = patch.accessTokenRefresh !== undefined
      ? patch.accessTokenRefresh ?? null
      : previous?.accessTokenRefresh ?? null;
    const boundProfiles = buildRuntimeBoundProfiles({
      connectedServicesBindingsRaw,
      connectedServiceSelections,
    });
    const activeBindings = buildRuntimeActiveBindings({
      connectedServicesBindingsRaw,
      connectedServiceSelections,
    });
    const identity = readConnectedServiceRuntimeTargetIdentity({
      pid,
      sessionId,
      agentId,
      materializationKey,
      activeBindings,
    });
    const base = {
      pid,
      agentId,
      sessionId,
      brokerSelectionIdentity,
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv,
      connectedServiceSelections,
      materializationKey,
      connectedServiceMaterializationIdentityV1,
      sessionDirectory,
      runtimeAccountIdentitySelections,
      accessTokenRefresh,
      boundProfiles,
      activeBindings,
      runtimeIdentityKey: buildConnectedServiceRuntimeIdentityKey(identity),
    };
    return { base, fingerprint: buildTargetFingerprint(base) };
  }

  // Builds an unindexed (no pid map, no session index) target entry for the run keyspace.
  private buildStandaloneTarget(
    patch: ConnectedServiceRuntimeTargetInput,
    previous: ConnectedServiceRuntimeTarget | null,
  ): IndexedTarget {
    const pid = normalizePid(patch.pid) ?? 0;
    const { base, fingerprint } = this.composeTargetBase(pid, patch, previous);
    const target: ConnectedServiceRuntimeTarget = {
      ...base,
      revision: (previous?.revision ?? 0) + 1,
    };
    return { target, fingerprint };
  }

  private writeTarget(
    pidRaw: number,
    patch: ConnectedServiceRuntimeTargetInput | ConnectedServiceRuntimeTargetUpdate,
    previousAtPid: ConnectedServiceRuntimeTarget | null,
  ): ConnectedServiceRuntimeTarget {
    const pid = normalizePid(pidRaw) ?? 0;
    const provisionalSessionId = patch.sessionId !== undefined
      ? normalizeString(patch.sessionId)
      : previousAtPid?.sessionId ?? null;
    const previousSessionPid = provisionalSessionId ? this.pidBySessionId.get(provisionalSessionId) : undefined;
    const previousForSameSession = typeof previousSessionPid === 'number' && previousSessionPid !== pid
      ? this.targetsByPid.get(previousSessionPid)?.target ?? null
      : null;
    const previous = previousAtPid ?? previousForSameSession;
    const { base, fingerprint } = this.composeTargetBase(pid, patch, previous);
    if (previous) {
      const previousIndexed = this.targetsByPid.get(previous.pid);
      if (previousIndexed?.fingerprint === fingerprint) {
        return previous;
      }
    }

    const next: ConnectedServiceRuntimeTarget = {
      ...base,
      revision: (previous?.revision ?? 0) + 1,
    };
    if (previousAtPid) {
      this.deleteSessionIndex(previousAtPid);
    }
    if (previousForSameSession) {
      this.targetsByPid.delete(previousForSameSession.pid);
      this.deleteSessionIndex(previousForSameSession);
    }
    this.targetsByPid.set(pid, { target: next, fingerprint });
    this.indexSession(next);
    return next;
  }

  private deleteSessionIndex(target: ConnectedServiceRuntimeTarget): void {
    this.deleteBrokerSelectionIdentityIndex(target);
    if (!target.sessionId) return;
    if (this.pidBySessionId.get(target.sessionId) === target.pid) {
      this.pidBySessionId.delete(target.sessionId);
    }
    this.invalidateRuntimeAccountIdentity(target.sessionId);
  }

  private indexSession(target: ConnectedServiceRuntimeTarget): void {
    this.indexBrokerSelectionIdentity(target);
    if (!target.sessionId) return;
    this.pidBySessionId.set(target.sessionId, target.pid);
  }

  private indexBrokerSelectionIdentity(target: ConnectedServiceRuntimeTarget): void {
    if (!target.brokerSelectionIdentity) return;
    const pids = this.pidsByBrokerSelectionIdentity.get(target.brokerSelectionIdentity)
      ?? new Set<number>();
    pids.add(target.pid);
    this.pidsByBrokerSelectionIdentity.set(target.brokerSelectionIdentity, pids);
  }

  private deleteBrokerSelectionIdentityIndex(target: ConnectedServiceRuntimeTarget): void {
    if (!target.brokerSelectionIdentity) return;
    const pids = this.pidsByBrokerSelectionIdentity.get(target.brokerSelectionIdentity);
    if (!pids) return;
    pids.delete(target.pid);
    if (pids.size === 0) this.pidsByBrokerSelectionIdentity.delete(target.brokerSelectionIdentity);
  }
}
