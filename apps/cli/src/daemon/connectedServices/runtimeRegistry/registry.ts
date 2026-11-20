import { ConnectedServiceMaterializationIdentityV1Schema } from '@happier-dev/protocol/sessions/metadata/connectedServiceMaterializationIdentityV1';
import type { ConnectedAccountServiceKey, ConnectedServiceBindingsV2, ConnectedServiceCredentialRevisionV1 } from '@happier-dev/protocol';
import { ConnectedServiceBindingsV2IngressSchema, projectConnectedServiceBindingsForChild } from '@happier-dev/protocol/connect/connected-service-bindings';

import { isCatalogAgentId } from '@/agent/catalog/resolution';
import { RequesterWorkAttributionV1Schema, type RequesterWorkAttributionV1 } from '../../lifecycle/requesterWorkAttribution';
import {
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  serializeConnectedServiceChildSelectionValues,
} from '../connectedServiceChildEnvironment';
import { parseConnectedServiceBindingSelections } from '../parseConnectedServicesBindings';
import type { ConnectedServiceAppliedParentSelectionUnavailableReason } from '../runs/materializeContract';

import {
  buildConnectedServiceRuntimeIdentityKey,
  buildRuntimeActiveBindings,
  buildRuntimeBoundProfiles,
  normalizeConnectedServicesBindingsRaw,
  normalizeRuntimeRegistryEnv,
  normalizeRuntimeRegistryEnvRaw,
  readConnectedServiceRuntimeTargetIdentity,
  readRuntimeChildSelections,
  stableRuntimeRegistryFingerprint,
} from './identity';
import type {
  ConnectedServiceRuntimeQuotaTarget,
  ConnectedServiceRuntimeRegisteredTarget,
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
  ConnectedServiceRuntimeRegisteredTarget,
  ConnectedServiceRuntimeRefreshTarget,
  ConnectedServicesRuntimeBindingsV1Like,
  ConnectedServiceRuntimeTarget,
  ConnectedServiceRuntimeTargetInput,
  ConnectedServiceRuntimeTargetUpdate,
} from './target';
export type { ConnectedServiceRuntimeIdentity } from './identity';

type IndexedTarget = Readonly<{
  target: ConnectedServiceRuntimeTarget;
  fingerprint: string;
}>;

type ConnectedServiceRuntimeTargetRegistrationListener = (
  target: ConnectedServiceRuntimeTarget,
) => void;

type ConnectedServiceRuntimeTargetRegistrationOptions = Readonly<{
  source?: 'bootstrap';
  groupApplicationTarget?: ConnectedServiceRuntimeTarget;
}>;

function normalizePid(pidRaw: number): number | null {
  const pid = Math.trunc(Number(pidRaw));
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

type SessionTargetKeyFields = Readonly<{ pid: number; sessionId: string | null; spawnTrackingKey?: string }>;

/**
 * A Session target is keyed by its Session: a session host runs several Sessions in one process,
 * so the pid is a liveness field, never the identity. Before the runner reports its Session id,
 * a spawn's bootstrap target is keyed by the spawn's SessionTrackingKey (or, for a writer that has
 * none, by its process) until `adoptSessionId`.
 */
function sessionTargetKey(target: SessionTargetKeyFields): string {
  if (target.sessionId) return `session\0${target.sessionId}`;
  return target.spawnTrackingKey ? `spawn\0${target.spawnTrackingKey}` : `process\0${target.pid}`;
}

function buildTargetFingerprint(target: Omit<ConnectedServiceRuntimeTarget, 'revision'>): string {
  // Selected bytes follow the materialization lease by reference. Do not
  // serialize credentials again on every passive process/metadata arrival.
  const { agentLaunchMaterials: _materials, ...identity } = target;
  return stableRuntimeRegistryFingerprint(identity);
}

function omitRevision(target: ConnectedServiceRuntimeTarget): Omit<ConnectedServiceRuntimeTarget, 'revision'> {
  const {
    revision: _revision,
    ...withoutRevision
  } = target;
  return withoutRevision;
}

function buildExactGroupApplicationSelectionEnv(
  target: ConnectedServiceRuntimeTarget,
  input: Readonly<{
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
    profileId: string;
    generation: number;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
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
      // Binding metadata carries no pool policy; the child reads an absent policy as null.
      policy: null,
      credentialRevision: input.credentialRevision,
    });
  }
  const serialized = serializeConnectedServiceChildSelectionValues(selections);
  if (!serialized) return null;
  return {
    ...target.connectedServiceSelectionsEnv,
    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: serialized,
  };
}

export class ConnectedServiceRuntimeRegistry {
  private readonly sessionTargetsByKey: Map<string, IndexedTarget>;
  // Only an owned group application carries recipient lineage across its bookkeeping.
  private readonly exactApplicationLineageByTarget: WeakMap<ConnectedServiceRuntimeTarget, object>;
  private readonly providerObservationTimes: WeakMap<ConnectedServiceRuntimeTarget, ReadonlyMap<string, number>>;
  private readonly targetRegistrationListeners: Set<ConnectedServiceRuntimeTargetRegistrationListener>;
  // Execution-run targets live in a SEPARATE keyspace: a run shares its RUNNER's pid with its
  // Session target, so keying runs like Sessions would clobber the Session registration (and
  // releasing a run would deregister the Session). Run targets are keyed by their stable run key, carry
  // the runner pid for liveness semantics, and are included in the distribution views
  // (listTargets/listRefreshTargets/listQuotaTargets) so refresh + quota coverage applies to
  // materialized run roots exactly like session roots.
  private readonly runTargetsByRunKey: Map<string, IndexedTarget>;

