import {
  ConnectedServiceMaterializationIdentityV1Schema,
  type ConnectedServiceCredentialRevisionV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import { isCatalogAgentId } from '@/agent/catalog/resolution';
import {
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  serializeConnectedServiceChildSelectionValues,
} from '../connectedServiceChildEnvironment';

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

function buildExactGroupApplicationSelectionEnv(
  target: ConnectedServiceRuntimeTarget,
  input: Readonly<{
    serviceId: ConnectedServiceId;
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
  if (!matched) return null;
  const serialized = serializeConnectedServiceChildSelectionValues(selections);
  if (!serialized) return null;
  return {
    ...target.connectedServiceSelectionsEnv,
    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: serialized,
  };
}

export class ConnectedServiceRuntimeRegistry {
  private readonly targetsByPid = new Map<number, IndexedTarget>();
  private readonly pidBySessionId = new Map<string, number>();
  private readonly targetRegistrationListeners = new Set<ConnectedServiceRuntimeTargetRegistrationListener>();
  // Execution-run targets live in a SEPARATE keyspace: a run shares its RUNNER's pid with the
  // session target, so keying runs by pid would clobber the session registration (and releasing
  // a run would deregister the session). Run targets are keyed by their stable run key, carry
  // the runner pid for liveness semantics, and are included in the distribution views
  // (listTargets/listRefreshTargets/listQuotaTargets) so refresh + quota coverage applies to
  // materialized run roots exactly like session roots.
  private readonly runTargetsByRunKey = new Map<string, IndexedTarget>();

  public registerTarget(
    input: ConnectedServiceRuntimeTargetInput,
    options?: ConnectedServiceRuntimeTargetRegistrationOptions,
  ): ConnectedServiceRuntimeRegisteredTarget {
    const existing = this.getIndexedByPid(input.pid);
    const sessionId = normalizeString(input.sessionId);
    const currentForSession = sessionId ? this.getBySessionId(sessionId) : null;
    const patch = options?.source === 'bootstrap' && currentForSession
      ? {
          ...input,
          // Bootstrap/reattach data may fill process metadata, but once this logical session has
          // current runtime truth it cannot replace the applied Connected Services identity.
          connectedServicesBindingsRaw: currentForSession.connectedServicesBindingsRaw,
          connectedServiceSelectionsEnv: currentForSession.connectedServiceSelectionsEnv,
          materializationKey: currentForSession.materializationKey,
          connectedServiceMaterializationIdentityV1:
            currentForSession.connectedServiceMaterializationIdentityV1,
        }
      : input;
    const target = this.writeTarget(input.pid, patch, existing?.target ?? null);
    this.notifyTargetRegistration(target);
    return this.withRegisteredBindings(target);
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
    const next = this.buildStandaloneTarget(targetInput, previous);
    this.runTargetsByRunKey.set(runKey, next);
    this.notifyTargetRegistration(next.target);
    return this.withRegisteredBindings(next.target);
  }

  public subscribeTargetRegistrations(
    listener: ConnectedServiceRuntimeTargetRegistrationListener,
  ): () => void {
    this.targetRegistrationListeners.add(listener);
    return () => {
      this.targetRegistrationListeners.delete(listener);
    };
  }

  public unregisterRunKey(runKeyRaw: string): ConnectedServiceRuntimeTarget | null {
    const runKey = normalizeString(runKeyRaw);
    if (!runKey) return null;
    const existing = this.runTargetsByRunKey.get(runKey);
    if (!existing) return null;
    this.runTargetsByRunKey.delete(runKey);
    return existing.target;
  }

  public updateTarget(input: ConnectedServiceRuntimeTargetUpdate): ConnectedServiceRuntimeTarget | null {
    const existing = this.getIndexedByPid(input.pid);
    if (!existing) return null;
    const target = this.writeTarget(input.pid, input, existing.target);
    this.notifyTargetRegistration(target);
    return target;
  }

  public adoptSessionId(input: Readonly<{ pid: number; sessionId?: string | null }>): ConnectedServiceRuntimeTarget | null {
    return this.updateTarget({
      pid: input.pid,
      sessionId: input.sessionId ?? null,
    });
  }

  public adoptExactGroupApplicationForSession(input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
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
    return this.updateTarget({
      pid: target.pid,
      connectedServiceSelectionsEnv,
    });
  }

  public unregisterPid(pidRaw: number): ConnectedServiceRuntimeTarget | null {
    const pid = normalizePid(pidRaw);
    if (pid === null) return null;
    // A dead runner's execution runs are dead too: drop run targets bound to this pid.
    this.dropRunTargetsForPid(pid);
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
    // A respawned runner does not carry its old process's runs; resumed runs re-materialize
    // and re-register under the new runner pid.
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
    this.notifyTargetRegistration(next);
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

  public getRunTargetByRunKey(runKeyRaw: string): ConnectedServiceRuntimeTarget | null {
    const runKey = normalizeString(runKeyRaw);
    return runKey ? this.runTargetsByRunKey.get(runKey)?.target ?? null : null;
  }

  public isRunTarget(target: ConnectedServiceRuntimeTarget): boolean {
    for (const entry of this.runTargetsByRunKey.values()) {
      if (entry.target === target) return true;
    }
    return false;
  }

  public listTargets(): ReadonlyArray<ConnectedServiceRuntimeTarget> {
    return [
      ...Array.from(this.targetsByPid.values()).map((entry) => entry.target),
      ...Array.from(this.runTargetsByRunKey.values()).map((entry) => entry.target),
    ].sort((left, right) => left.pid - right.pid);
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

  private getIndexedByPid(pidRaw: number): IndexedTarget | null {
    const pid = normalizePid(pidRaw);
    if (pid === null) return null;
    return this.targetsByPid.get(pid) ?? null;
  }

  private dropRunTargetsForPid(pid: number): void {
    for (const [runKey, entry] of this.runTargetsByRunKey) {
      if (entry.target.pid === pid) {
        this.runTargetsByRunKey.delete(runKey);
      }
    }
  }

  // Pure target composition shared by pid-keyed session targets and run-key-keyed run targets.
  private composeTargetBase(
    pid: number,
    patch: ConnectedServiceRuntimeTargetInput | ConnectedServiceRuntimeTargetUpdate,
    previous: ConnectedServiceRuntimeTarget | null,
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
    const sessionDirectory = patch.sessionDirectory !== undefined
      ? normalizeString(patch.sessionDirectory)
      : previous?.sessionDirectory ?? null;
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
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv,
      connectedServiceSelections,
      materializationKey,
      connectedServiceMaterializationIdentityV1,
      sessionDirectory,
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
    if (!target.sessionId) return;
    if (this.pidBySessionId.get(target.sessionId) === target.pid) {
      this.pidBySessionId.delete(target.sessionId);
    }
  }

  private indexSession(target: ConnectedServiceRuntimeTarget): void {
    if (!target.sessionId) return;
    this.pidBySessionId.set(target.sessionId, target.pid);
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