  constructor(
    backing?: ConnectedServiceRuntimeRegistry,
    private readonly ownsRequesterTarget?: (target: ConnectedServiceRuntimeTarget) => boolean,
    private readonly requesterScope?: Pick<RequesterWorkAttributionV1, 'serverId' | 'accountId'>,
  ) {
    this.sessionTargetsByKey = backing?.sessionTargetsByKey ?? new Map();
    this.exactApplicationLineageByTarget = backing?.exactApplicationLineageByTarget ?? new WeakMap();
    this.providerObservationTimes = backing?.providerObservationTimes ?? new WeakMap();
    this.targetRegistrationListeners = backing?.targetRegistrationListeners ?? new Set();
    this.runTargetsByRunKey = backing?.runTargetsByRunKey ?? new Map();
  }

  /** A requester query/mutation view; the daemon inventory retains the one backing registry. */
  public scopeToRequester(
    ownsTarget: (target: ConnectedServiceRuntimeTarget) => boolean,
    requesterScope?: Pick<RequesterWorkAttributionV1, 'serverId' | 'accountId'>,
  ): ConnectedServiceRuntimeRegistry {
    return new ConnectedServiceRuntimeRegistry(this,
      (target) => this.isInRequesterScope(target) && ownsTarget(target), requesterScope);
  }

  private isInRequesterScope(target: ConnectedServiceRuntimeTarget): boolean {
    const stamp = target.requesterWorkAttributionV1;
    if (stamp && this.requesterScope && (stamp.serverId !== this.requesterScope.serverId
      || stamp.accountId !== this.requesterScope.accountId)) return false;
    if (!this.ownsRequesterTarget) return true;
    try { return this.ownsRequesterTarget(target); } catch { return false; }
  }

  private assertRequesterScope(target: ConnectedServiceRuntimeTarget): void {
    if (!this.isInRequesterScope(target)) throw new Error('connected_service_runtime_requester_scope_mismatch');
  }

  public registerTarget(
    input: ConnectedServiceRuntimeTargetInput,
    options?: ConnectedServiceRuntimeTargetRegistrationOptions,
  ): ConnectedServiceRuntimeRegisteredTarget {
    const sessionId = normalizeString(input.sessionId);
    // A Session's registration addresses its own target (moving it when the Session reattached
    // under another pid); a sessionless spawn bootstrap addresses its process's bootstrap slot
    // until `adoptSessionId`. Neither ever lands on another Session hosted by the same process.
    const spawnTrackingKey = normalizeString(input.spawnTrackingKey) ?? undefined;
    const ownBootstrap = spawnTrackingKey ? this.getIndexedBootstrap(input.pid, spawnTrackingKey) : null;
    const existing = sessionId
      ? this.getIndexedSessionTarget(input.pid, sessionId) ?? ownBootstrap
      : this.getIndexedBootstrap(input.pid, spawnTrackingKey);
    const applicationTarget = options?.groupApplicationTarget;
    if (applicationTarget && (!this.exactApplicationLineageByTarget.has(applicationTarget) || existing?.target !== applicationTarget
      || input.sessionId !== applicationTarget.sessionId || input.agentId !== applicationTarget.agentId)) {
      throw new Error('credential_revision_superseded');
    }
    const currentForSession = sessionId ? this.getBySessionId(sessionId) : null;
    const patch = options?.source === 'bootstrap' && currentForSession
      ? {
          ...input,
          // Bootstrap/reattach data may fill process metadata, but once this logical session has
          // current runtime truth it cannot replace the applied Connected Services identity.
          connectedServicesBindingsRaw: currentForSession.connectedServicesBindingsRaw,
          connectedServiceSelectionsEnv: currentForSession.connectedServiceSelectionsEnv,
          agentLaunchMaterials: currentForSession.agentLaunchMaterials,
          materializationKey: currentForSession.materializationKey,
          connectedServiceMaterializationIdentityV1:
            currentForSession.connectedServiceMaterializationIdentityV1,
        }
      : input;
    const target = this.writeTarget(input.pid, patch, existing?.target ?? null);
    // The Session's current target supersedes its own spawn bootstrap.
    if (sessionId && ownBootstrap && ownBootstrap !== existing) this.unregisterTarget(ownBootstrap.target);
    if (applicationTarget) this.carryGroupApplicationLineage(applicationTarget, target);
    if (target !== existing?.target) this.notifyTargetRegistration(target);
    return this.withRegisteredBindings(target);
  }

  public readAppliedSessionBindings(input: Readonly<{ runnerPid: number; sessionId: string; agentId: string }>,
    runtimeIdentity?: Readonly<{ pid: number; sessionRunnerPid?: number; happySessionId?: string }>,
  ): Readonly<
    { status: 'unavailable'; reason: ConnectedServiceAppliedParentSelectionUnavailableReason }
    | { status: 'applied'; connectedServices: ConnectedServiceBindingsV2 }
  > {
    if (runtimeIdentity && (runtimeIdentity.happySessionId !== input.sessionId
      || (input.runnerPid !== runtimeIdentity.pid && input.runnerPid !== runtimeIdentity.sessionRunnerPid))) {
      return { status: 'unavailable', reason: 'validation_failed' };
    }
    // Wrapper launchers retain the registry target; accepted runner identity
    // comes from the daemon's canonical tracked Session, never from a new alias table.
    const target = this.getIndexedSessionTarget(runtimeIdentity?.pid ?? input.runnerPid, input.sessionId)?.target;
    if (!target || target.sessionId !== input.sessionId || target.agentId !== input.agentId) {
      return { status: 'unavailable', reason: 'not_registered' };
    }
    const parsed = ConnectedServiceBindingsV2IngressSchema.safeParse(target.connectedServicesBindingsRaw);
    if (!parsed.success) return { status: 'unavailable', reason: 'validation_failed' };
    // Direct Team custody cannot be inherited, even inside this host seam.
    if (Object.values(parsed.data.bindingsByServiceId).some(binding => binding.source === 'team_resource'
      && binding.deliveryMode !== 'brokered')) return { status: 'unavailable', reason: 'direct_custody' };
    return { status: 'applied', connectedServices: projectConnectedServiceBindingsForChild(parsed.data) };
  }

  public registerRunTarget(
    input: ConnectedServiceRuntimeTargetInput & Readonly<{ runKey: string }>,
  ): ConnectedServiceRuntimeRegisteredTarget {
    const runKey = normalizeString(input.runKey);
    if (!runKey) {
      throw new Error('Execution-run runtime target registration requires a non-empty runKey');
    }
    const { runKey: _runKey, ...targetInput } = input;
    const previous = this.runTargetsByRunKey.get(runKey)?.target ?? null;
    if (previous) this.assertRequesterScope(previous);
    const next = this.buildStandaloneTarget(targetInput, previous);
    this.assertRequesterScope(next.target);
    this.runTargetsByRunKey.set(runKey, next);
    if (next.target !== previous) this.notifyTargetRegistration(next.target);
    return this.withRegisteredBindings(next.target);
  }

  public subscribeTargetRegistrations(
    listener: ConnectedServiceRuntimeTargetRegistrationListener,
  ): () => void {
    const scopedListener: ConnectedServiceRuntimeTargetRegistrationListener = (target) => {
      if (this.isInRequesterScope(target)) listener(target);
    };
    this.targetRegistrationListeners.add(scopedListener);
    return () => {
      this.targetRegistrationListeners.delete(scopedListener);
    };
  }

  public unregisterRunKey(runKeyRaw: string): ConnectedServiceRuntimeTarget | null {
    const runKey = normalizeString(runKeyRaw);
    if (!runKey) return null;
    const existing = this.runTargetsByRunKey.get(runKey);
    if (!existing || !this.isInRequesterScope(existing.target)) return null;
    this.runTargetsByRunKey.delete(runKey);
    return existing.target;
  }

  /** Updates the named Session's target on that process, else the process's only target. */
  public updateTarget(input: ConnectedServiceRuntimeTargetUpdate): ConnectedServiceRuntimeTarget | null {
    const sessionId = normalizeString(input.sessionId);
    const existing = (sessionId ? this.getIndexedSessionTarget(input.pid, sessionId) : null)
      ?? this.getIndexedForProcess(input.pid);
    if (!existing) return null;
    const target = this.writeTarget(input.pid, input, existing.target);
    if (input.connectedServicesBindingsRaw === null) this.exactApplicationLineageByTarget.delete(target);
    if (target !== existing.target) this.notifyTargetRegistration(target);
    return target;
  }

  /** Refresh commits only to the current lease, never another Run at its PID. */
  public replaceAgentLaunchMaterials(target: ConnectedServiceRuntimeTarget,
    material: ConnectedServiceRuntimeTarget['agentLaunchMaterials'] | null): ConnectedServiceRuntimeTarget | null {
    if (!this.isInRequesterScope(target)) return null;
    const runEntry = [...this.runTargetsByRunKey.entries()].find(([, entry]) => this.isInRequesterScope(entry.target)
      && this.matchesCurrentTargetProjection(entry.target, target));
    const indexed = runEntry?.[1] ?? this.getIndexedAtKey(target);
    if (!indexed || !this.matchesCurrentTargetProjection(indexed.target, target)) return null;
    const patch = { pid: target.pid, agentLaunchMaterials: material ?? null };
    const next = runEntry ? this.buildStandaloneTarget(patch, indexed.target).target : this.writeTarget(target.pid, patch, indexed.target);
    if (runEntry) this.runTargetsByRunKey.set(runEntry[0], { target: next, fingerprint: buildTargetFingerprint(omitRevision(next)) });
    if (next !== indexed.target) this.notifyTargetRegistration(next);
    return next;
  }

  /**
   * Gives a spawn's target its reported canonical Session id: that spawn's own sessionless bootstrap
   * (by its tracking key, else the process slot of a writer without one), or, when the caller's
   * tracked custody proves the process hosts only this Session, the target its spawn registered
   * under another id. Another Session or spawn hosted by the process is never re-keyed.
   */
  public adoptSessionId(input: Readonly<{
    pid: number;
    sessionId?: string | null;
    spawnTrackingKey?: string;
    soleSessionOfProcess?: boolean;
  }>): ConnectedServiceRuntimeTarget | null {
    const sessionId = normalizeString(input.sessionId);
    if (!sessionId) return null;
    if (this.getBySessionId(sessionId)) {
      // The Session already registered its own target: its spawn bootstrap is superseded.
      const ownBootstrap = input.spawnTrackingKey ? this.getIndexedBootstrap(input.pid, input.spawnTrackingKey) : null;
      if (ownBootstrap) this.unregisterTarget(ownBootstrap.target);
      return null;
    }
    const adoptable = (input.spawnTrackingKey ? this.getIndexedBootstrap(input.pid, input.spawnTrackingKey) : null)
      ?? this.getIndexedProcessSlot(input.pid)
      ?? (input.soleSessionOfProcess === true ? this.getIndexedForProcess(input.pid) : null);
    if (!adoptable) return null;
    // Adoption changes the spawn's address, not its selected launch material.
    const target = this.writeTarget(input.pid, { pid: input.pid, sessionId,
      agentLaunchMaterials: adoptable.target.agentLaunchMaterials }, adoptable.target);
    if (target !== adoptable.target) this.notifyTargetRegistration(target);
    return target;
  }

  private carryGroupApplicationLineage(previous: ConnectedServiceRuntimeTarget, current: ConnectedServiceRuntimeTarget): void {
    const lineage = this.exactApplicationLineageByTarget.get(previous) ?? {};
    this.exactApplicationLineageByTarget.set(previous, lineage);
    this.exactApplicationLineageByTarget.set(current, lineage);
  }

  public withdrawSessionGroupApplicationBindings(target: ConnectedServiceRuntimeTarget): ConnectedServiceRuntimeTarget | null {
    if (this.getIndexedAtKey(target)?.target !== target || !target.sessionId) return null;
    const withdrawn = this.writeTarget(target.pid, { pid: target.pid, connectedServicesBindingsRaw: null }, target);
    this.carryGroupApplicationLineage(target, withdrawn);
    if (withdrawn !== target) this.notifyTargetRegistration(withdrawn);
    return withdrawn;
  }

  public adoptExactGroupApplicationForSession(input: Readonly<{
    sessionId: string;
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
    profileId: string;
    generation: number;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
  }>): ConnectedServiceRuntimeTarget | null {
    const sessionId = normalizeString(input.sessionId);
    const groupId = normalizeString(input.groupId);
    const profileId = normalizeString(input.profileId);
    const generation = Math.trunc(Number(input.generation));
    if (!sessionId || !groupId || !profileId || !Number.isFinite(generation) || generation < 0) {
      return null;
    }
    const target = this.getBySessionId(sessionId);
    if (!target) return null;
    if (target.activeBindings.some((binding) => (
      binding.serviceId === input.serviceId
      && binding.groupId === groupId
      && binding.profileId === profileId
      && binding.groupGeneration === generation
      && binding.credentialRevision === input.credentialRevision
    ))) {
      const observations = new Map(this.providerObservationTimes.get(target));
      const key = `${input.serviceId}\0${groupId}`;
      observations.set(key, Math.max(observations.get(key) ?? 0, Date.now()));
      this.providerObservationTimes.set(target, observations);
      return target;
    }
    const connectedServiceSelectionsEnv = buildExactGroupApplicationSelectionEnv(target, {
      serviceId: input.serviceId,
      groupId,
      profileId,
      generation,
      credentialRevision: input.credentialRevision,
    });
    if (!connectedServiceSelectionsEnv) return null;
    const updated = this.writeTarget(target.pid, {
      pid: target.pid,
      connectedServiceSelectionsEnv,
    }, target, { preserveObservedBindings: false });
    const observations = new Map(this.providerObservationTimes.get(updated));
    const key = `${input.serviceId}\0${groupId}`;
    observations.set(key, Math.max(observations.get(key) ?? 0, Date.now()));
    this.providerObservationTimes.set(updated, observations);
    this.carryGroupApplicationLineage(target, updated);
    if (updated !== target) this.notifyTargetRegistration(updated);
    return updated;
  }

  /** Provider identity proves the account, independently of desired child materialization. */
  public adoptProviderObservedGroupAccountForSession(input: Readonly<{
    sessionId: string;
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
    profileId: string;
    observedAtMs: number;
  }>): ConnectedServiceRuntimeTarget | null {
    const existing = this.getBySessionId(input.sessionId);
    const profileId = normalizeString(input.profileId);
    const groupId = normalizeString(input.groupId);
    if (!existing || !profileId || !groupId || !Number.isFinite(input.observedAtMs) || input.observedAtMs < 0) return null;
    const binding = existing.activeBindings.find((candidate) => (
      candidate.serviceId === input.serviceId && candidate.groupId === groupId
    ));
    if (!binding) return null;
    const key = `${input.serviceId}\0${groupId}`;
    const observations = new Map(this.providerObservationTimes.get(existing));
    if (input.observedAtMs <= (observations.get(key) ?? -1)) return null;
    observations.set(key, input.observedAtMs);
    if (binding.profileId === profileId) {
      this.providerObservationTimes.set(existing, observations);
      return existing;
    }
    const updated = this.writeTarget(existing.pid, {
      pid: existing.pid,
    }, existing, {
      activeBindings: existing.activeBindings.map((candidate) => candidate === binding ? {
        ...candidate, profileId, groupGeneration: null, credentialRevision: null,
      } : candidate),
    });
    this.providerObservationTimes.set(updated, observations);
    return updated;
  }

  public resolveExactSessionGroupApplicationTarget(target: ConnectedServiceRuntimeTarget): ConnectedServiceRuntimeTarget | null {
    if (!this.isInRequesterScope(target)) return null;
    const current = this.getIndexedAtKey(target)?.target;
    if (!current || current.pid !== target.pid || current.sessionId !== target.sessionId) return null;
    if (current === target) return current;
    const lineage = this.exactApplicationLineageByTarget.get(target);
    return lineage !== undefined && lineage === this.exactApplicationLineageByTarget.get(current)
      ? current
      : null;
  }

  /** The process exited: every Session target and run target it hosted ends with it. */
  public unregisterPid(pidRaw: number): ConnectedServiceRuntimeTarget | null {
    const pid = normalizePid(pidRaw);
    if (pid === null) return null;
    // A dead runner's execution runs are dead too: drop run targets bound to this pid.
    this.dropRunTargetsForPid(pid);
    const hosted = this.listIndexedSessionTargetsForProcess(pid);
    for (const [key] of hosted) this.sessionTargetsByKey.delete(key);
    return hosted[0]?.[1].target ?? null;
  }

  /** One Session ended while its process may keep hosting others: drop exactly its current target. */
  public unregisterTarget(target: ConnectedServiceRuntimeTarget): ConnectedServiceRuntimeTarget | null {
    const key = sessionTargetKey(target);
    const current = this.sessionTargetsByKey.get(key);
    if (current?.target !== target || !this.isInRequesterScope(target)) return null;
    this.sessionTargetsByKey.delete(key);
    return target;
  }

  /** A wrapper→runner promotion moves the process's targets to the runner pid. */
  public transferPid(fromPidRaw: number, toPidRaw: number): ConnectedServiceRuntimeTarget | null {
    const fromPid = normalizePid(fromPidRaw);
    const toPid = normalizePid(toPidRaw);
    if (fromPid === null || toPid === null) return null;
    const moving = this.listIndexedSessionTargetsForProcess(fromPid);
    if (moving.length === 0) return null;
    if (fromPid === toPid) return moving[0]![1].target;
    const nextTargets = moving.map(([key, existing]) => ({ key, existing, nextBase: {
      ...existing.target,
      pid: toPid,
      revision: existing.target.revision + 1,
    } }));
    // The runner now owns `toPid`: any target still recorded there belongs to a gone process.
    const replacedKeys: string[] = [];
    for (const [key, entry] of this.sessionTargetsByKey) {
      if (entry.target.pid !== toPid) continue;
      if (!this.isInRequesterScope(entry.target)) return null;
      replacedKeys.push(key);
    }
    if (nextTargets.some(({ nextBase }) => !this.isInRequesterScope(nextBase))) return null;
    // A respawned runner does not carry its old process's runs; resumed runs re-materialize
    // and re-register under the new runner pid.
    this.dropRunTargetsForPid(fromPid);
    for (const key of replacedKeys) this.sessionTargetsByKey.delete(key);
    for (const { key } of nextTargets) this.sessionTargetsByKey.delete(key);
    let first: ConnectedServiceRuntimeTarget | null = null;
    for (const { existing, nextBase } of nextTargets) {
      const next = nextBase as ConnectedServiceRuntimeTarget;
      const observations = this.providerObservationTimes.get(existing.target);
      if (observations) this.providerObservationTimes.set(next, observations);
      this.sessionTargetsByKey.set(sessionTargetKey(next), { target: next, fingerprint: buildTargetFingerprint(omitRevision(next)) });
      this.notifyTargetRegistration(next);
      first ??= next;
    }
    return first;
  }

  /** The process's only target (its pending bootstrap first); null when it hosts several Sessions. */
  public getByPid(pidRaw: number): ConnectedServiceRuntimeTarget | null {
    return this.getIndexedForProcess(pidRaw)?.target ?? null;
  }

  /**
   * The target of one Session on one process: its own Session target, else its spawn's own
   * not-yet-adopted bootstrap, else, for a process whose only target is an unattributed bootstrap,
   * that bootstrap. Never another Session's or another spawn's target.
   */
  public getSessionTarget(
    pidRaw: number,
    sessionIdRaw: string | null | undefined,
    spawnTrackingKey?: string,
  ): ConnectedServiceRuntimeTarget | null {
    const sessionId = normalizeString(sessionIdRaw);
    const own = (sessionId ? this.getIndexedSessionTarget(pidRaw, sessionId) : null)
      ?? (spawnTrackingKey ? this.getIndexedBootstrap(pidRaw, spawnTrackingKey) : null);
    if (own) return own.target;
    const pid = normalizePid(pidRaw);
    if (pid === null) return null;
    const hosted = this.listIndexedSessionTargetsForProcess(pid);
    const lone = hosted.length === 1 ? hosted[0]![1].target : null;
    return lone && !lone.sessionId && !lone.spawnTrackingKey ? lone : null;
  }

  public getBySessionId(sessionIdRaw: string): ConnectedServiceRuntimeTarget | null {
    const sessionId = normalizeString(sessionIdRaw);
    if (!sessionId) return null;
    const indexed = this.sessionTargetsByKey.get(sessionTargetKey({ pid: 0, sessionId }));
    return indexed && this.isInRequesterScope(indexed.target) ? indexed.target : null;
  }

  public getRunTargetByRunKey(runKeyRaw: string): ConnectedServiceRuntimeTarget | null {
    const runKey = normalizeString(runKeyRaw);
    const target = runKey ? this.runTargetsByRunKey.get(runKey)?.target ?? null : null;
    return target && this.isInRequesterScope(target) ? target : null;
  }

  public adoptExactCredentialRevisionForRun(input: Readonly<{
    runKey: string;
    target: ConnectedServiceRuntimeTarget;
    serviceId: ConnectedAccountServiceKey;
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
  }>): ConnectedServiceRuntimeTarget | null {
    const runKey = normalizeString(input.runKey);
    const indexed = runKey ? this.runTargetsByRunKey.get(runKey) : null;
    if (!runKey || !indexed || indexed.target !== input.target || !this.isInRequesterScope(indexed.target)) return null;
    return this.adoptExactCredentialRevisionForTarget(input);
  }

  public adoptExactCredentialRevisionForTarget(input: Readonly<{
    target: ConnectedServiceRuntimeTarget;
    serviceId: ConnectedAccountServiceKey;
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
  }>): ConnectedServiceRuntimeTarget | null {
    if (!this.isInRequesterScope(input.target)) return null;
    const runEntry = [...this.runTargetsByRunKey.entries()].find(([, entry]) => entry.target === input.target);
    const indexed = runEntry?.[1] ?? this.getIndexedAtKey(input.target);
    if (!indexed || indexed.target !== input.target) return null;
    const next = this.buildExactCredentialRevisionTarget(input);
    if (!next) return null;
    if (next.target === input.target) return input.target;
    if (runEntry) this.runTargetsByRunKey.set(runEntry[0], next);
    else this.sessionTargetsByKey.set(sessionTargetKey(input.target), next);
    this.notifyTargetRegistration(next.target);
    return next.target;
  }

  public resolveExactSessionCredentialRevisionTarget(input: Readonly<{
    target: ConnectedServiceRuntimeTarget;
    serviceId: ConnectedAccountServiceKey;
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
  }>): ConnectedServiceRuntimeTarget | null {
    const current = input.target.sessionId ? this.getBySessionId(input.target.sessionId) : null;
    if (!current || current.pid !== input.target.pid) return null;
    return this.matchExactCredentialRevisionTarget(current, input);
  }

  public resolveExactRunCredentialRevisionTarget(input: Readonly<{
    runKey: string;
    target: ConnectedServiceRuntimeTarget;
    serviceId: ConnectedAccountServiceKey;
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
  }>): ConnectedServiceRuntimeTarget | null {
    const current = this.getRunTargetByRunKey(input.runKey);
    return current ? this.matchExactCredentialRevisionTarget(current, input) : null;
  }

  private matchExactCredentialRevisionTarget(current: ConnectedServiceRuntimeTarget, input: Readonly<{
    target: ConnectedServiceRuntimeTarget;
    serviceId: ConnectedAccountServiceKey;
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
  }>): ConnectedServiceRuntimeTarget | null {
    const expected = this.buildExactCredentialRevisionTarget(input);
    if (!expected || current.revision !== expected.target.revision
      || current.agentLaunchMaterials !== expected.target.agentLaunchMaterials
      || buildTargetFingerprint(omitRevision(current)) !== expected.fingerprint) return null;
    return current;
  }

  private buildExactCredentialRevisionTarget(input: Readonly<{
    target: ConnectedServiceRuntimeTarget;
    serviceId: ConnectedAccountServiceKey;
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
  }>): IndexedTarget | null {
    const indexed = { target: input.target, fingerprint: buildTargetFingerprint(omitRevision(input.target)) };
    const selection = indexed.target.connectedServiceSelections.find((candidate) => candidate.serviceId === input.serviceId);
    if (!selection || selection.credentialRevision !== input.expectedCredentialRevision) return null;
    if (selection.credentialRevision === input.credentialRevision) return indexed;
    const serialized = serializeConnectedServiceChildSelectionValues(indexed.target.connectedServiceSelections.map((candidate) =>
      candidate === selection ? { ...candidate, credentialRevision: input.credentialRevision } : candidate));
    if (!serialized) return null;
    // The daemon's settled refresh proof advances only this exact live binding. Scope
    // identity, pool member/generation and all other service revisions stay intact.
    return this.buildStandaloneTarget({
      ...indexed.target,
      connectedServiceSelectionsEnv: { ...indexed.target.connectedServiceSelectionsEnv,
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: serialized },
    }, indexed.target);
  }

  public isRunTarget(target: ConnectedServiceRuntimeTarget): boolean {
    if (!this.isInRequesterScope(target)) return false;
    for (const entry of this.runTargetsByRunKey.values()) {
      if (this.matchesCurrentTargetProjection(entry.target, target)) return true;
    }
    return false;
  }

  public isSessionTarget(target: ConnectedServiceRuntimeTarget): boolean {
    const current = this.getIndexedAtKey(target)?.target;
    return Boolean(current && this.matchesCurrentTargetProjection(current, target));
  }

  private matchesCurrentTargetProjection(current: ConnectedServiceRuntimeTarget, target: ConnectedServiceRuntimeTarget): boolean {
    // Canonical refresh/quota views retain this owner's environment reference. Checking
    // it admits those views without mistaking another same-pid scope or a stale view for
    // current Session/Run authority, even when their structural selections are identical.
    return current.pid === target.pid && current.agentId === target.agentId
      && current.materializationKey === target.materializationKey && current.revision === target.revision
      && current.connectedServiceSelectionsEnv === target.connectedServiceSelectionsEnv;
  }

  public listTargets(): ReadonlyArray<ConnectedServiceRuntimeTarget> {
    return [
      ...Array.from(this.sessionTargetsByKey.values()).map((entry) => entry.target),
      ...Array.from(this.runTargetsByRunKey.values()).map((entry) => entry.target),
    ].filter((target) => this.isInRequesterScope(target)).sort((left, right) => left.pid - right.pid);
  }

  public listRefreshTargets(): ReadonlyArray<ConnectedServiceRuntimeRefreshTarget> {
    return this.listTargets().flatMap((target) => {
      if (!target.agentId || !isCatalogAgentId(target.agentId) || !target.materializationKey || target.boundProfiles.length === 0) {
        return [];
      }
      const view: ConnectedServiceRuntimeRefreshTarget = {
        ...target,
        agentId: target.agentId,
        materializationKey: target.materializationKey,
        bindings: target.boundProfiles,
        childSelectionsByServiceId: target.connectedServiceSelections.length > 0
          ? new Map(target.connectedServiceSelections.map((selection) => [selection.serviceId, selection]))
          : null,
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
      };
      return [view];
    });
  }

  private getIndexedAtKey(target: SessionTargetKeyFields): IndexedTarget | null {
    const indexed = this.sessionTargetsByKey.get(sessionTargetKey(target));
    return indexed && this.isInRequesterScope(indexed.target) ? indexed : null;
  }

  /** The named Session's target, only while it runs in that process. */
  private getIndexedSessionTarget(pidRaw: number, sessionId: string): IndexedTarget | null {
    const pid = normalizePid(pidRaw);
    if (pid === null) return null;
    const indexed = this.getIndexedAtKey({ pid, sessionId });
    return indexed?.target.pid === pid ? indexed : null;
  }

  private getIndexedProcessSlot(pidRaw: number): IndexedTarget | null {
    return this.getIndexedBootstrap(pidRaw, undefined);
  }

  /** A spawn's sessionless bootstrap on that process: by its tracking key, else the process slot. */
  private getIndexedBootstrap(pidRaw: number, spawnTrackingKey: string | undefined): IndexedTarget | null {
    const pid = normalizePid(pidRaw);
    if (pid === null) return null;
    const indexed = this.getIndexedAtKey({ pid, sessionId: null, ...(spawnTrackingKey ? { spawnTrackingKey } : {}) });
    return indexed?.target.pid === pid ? indexed : null;
  }

  /** The process's pending bootstrap, else its only Session target; never one of several. */
  private getIndexedForProcess(pidRaw: number): IndexedTarget | null {
    const pid = normalizePid(pidRaw);
    if (pid === null) return null;
    const bootstrap = this.getIndexedProcessSlot(pid);
    if (bootstrap) return bootstrap;
    const hosted = this.listIndexedSessionTargetsForProcess(pid);
    return hosted.length === 1 ? hosted[0]![1] : null;
  }

  private listIndexedSessionTargetsForProcess(pid: number): Array<[string, IndexedTarget]> {
    const hosted: Array<[string, IndexedTarget]> = [];
    for (const entry of this.sessionTargetsByKey) {
      if (entry[1].target.pid === pid && this.isInRequesterScope(entry[1].target)) hosted.push(entry);
    }
    return hosted;
  }

  private dropRunTargetsForPid(pid: number): void {
    for (const [runKey, entry] of this.runTargetsByRunKey) {
      if (entry.target.pid === pid && this.isInRequesterScope(entry.target)) {
        this.runTargetsByRunKey.delete(runKey);
      }
    }
  }

  // Pure target composition shared by pid-keyed session targets and run-key-keyed run targets.
  private composeTargetBase(
    pid: number,
    patch: ConnectedServiceRuntimeTargetInput | ConnectedServiceRuntimeTargetUpdate,
    previous: ConnectedServiceRuntimeTarget | null,
    options: Readonly<{ activeBindings?: ConnectedServiceRuntimeTarget['activeBindings']; preserveObservedBindings?: boolean }> = {},
  ): Readonly<{ base: Omit<ConnectedServiceRuntimeTarget, 'revision'>; fingerprint: string }> {
    const connectedServiceSelectionsEnv = patch.connectedServiceSelectionsEnv !== undefined
      ? normalizeRuntimeRegistryEnv(patch.connectedServiceSelectionsEnv)
      : patch.connectedServiceSelectionsEnvRaw !== undefined
        ? normalizeRuntimeRegistryEnvRaw(patch.connectedServiceSelectionsEnvRaw)
        : previous?.connectedServiceSelectionsEnv ?? {};
    const connectedServiceSelections = readRuntimeChildSelections(connectedServiceSelectionsEnv);
    const connectedServicesBindingsRaw = patch.connectedServicesBindingsRaw !== undefined
      ? normalizeConnectedServicesBindingsRaw(patch.connectedServicesBindingsRaw)
      : previous?.connectedServicesBindingsRaw ?? {};
    const agentId = patch.agentId !== undefined ? normalizeString(patch.agentId) : previous?.agentId ?? null;
    const sessionId = patch.sessionId !== undefined ? normalizeString(patch.sessionId) : previous?.sessionId ?? null;
    const materializationKey = patch.materializationKey !== undefined
      ? normalizeString(patch.materializationKey)
      : previous?.materializationKey ?? null;
    const connectedServiceMaterializationIdentityV1 = patch.connectedServiceMaterializationIdentityV1 !== undefined
      ? (ConnectedServiceMaterializationIdentityV1Schema.safeParse(patch.connectedServiceMaterializationIdentityV1).success
          ? ConnectedServiceMaterializationIdentityV1Schema.parse(patch.connectedServiceMaterializationIdentityV1)
          : null)
      : previous?.connectedServiceMaterializationIdentityV1 ?? null;
    const spawnTrackingKey = normalizeString(patch.spawnTrackingKey) ?? previous?.spawnTrackingKey;
    const sessionDirectory = patch.sessionDirectory !== undefined
      ? normalizeString(patch.sessionDirectory)
      : previous?.sessionDirectory ?? null;
    const requesterWorkAttributionV1 = patch.requesterWorkAttributionV1 !== undefined
      ? RequesterWorkAttributionV1Schema.parse(patch.requesterWorkAttributionV1)
      : previous?.requesterWorkAttributionV1;
    let boundProfiles = buildRuntimeBoundProfiles({
      connectedServicesBindingsRaw,
      connectedServiceSelections,
    });
    let activeBindings = buildRuntimeActiveBindings({
      connectedServicesBindingsRaw,
      connectedServiceSelections,
    });
    if (options.activeBindings) {
      activeBindings = [...options.activeBindings];
    } else if (options.preserveObservedBindings !== false && previous?.sessionId === sessionId
      && stableRuntimeRegistryFingerprint(previous.connectedServiceSelectionsEnv) === stableRuntimeRegistryFingerprint(connectedServiceSelectionsEnv)
      && stableRuntimeRegistryFingerprint(previous.connectedServicesBindingsRaw) === stableRuntimeRegistryFingerprint(connectedServicesBindingsRaw)) {
      activeBindings = activeBindings.map((binding) => previous.activeBindings.find((observed) => (
        observed.serviceId === binding.serviceId && observed.groupId !== null
        && observed.groupId === binding.groupId && observed.groupGeneration === null
      )) ?? binding);
    }
    if (options.activeBindings || activeBindings.some((binding) => binding.groupId !== null && binding.groupGeneration === null)) {
      boundProfiles = activeBindings.map(({ serviceId, profileId }) => ({ serviceId, profileId }));
    }
    const identity = readConnectedServiceRuntimeTargetIdentity({
      pid,
      sessionId,
      agentId,
      materializationKey,
      activeBindings,
    });
    const runtimeIdentityKey = buildConnectedServiceRuntimeIdentityKey(identity);
    // Process metadata can arrive without another materialization. A changed
    // credential/Agent/key cannot carry the previous selected credential bytes.
    const agentLaunchMaterials = patch.agentLaunchMaterials !== undefined ? patch.agentLaunchMaterials ?? undefined
      : previous?.runtimeIdentityKey === runtimeIdentityKey ? previous.agentLaunchMaterials : undefined;
    const agentLaunchTarget = patch.agentLaunchMaterials ? { runtimeHome: patch.agentLaunchMaterials.runtimeHome,
      ...(patch.agentLaunchMaterials.memberIdentity ? { memberIdentity: patch.agentLaunchMaterials.memberIdentity } : {}) }
      : previous?.agentId === agentId && previous.materializationKey === materializationKey ? previous.agentLaunchTarget : undefined;
    const base = {
      pid,
      agentId,
      sessionId,
      ...(spawnTrackingKey ? { spawnTrackingKey } : {}),
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv,
      connectedServiceSelections,
      materializationKey,
      ...(agentLaunchMaterials ? { agentLaunchMaterials } : {}),
      ...(agentLaunchTarget ? { agentLaunchTarget } : {}),
      connectedServiceMaterializationIdentityV1,
      sessionDirectory,
      ...(requesterWorkAttributionV1 ? { requesterWorkAttributionV1 } : {}),
      ...(patch.exactPurposeBindingSubjectId ?? previous?.exactPurposeBindingSubjectId
        ? { exactPurposeBindingSubjectId: patch.exactPurposeBindingSubjectId ?? previous?.exactPurposeBindingSubjectId }
        : {}),
      boundProfiles,
      activeBindings,
      runtimeIdentityKey,
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
    // Re-observing the same run is not a new target or credential authority.
    if (previous && previous.agentLaunchMaterials === base.agentLaunchMaterials && buildTargetFingerprint(omitRevision(previous)) === fingerprint) {
      return { target: previous, fingerprint };
    }
    const target: ConnectedServiceRuntimeTarget = {
      ...base,
      revision: (previous?.revision ?? 0) + 1,
    };
    return { target, fingerprint };
  }

  private writeTarget(
    pidRaw: number,
    patch: ConnectedServiceRuntimeTargetInput | ConnectedServiceRuntimeTargetUpdate,
    previousAtSlot: ConnectedServiceRuntimeTarget | null,
    options: Readonly<{ activeBindings?: ConnectedServiceRuntimeTarget['activeBindings']; preserveObservedBindings?: boolean }> = {},
  ): ConnectedServiceRuntimeTarget {
    const pid = normalizePid(pidRaw) ?? 0;
    if (previousAtSlot) this.assertRequesterScope(previousAtSlot);
    const sessionId = patch.sessionId !== undefined
      ? normalizeString(patch.sessionId)
      : previousAtSlot?.sessionId ?? null;
    const spawnTrackingKey = normalizeString(patch.spawnTrackingKey) ?? previousAtSlot?.spawnTrackingKey;
    const key = sessionTargetKey({ pid, sessionId, ...(spawnTrackingKey ? { spawnTrackingKey } : {}) });
    // The same Session reattached under another pid, or the slot this write lands in.
    const incumbent = this.sessionTargetsByKey.get(key)?.target ?? null;
    if (incumbent) this.assertRequesterScope(incumbent);
    const previous = previousAtSlot ?? incumbent;
    const { base, fingerprint } = this.composeTargetBase(pid, patch, previous, options);
    this.assertRequesterScope({ ...base, revision: (previous?.revision ?? 0) + 1 });
    if (previous) {
      const previousIndexed = this.sessionTargetsByKey.get(sessionTargetKey(previous));
      if (previousIndexed?.target === previous && previousIndexed.fingerprint === fingerprint
        && previous.agentLaunchMaterials === base.agentLaunchMaterials) {
        return previous;
      }
    }

    const next: ConnectedServiceRuntimeTarget = {
      ...base,
      revision: (previous?.revision ?? 0) + 1,
    };
    this.providerObservationTimes.set(next, new Map(previous ? this.providerObservationTimes.get(previous) : undefined));
    if (previous) {
      const previousKey = sessionTargetKey(previous);
      if (previousKey !== key && this.sessionTargetsByKey.get(previousKey)?.target === previous) {
        this.sessionTargetsByKey.delete(previousKey);
      }
    }
    this.sessionTargetsByKey.set(key, { target: next, fingerprint });
    return next;
  }

  private withRegisteredBindings(target: ConnectedServiceRuntimeTarget): ConnectedServiceRuntimeRegisteredTarget {
    return {
      ...target,
      bindings: target.activeBindings,
    };
  }

  private notifyTargetRegistration(target: ConnectedServiceRuntimeTarget): void {
    for (const listener of this.targetRegistrationListeners) {
      listener(target);
    }
  }
}
