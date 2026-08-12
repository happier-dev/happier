import { PluginError, type Disposable } from '@happier-dev/plugin-sdk';
import type {
  PluginConnectedAccountBindingSummary,
  PluginConnectedAccountMaterialization,
  PluginConnectedAccountMaterializationRequest,
  PluginContributionRef,
} from '@happier-dev/plugin-sdk/runtime';
import {
  QualifiedConnectedAccountPurposeBindingsV1Schema,
  QualifiedConnectedAccountPurposeBindingV1Schema,
  QualifiedConnectedAccountPurposeBindingTargetV1Schema,
  QualifiedConnectedAccountPurposeV1Schema,
  QualifiedConnectedAccountRequestAuthUseV1Schema,
  PluginContributionIdentityV1Schema,
  qualifiedPurposeKey,
  type PluginContributionIdentityV1,
  type QualifiedConnectedAccountPurposeBindingsV1,
  type QualifiedConnectedAccountPurposeBindingV1,
  type QualifiedConnectedAccountPurposeBindingTargetV1,
  type QualifiedConnectedAccountPurposeV1,
  type QualifiedConnectedAccountRequestAuthUseV1,
  type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

import {
  readActivePluginAccountSettings,
  updateActivePluginAccountSettings,
} from '@/plugins/runtime/context/accountSettingsStorage';
import {
  subscribeActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type {
  HostCurrentSessionUiServices,
} from '@/agent/runtime/state/currentSessionUiTypes';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import type {
  StablePluginConnectedAccountsOwner,
} from '@/plugins/runtime/invocation/services/connectedAccounts';
import {
  ConnectedAccountRequestAuthError,
  type ConnectedAccountRequestAuthPurposeUse,
  type ConnectedAccountRequestAuthSubject,
} from '../requestAuth/ConnectedAccountRequestAuthService';

export type ConnectedAccountPurposeBindingStore = Readonly<{
  read(signal?: AbortSignal): Promise<QualifiedConnectedAccountPurposeBindingsV1>;
  update(
    mutate: (
      current: QualifiedConnectedAccountPurposeBindingsV1,
    ) => QualifiedConnectedAccountPurposeBindingsV1,
    signal?: AbortSignal,
  ): Promise<QualifiedConnectedAccountPurposeBindingsV1>;
  subscribe(listener: () => void): Disposable;
}>;

export type ConnectedAccountPurposeResolvedTarget = Readonly<{
  displayName: string;
  /** Exact current account. Group intent is resolved here, at read/materialization time. */
  account: QualifiedConnectedAccountRef;
}>;

export type ConnectedAccountPurposeBindingOwnerDependencies = Readonly<{
  store: ConnectedAccountPurposeBindingStore;
  /** Genuine UI/policy boundary: the owner validates this result before persistence. */
  selectTarget(input: Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1;
    serviceRefs: readonly PluginContributionRef[];
    currentSession?: HostCurrentSessionUiServices;
    reason: string;
    signal: AbortSignal;
  }>): Promise<QualifiedConnectedAccountPurposeBindingTargetV1>;
  /** Canonical account/group projection boundary. Returns null for removed or unavailable truth. */
  resolveTarget(
    target: QualifiedConnectedAccountPurposeBindingTargetV1,
    signal: AbortSignal,
  ): Promise<ConnectedAccountPurposeResolvedTarget | null>;
  /** Producer-owned materializer boundary for the exact resolved current account. */
  materializeAccount(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    request: PluginConnectedAccountMaterializationRequest;
    signal: AbortSignal;
  }>): Promise<PluginConnectedAccountMaterialization>;
  /** Account/group/credential/materializer invalidations not represented by the binding store. */
  subscribeInvalidations?: (listener: () => void) => Disposable;
}>;

export type ConnectedAccountPurposeAuthorizationScope = Readonly<{
  purpose: QualifiedConnectedAccountPurposeV1;
  serviceRefs: readonly PluginContributionRef[];
}>;

export type ConnectedAccountPurposeBindingSubject =
  | Readonly<{
      kind: 'session';
      sessionId: string;
    }>
  | Readonly<{
      kind: 'execution_run';
      runId: string;
      runnerPid: number;
      agentId: CatalogAgentId;
      isCurrent(): boolean;
    }>
  | Readonly<{
      kind: 'agent_catalog_observation';
      operationId: string;
      consumer: PluginContributionIdentityV1;
      isCurrent(): boolean;
    }>;

export type ConnectedAccountPurposeBindingLease = Readonly<{
  subjectId: string;
  isCurrent(): boolean;
  resolvePurposeBinding(
    purpose: QualifiedConnectedAccountPurposeV1,
  ): QualifiedConnectedAccountPurposeBindingV1 | null;
  listPurposeBindings(): readonly QualifiedConnectedAccountPurposeBindingV1[];
  dispose(): void;
}>;

export type ConnectedAccountSessionPurposeBindingLease =
  ConnectedAccountPurposeBindingLease;

export type ConnectedAccountSessionPurposeBindingSnapshot = Readonly<{
  purposes: readonly QualifiedConnectedAccountPurposeV1[];
  bindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
}>;

/**
 * Canonical composition boundary for a session's complete Agent + managed Provider purpose
 * authority. Any overlap is rejected even when the two snapshots happen to select the same target:
 * two producers must never silently co-own one purpose.
 */
export function composeConnectedAccountSessionPurposeBindingSnapshot(
  snapshots: readonly ConnectedAccountSessionPurposeBindingSnapshot[],
): ConnectedAccountSessionPurposeBindingSnapshot {
  const purposes: QualifiedConnectedAccountPurposeV1[] = [];
  const bindings: QualifiedConnectedAccountPurposeBindingV1[] = [];
  const purposeKeys = new Set<string>();

  for (const snapshot of snapshots) {
    const snapshotPurposeKeys = new Set<string>();
    for (const purposeLike of snapshot.purposes) {
      const purpose = QualifiedConnectedAccountPurposeV1Schema.parse(purposeLike);
      const key = qualifiedPurposeKey(purpose);
      if (purposeKeys.has(key)) {
        throw new Error(
          'connected_account_session_binding_snapshot_duplicate_purpose',
        );
      }
      purposeKeys.add(key);
      snapshotPurposeKeys.add(key);
      purposes.push(Object.freeze(purpose));
    }
    const parsedBindings = QualifiedConnectedAccountPurposeBindingsV1Schema.parse({
      v: 1,
      bindings: snapshot.bindings,
    }).bindings;
    const snapshotBindingKeys = new Set<string>();
    for (const binding of parsedBindings) {
      const key = qualifiedPurposeKey(binding.purpose);
      if (!snapshotPurposeKeys.has(key)) {
        throw new Error(
          'connected_account_session_binding_snapshot_undeclared_purpose',
        );
      }
      if (snapshotBindingKeys.has(key)) {
        throw new Error(
          'connected_account_session_binding_snapshot_duplicate_binding',
        );
      }
      snapshotBindingKeys.add(key);
      bindings.push(immutableBinding(binding));
    }
  }

  return Object.freeze({
    purposes: Object.freeze(purposes),
    bindings: Object.freeze(bindings),
  });
}

/**
 * Least-privilege request-auth view over one canonical session lease. This view owns no
 * selection, lifecycle, or currentness state; it only filters exact purposes while delegating
 * every authority decision to the union lease.
 */
export function scopeConnectedAccountPurposeBindingLease(input: Readonly<{
  lease: ConnectedAccountPurposeBindingLease;
  subjectId: string;
  uses: readonly QualifiedConnectedAccountRequestAuthUseV1[];
  registerRedaction: ConnectedAccountRequestAuthSubject['registerRedaction'];
}>): ConnectedAccountRequestAuthSubject {
  const subjectId = input.subjectId.trim();
  if (!subjectId) {
    throw new Error('connected_account_session_binding_scope_subject_id_required');
  }
  const useByPurposeKey = new Map<string, QualifiedConnectedAccountRequestAuthUseV1>();
  for (const useLike of input.uses) {
    const use = QualifiedConnectedAccountRequestAuthUseV1Schema.parse({
      purpose: {
        consumer: { ...useLike.purpose.consumer },
        purpose: useLike.purpose.purpose,
      },
      materialization: {
        ...useLike.materialization,
        headerNames: [...useLike.materialization.headerNames],
      },
    });
    const key = qualifiedPurposeKey(use.purpose);
    if (useByPurposeKey.has(key)) {
      throw new Error('connected_account_session_binding_scope_duplicate_purpose');
    }
    useByPurposeKey.set(key, Object.freeze({
      purpose: Object.freeze({
        consumer: Object.freeze({ ...use.purpose.consumer }),
        purpose: use.purpose.purpose,
      }),
      materialization: Object.freeze({
        ...use.materialization,
        headerNames: Object.freeze([...use.materialization.headerNames]),
      }),
    }));
  }
  const isCurrent = (): boolean => input.lease.isCurrent();
  return Object.freeze({
    subjectId,
    isCurrent,
    registerRedaction(values) {
      if (!isCurrent()) {
        throw new ConnectedAccountRequestAuthError('request_auth_not_active');
      }
      input.registerRedaction(values);
    },
    resolvePurposeUse(rawPurpose) {
      const purpose = QualifiedConnectedAccountPurposeV1Schema.parse(rawPurpose);
      const use = useByPurposeKey.get(qualifiedPurposeKey(purpose));
      if (!use) return null;
      const binding = input.lease.resolvePurposeBinding(purpose);
      return binding ? Object.freeze({ binding, use }) : null;
    },
    listPurposeUses() {
      if (!isCurrent()) return Object.freeze([]);
      const purposeUses: ConnectedAccountRequestAuthPurposeUse[] = [];
      for (const binding of input.lease.listPurposeBindings()) {
        const use = useByPurposeKey.get(qualifiedPurposeKey(binding.purpose));
        if (use) purposeUses.push(Object.freeze({ binding, use }));
      }
      return Object.freeze(purposeUses);
    },
  });
}

export const scopeConnectedAccountSessionPurposeBindingLease =
  scopeConnectedAccountPurposeBindingLease;

export type ConnectedAccountPurposeBindingOwner =
  StablePluginConnectedAccountsOwner & Readonly<{
    /**
     * Canonical immutable launch snapshot for either a primary Agent session or one exact
     * execution-run owner. The run subject remains current only while its captured runner,
     * Agent generation, and bridge ownership remain exact.
     */
    activatePurposeBindings(input: Readonly<{
      subject: ConnectedAccountPurposeBindingSubject;
      purposes: readonly QualifiedConnectedAccountPurposeV1[];
      bindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
    }>): ConnectedAccountPurposeBindingLease;
    /**
     * Installs one immutable, launch-scoped compatibility projection. Every declared purpose is
     * covered, including explicitly unbound/native purposes, so durable defaults cannot silently
     * replace launch intent. The returned lease is also the request-auth subject.
     */
    activateSessionPurposeBindings(input: Readonly<{
      sessionId: string;
      purposes: readonly QualifiedConnectedAccountPurposeV1[];
      bindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
    }>): ConnectedAccountSessionPurposeBindingLease;
    resolveBindingIntent(input: Readonly<{
      purpose: QualifiedConnectedAccountPurposeV1;
      target: QualifiedConnectedAccountPurposeBindingTargetV1;
      serviceRefs: readonly PluginContributionRef[];
      signal: AbortSignal;
    }>): Promise<QualifiedConnectedAccountPurposeBindingV1>;
    /**
     * Atomic generation-adoption contraction for the complete previous/current consumer union.
     * Call once after candidate validation and before publication. A removed consumer is
     * represented by an empty authorizedPurposes list.
     */
    reconcileAuthorizedPurposes(input: Readonly<{
      consumerScopes: readonly Readonly<{
        consumer: PluginContributionIdentityV1;
        authorizedPurposes: readonly ConnectedAccountPurposeAuthorizationScope[];
      }>[];
      signal: AbortSignal;
      /** Synchronous, non-throwing candidate publication while affected consumer locks remain held. */
      publish(): void;
    }>): Promise<void>;
  }>;

function contributionKey(ref: Readonly<{ pluginId: string; localId: string }>): string {
  return JSON.stringify([ref.pluginId, ref.localId]);
}

function targetService(
  target: QualifiedConnectedAccountPurposeBindingTargetV1,
): PluginContributionRef {
  return target.kind === 'account' ? target.account.service : target.service;
}

function targetKey(target: QualifiedConnectedAccountPurposeBindingTargetV1): string {
  return JSON.stringify(target);
}

function resourceNotSelected(purpose: QualifiedConnectedAccountPurposeV1): PluginError {
  return new PluginError({
    code: 'plugin_host_access_resource_not_selected',
    message: `Connected Accounts purpose '${purpose.purpose}' is not selected`,
  });
}

function bindingOutOfScope(): PluginError {
  return new PluginError({
    code: 'plugin_connected_account_binding_out_of_scope',
    message: 'Connected Accounts selection is outside the authorized service scope',
  });
}

function assertTargetAuthorized(
  target: QualifiedConnectedAccountPurposeBindingTargetV1,
  serviceRefs: readonly PluginContributionRef[],
): void {
  const selectedServiceKey = contributionKey(targetService(target));
  if (!serviceRefs.some((service) => contributionKey(service) === selectedServiceKey)) {
    throw bindingOutOfScope();
  }
}

function replacePurposeBinding(
  collectionLike: QualifiedConnectedAccountPurposeBindingsV1,
  purpose: QualifiedConnectedAccountPurposeV1,
  target: QualifiedConnectedAccountPurposeBindingTargetV1 | null,
): QualifiedConnectedAccountPurposeBindingsV1 {
  const collection = QualifiedConnectedAccountPurposeBindingsV1Schema.parse(collectionLike);
  const key = qualifiedPurposeKey(purpose);
  return QualifiedConnectedAccountPurposeBindingsV1Schema.parse({
    v: 1,
    bindings: [
      ...collection.bindings.filter((binding) => qualifiedPurposeKey(binding.purpose) !== key),
      ...(target ? [{ purpose, target }] : []),
    ].sort((left, right) => qualifiedPurposeKey(left.purpose).localeCompare(qualifiedPurposeKey(right.purpose))),
  });
}

function readPurposeBinding(
  collectionLike: QualifiedConnectedAccountPurposeBindingsV1,
  purpose: QualifiedConnectedAccountPurposeV1,
): QualifiedConnectedAccountPurposeBindingTargetV1 | null {
  const key = qualifiedPurposeKey(purpose);
  return QualifiedConnectedAccountPurposeBindingsV1Schema.parse(collectionLike)
    .bindings
    .find((binding) => qualifiedPurposeKey(binding.purpose) === key)
    ?.target ?? null;
}

function parsePurposeBindingsOrEmpty(value: unknown): QualifiedConnectedAccountPurposeBindingsV1 {
  const parsed = QualifiedConnectedAccountPurposeBindingsV1Schema.safeParse(value);
  return parsed.success ? parsed.data : { v: 1, bindings: [] };
}

function assertResolvedTargetMatchesIntent(
  target: QualifiedConnectedAccountPurposeBindingTargetV1,
  resolved: ConnectedAccountPurposeResolvedTarget,
): void {
  const intendedService = contributionKey(targetService(target));
  if (contributionKey(resolved.account.service) !== intendedService) {
    throw new Error('connected_account_purpose_resolution_service_mismatch');
  }
  if (
    target.kind === 'account'
    && (
      resolved.account.accountId !== target.account.accountId
      || contributionKey(resolved.account.service) !== contributionKey(target.account.service)
    )
  ) {
    throw new Error('connected_account_purpose_resolution_account_mismatch');
  }
}

function summary(
  purpose: QualifiedConnectedAccountPurposeV1,
  target: QualifiedConnectedAccountPurposeBindingTargetV1,
  resolved: ConnectedAccountPurposeResolvedTarget,
): PluginConnectedAccountBindingSummary {
  return Object.freeze({
    purpose: purpose.purpose,
    service: Object.freeze({ ...targetService(target) }),
    target: Object.freeze({
      kind: target.kind,
      displayName: resolved.displayName,
    }),
  });
}

function immutableBinding(
  bindingLike: QualifiedConnectedAccountPurposeBindingV1,
): QualifiedConnectedAccountPurposeBindingV1 {
  const binding = QualifiedConnectedAccountPurposeBindingV1Schema.parse(bindingLike);
  return Object.freeze({
    purpose: Object.freeze({
      consumer: Object.freeze({ ...binding.purpose.consumer }),
      purpose: binding.purpose.purpose,
    }),
    target: binding.target.kind === 'account'
      ? Object.freeze({
          kind: 'account' as const,
          account: Object.freeze({
            service: Object.freeze({ ...binding.target.account.service }),
            accountId: binding.target.account.accountId,
          }),
        })
      : Object.freeze({
          kind: 'group' as const,
          service: Object.freeze({ ...binding.target.service }),
          groupId: binding.target.groupId,
        }),
  });
}

export function createConnectedAccountPurposeBindingOwner(
  dependencies: ConnectedAccountPurposeBindingOwnerDependencies,
): ConnectedAccountPurposeBindingOwner {
  type PurposeBindingState = Readonly<{
    subjectId: string;
    isSubjectCurrent(): boolean;
    coveredPurposeKeys: ReadonlySet<string>;
    bindingByPurposeKey: ReadonlyMap<string, QualifiedConnectedAccountPurposeBindingV1>;
    bindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
  }>;
  const purposeBindingsBySubjectKey = new Map<string, PurposeBindingState>();
  const sessionInvalidationListenersBySessionId = new Map<string, Set<() => void>>();
  const sessionSubjectKey = (sessionId: string): string =>
    JSON.stringify(['session', sessionId]);
  const notifySessionInvalidations = (sessionId: string): void => {
    for (const listener of sessionInvalidationListenersBySessionId.get(sessionId) ?? []) {
      listener();
    }
  };
  const readSessionPurposeBinding = (input: Readonly<{
    sessionId?: string;
    purpose: QualifiedConnectedAccountPurposeV1;
  }>): Readonly<{
    covered: boolean;
    binding: QualifiedConnectedAccountPurposeBindingV1 | null;
  }> => {
    if (!input.sessionId) return { covered: false, binding: null };
    const state = purposeBindingsBySubjectKey.get(
      sessionSubjectKey(input.sessionId),
    );
    const purposeKey = qualifiedPurposeKey(input.purpose);
    if (!state?.coveredPurposeKeys.has(purposeKey)) {
      return { covered: false, binding: null };
    }
    return {
      covered: true,
      binding: state.bindingByPurposeKey.get(purposeKey) ?? null,
    };
  };
  const consumerMutationTails = new Map<string, Promise<void>>();
  const acquireSerializedConsumerMutations = async (
    consumerKeysLike: readonly string[],
  ): Promise<() => void> => {
    const reservations = [...new Set(consumerKeysLike)].sort().map((consumerKey) => {
      const previous = consumerMutationTails.get(consumerKey) ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => held);
      consumerMutationTails.set(consumerKey, tail);
      return { consumerKey, previous, release, tail };
    });
    await Promise.all(reservations.map(({ previous }) => previous));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const reservation of reservations) {
        reservation.release();
        if (consumerMutationTails.get(reservation.consumerKey) === reservation.tail) {
          consumerMutationTails.delete(reservation.consumerKey);
        }
      }
    };
  };
  const withSerializedConsumerMutations = async <T>(
    consumerKeysLike: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> => {
    const release = await acquireSerializedConsumerMutations(consumerKeysLike);
    try {
      return await operation();
    } finally {
      release();
    }
  };
  const cleanupSignal = new AbortController().signal;

  const activatePurposeBindings: ConnectedAccountPurposeBindingOwner[
    'activatePurposeBindings'
  ] = (input) => {
    const subject = input.subject;
    const normalized = subject.kind === 'session'
      ? (() => {
          const sessionId = subject.sessionId.trim();
          if (!sessionId) {
            throw new Error(
              'connected_account_session_binding_session_id_required',
            );
          }
          return {
            subjectKey: sessionSubjectKey(sessionId),
            subjectId: `agent-session:${sessionId}`,
            isSubjectCurrent: () => true,
            sessionId,
            errorPrefix: 'connected_account_session_binding',
            expectedConsumer: null,
          };
        })()
      : subject.kind === 'execution_run'
        ? (() => {
            const runId = subject.runId.trim();
            const agentId = subject.agentId.trim();
            if (!runId) {
              throw new Error(
                'connected_account_execution_run_binding_run_id_required',
              );
            }
            if (!Number.isInteger(subject.runnerPid) || subject.runnerPid <= 0) {
              throw new Error(
                'connected_account_execution_run_binding_runner_pid_required',
              );
            }
            if (!agentId) {
              throw new Error(
                'connected_account_execution_run_binding_agent_id_required',
              );
            }
            return {
              subjectKey: JSON.stringify(['execution_run', runId]),
              subjectId:
                `execution-run:${runId}/runner:${subject.runnerPid}/agent:${agentId}`,
              isSubjectCurrent: subject.isCurrent,
              sessionId: null,
              errorPrefix: 'connected_account_execution_run_binding',
              expectedConsumer: null,
            };
          })()
        : (() => {
            const operationId = subject.operationId.trim();
            const consumer = PluginContributionIdentityV1Schema.parse(subject.consumer);
            if (!operationId) {
              throw new Error(
                'connected_account_agent_catalog_observation_binding_operation_id_required',
              );
            }
            return {
              subjectKey: JSON.stringify(['agent_catalog_observation', operationId]),
              subjectId:
                `agent-catalog-observation:${operationId}/agent:${consumer.pluginId}/${consumer.localId}`,
              isSubjectCurrent: subject.isCurrent,
              sessionId: null,
              errorPrefix: 'connected_account_agent_catalog_observation_binding',
              expectedConsumer: Object.freeze({ ...consumer }),
            };
          })();
    if (purposeBindingsBySubjectKey.has(normalized.subjectKey)) {
      throw new Error(`${normalized.errorPrefix}_already_active`);
    }
    const purposes = input.purposes.map((purpose) =>
      QualifiedConnectedAccountPurposeV1Schema.parse(purpose)
    );
    const coveredPurposeKeys = new Set<string>();
    for (const purpose of purposes) {
      if (
        normalized.expectedConsumer
        && (
          purpose.consumer.pluginId !== normalized.expectedConsumer.pluginId
          || purpose.consumer.localId !== normalized.expectedConsumer.localId
        )
      ) {
        throw new Error(`${normalized.errorPrefix}_consumer_mismatch`);
      }
      const key = qualifiedPurposeKey(purpose);
      if (coveredPurposeKeys.has(key)) {
        throw new Error(`${normalized.errorPrefix}_duplicate_purpose`);
      }
      coveredPurposeKeys.add(key);
    }
    const parsedBindings = QualifiedConnectedAccountPurposeBindingsV1Schema.parse({
      v: 1,
      bindings: input.bindings,
    }).bindings.map(immutableBinding);
    const bindingByPurposeKey =
      new Map<string, QualifiedConnectedAccountPurposeBindingV1>();
    for (const binding of parsedBindings) {
      const key = qualifiedPurposeKey(binding.purpose);
      if (!coveredPurposeKeys.has(key)) {
        throw new Error(`${normalized.errorPrefix}_undeclared_purpose`);
      }
      if (bindingByPurposeKey.has(key)) {
        throw new Error(`${normalized.errorPrefix}_duplicate_binding`);
      }
      bindingByPurposeKey.set(key, binding);
    }
    const state: PurposeBindingState = Object.freeze({
      subjectId: normalized.subjectId,
      isSubjectCurrent: normalized.isSubjectCurrent,
      coveredPurposeKeys,
      bindingByPurposeKey,
      bindings: Object.freeze(parsedBindings),
    });
    purposeBindingsBySubjectKey.set(normalized.subjectKey, state);
    if (normalized.sessionId) {
      notifySessionInvalidations(normalized.sessionId);
    }
    let active = true;
    const isCurrent = (): boolean => {
      if (
        !active
        || purposeBindingsBySubjectKey.get(normalized.subjectKey) !== state
      ) {
        return false;
      }
      try {
        return state.isSubjectCurrent();
      } catch {
        return false;
      }
    };
    return Object.freeze({
      subjectId: state.subjectId,
      isCurrent,
      resolvePurposeBinding(rawPurpose) {
        if (!isCurrent()) return null;
        const purpose = QualifiedConnectedAccountPurposeV1Schema.parse(rawPurpose);
        return state.bindingByPurposeKey.get(qualifiedPurposeKey(purpose)) ?? null;
      },
      listPurposeBindings() {
        return isCurrent() ? state.bindings : Object.freeze([]);
      },
      dispose() {
        if (!active) return;
        active = false;
        if (
          purposeBindingsBySubjectKey.get(normalized.subjectKey) === state
        ) {
          purposeBindingsBySubjectKey.delete(normalized.subjectKey);
          if (normalized.sessionId) {
            notifySessionInvalidations(normalized.sessionId);
          }
        }
      },
    });
  };

  const replaceTargetIfStillCurrent = async (input: Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1;
    expectedTarget: QualifiedConnectedAccountPurposeBindingTargetV1;
    replacementTarget: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
    signal: AbortSignal;
  }>): Promise<void> => {
    await dependencies.store.update((current) => {
      const observed = readPurposeBinding(current, input.purpose);
      return observed && targetKey(observed) === targetKey(input.expectedTarget)
        ? replacePurposeBinding(current, input.purpose, input.replacementTarget)
        : current;
    }, input.signal);
  };

  const readAuthorizedResolvedLocked = async (input: Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1;
    serviceRefs: readonly PluginContributionRef[];
    sessionId?: string;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    target: QualifiedConnectedAccountPurposeBindingTargetV1;
    resolved: ConnectedAccountPurposeResolvedTarget;
  }> | null> => {
    input.signal.throwIfAborted();
    const purpose = QualifiedConnectedAccountPurposeV1Schema.parse(input.purpose);
    const sessionBinding = readSessionPurposeBinding({
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      purpose,
    });
    if (sessionBinding.covered) {
      const target = sessionBinding.binding?.target ?? null;
      if (!target) return null;
      try {
        assertTargetAuthorized(target, input.serviceRefs);
      } catch {
        return null;
      }
      const resolved = await dependencies.resolveTarget(target, input.signal);
      input.signal.throwIfAborted();
      if (!resolved) return null;
      assertResolvedTargetMatchesIntent(target, resolved);
      return { target, resolved };
    }
    const target = readPurposeBinding(await dependencies.store.read(input.signal), purpose);
    input.signal.throwIfAborted();
    if (!target) return null;
    try {
      assertTargetAuthorized(target, input.serviceRefs);
    } catch {
      // A declaration/service-scope replacement must not let an older durable selection regain
      // authority later. Contract the incompatible entry through the one canonical writer.
      await replaceTargetIfStillCurrent({
        purpose,
        expectedTarget: target,
        replacementTarget: null,
        signal: input.signal,
      });
      return null;
    }
    const resolved = await dependencies.resolveTarget(target, input.signal);
    input.signal.throwIfAborted();
    if (!resolved) {
      const revalidatedTarget = readPurposeBinding(
        await dependencies.store.read(input.signal),
        purpose,
      );
      input.signal.throwIfAborted();
      if (!revalidatedTarget || targetKey(revalidatedTarget) !== targetKey(target)) {
        return null;
      }
      const revalidatedResolved = await dependencies.resolveTarget(
        revalidatedTarget,
        input.signal,
      );
      input.signal.throwIfAborted();
      if (revalidatedResolved) {
        assertResolvedTargetMatchesIntent(revalidatedTarget, revalidatedResolved);
        return { target: revalidatedTarget, resolved: revalidatedResolved };
      }
      await replaceTargetIfStillCurrent({
        purpose,
        expectedTarget: revalidatedTarget,
        replacementTarget: null,
        signal: input.signal,
      });
      return null;
    }
    assertResolvedTargetMatchesIntent(target, resolved);
    return { target, resolved };
  };
  const readAuthorizedResolved = async (input: Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1;
    serviceRefs: readonly PluginContributionRef[];
    sessionId?: string;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    target: QualifiedConnectedAccountPurposeBindingTargetV1;
    resolved: ConnectedAccountPurposeResolvedTarget;
  }> | null> => await withSerializedConsumerMutations(
    [contributionKey(QualifiedConnectedAccountPurposeV1Schema.parse(input.purpose).consumer)],
    async () => await readAuthorizedResolvedLocked(input),
  );

  return Object.freeze({
    activatePurposeBindings,
    activateSessionPurposeBindings(input) {
      return activatePurposeBindings({
        subject: {
          kind: 'session',
          sessionId: input.sessionId,
        },
        purposes: input.purposes,
        bindings: input.bindings,
      });
    },
    async resolveBindingIntent(input) {
      input.signal.throwIfAborted();
      const purpose = QualifiedConnectedAccountPurposeV1Schema.parse(input.purpose);
      const target = QualifiedConnectedAccountPurposeBindingTargetV1Schema.parse(input.target);
      assertTargetAuthorized(target, input.serviceRefs);
      const resolved = await dependencies.resolveTarget(target, input.signal);
      input.signal.throwIfAborted();
      if (!resolved) throw resourceNotSelected(purpose);
      assertResolvedTargetMatchesIntent(target, resolved);
      return immutableBinding({ purpose, target });
    },
    async reconcileAuthorizedPurposes(input) {
      input.signal.throwIfAborted();
      const authorizedByConsumerKey = new Map<
        string,
        ReadonlyMap<string, ReadonlySet<string>>
      >();
      // Validate the complete candidate before entering the one durable mutation.
      for (const consumerScope of input.consumerScopes) {
        const consumer = PluginContributionIdentityV1Schema.parse(
          consumerScope.consumer,
        );
        const consumerKey = contributionKey(consumer);
        if (authorizedByConsumerKey.has(consumerKey)) {
          throw new Error(
            'connected_account_purpose_reconciliation_duplicate_consumer',
          );
        }
        const authorizedServiceKeysByPurposeKey = new Map<
          string,
          ReadonlySet<string>
        >();
        for (const scope of consumerScope.authorizedPurposes) {
          const purpose = QualifiedConnectedAccountPurposeV1Schema.parse(
            scope.purpose,
          );
          if (contributionKey(purpose.consumer) !== consumerKey) {
            throw new Error(
              'connected_account_purpose_reconciliation_consumer_mismatch',
            );
          }
          const purposeKey = qualifiedPurposeKey(purpose);
          if (authorizedServiceKeysByPurposeKey.has(purposeKey)) {
            throw new Error(
              'connected_account_purpose_reconciliation_duplicate_purpose',
            );
          }
          authorizedServiceKeysByPurposeKey.set(
            purposeKey,
            new Set(
              scope.serviceRefs.map((service) => contributionKey(service)),
            ),
          );
        }
        authorizedByConsumerKey.set(
          consumerKey,
          authorizedServiceKeysByPurposeKey,
        );
      }
      const release = await acquireSerializedConsumerMutations(
        [...authorizedByConsumerKey.keys()],
      );
      try {
        input.signal.throwIfAborted();
        await dependencies.store.update((currentLike) => {
            const current = QualifiedConnectedAccountPurposeBindingsV1Schema.parse(currentLike);
            return QualifiedConnectedAccountPurposeBindingsV1Schema.parse({
              v: 1,
              bindings: current.bindings.filter((binding) => {
                const authorizedServiceKeysByPurposeKey =
                  authorizedByConsumerKey.get(
                    contributionKey(binding.purpose.consumer),
                  );
                if (!authorizedServiceKeysByPurposeKey) return true;
                const authorizedServices = authorizedServiceKeysByPurposeKey.get(
                  qualifiedPurposeKey(binding.purpose),
                );
                return authorizedServices?.has(
                  contributionKey(targetService(binding.target)),
                ) === true;
              }),
            });
        }, input.signal);
        input.publish();
        release();
      } catch (error) {
        release();
        throw error;
      }
    },
    async getBinding(input) {
      const resolved = await readAuthorizedResolved(input);
      return resolved ? summary(input.purpose, resolved.target, resolved.resolved) : null;
    },
    async requestSelection(input) {
      input.signal.throwIfAborted();
      const purpose = QualifiedConnectedAccountPurposeV1Schema.parse(input.purpose);
      const target = QualifiedConnectedAccountPurposeBindingTargetV1Schema.parse(
        await dependencies.selectTarget({
          purpose,
          serviceRefs: input.serviceRefs,
          ...(input.currentSession ? { currentSession: input.currentSession } : {}),
          reason: input.reason,
          signal: input.signal,
        }),
      );
      assertTargetAuthorized(target, input.serviceRefs);
      return await withSerializedConsumerMutations(
        [contributionKey(purpose.consumer)],
        async () => {
          input.assertGenerationCurrent();
          input.signal.throwIfAborted();
          let priorTarget: QualifiedConnectedAccountPurposeBindingTargetV1 | null = null;
          let writePrepared = false;
          try {
            await dependencies.store.update(
              (current) => {
                input.assertGenerationCurrent();
                priorTarget = readPurposeBinding(current, purpose);
                writePrepared = true;
                return replacePurposeBinding(current, purpose, target);
              },
              input.signal,
            );
            input.assertGenerationCurrent();
            input.signal.throwIfAborted();
            const resolved = await dependencies.resolveTarget(target, input.signal);
            input.assertGenerationCurrent();
            input.signal.throwIfAborted();
            if (!resolved) {
              throw resourceNotSelected(purpose);
            }
            assertResolvedTargetMatchesIntent(target, resolved);
            return summary(purpose, target, resolved);
          } catch (error) {
            // The write may already be durable when retirement/cancellation becomes observable.
            // Compensate while this consumer's mutation lock is still held so a newer generation
            // cannot select the same target between this compare-restore and lock release.
            if (writePrepared) {
              await replaceTargetIfStillCurrent({
                purpose,
                expectedTarget: target,
                replacementTarget: priorTarget,
                signal: cleanupSignal,
              });
            }
            throw error;
          }
        },
      );
    },
    async materialize(input) {
      const resolved = await readAuthorizedResolved(input);
      if (!resolved) throw resourceNotSelected(input.purpose);
      const materialization = await dependencies.materializeAccount({
        account: resolved.resolved.account,
        request: input.request,
        signal: input.signal,
      });
      input.signal.throwIfAborted();
      return materialization;
    },
    watch(input) {
      QualifiedConnectedAccountPurposeV1Schema.parse(input.purpose);
      let disposed = false;
      const notify = () => {
        if (!disposed) input.listener();
      };
      const storeSubscription = dependencies.store.subscribe(notify);
      const projectionSubscription = dependencies.subscribeInvalidations?.(notify);
      const sessionListeners = input.sessionId
        ? sessionInvalidationListenersBySessionId.get(input.sessionId) ?? new Set<() => void>()
        : null;
      if (input.sessionId && sessionListeners) {
        sessionInvalidationListenersBySessionId.set(input.sessionId, sessionListeners);
        sessionListeners.add(notify);
      }
      return Object.freeze({
        dispose() {
          if (disposed) return;
          disposed = true;
          storeSubscription.dispose();
          projectionSubscription?.dispose();
          if (input.sessionId && sessionListeners) {
            sessionListeners.delete(notify);
            if (sessionListeners.size === 0) {
              sessionInvalidationListenersBySessionId.delete(input.sessionId);
            }
          }
        },
      });
    },
  });
}

export function createActiveAccountSettingsConnectedAccountPurposeBindingStore(): ConnectedAccountPurposeBindingStore {
  return Object.freeze({
    async read(signal) {
      signal?.throwIfAborted();
      const bindings = QualifiedConnectedAccountPurposeBindingsV1Schema.parse(
        readActivePluginAccountSettings()?.connectedAccountPurposeBindingsV1
          ?? { v: 1, bindings: [] },
      );
      signal?.throwIfAborted();
      return bindings;
    },
    async update(mutate, signal) {
      signal?.throwIfAborted();
      const settings = await updateActivePluginAccountSettings((current) => ({
        ...current,
        connectedAccountPurposeBindingsV1: QualifiedConnectedAccountPurposeBindingsV1Schema.parse(
          mutate(parsePurposeBindingsOrEmpty(current.connectedAccountPurposeBindingsV1)),
        ),
      }));
      return QualifiedConnectedAccountPurposeBindingsV1Schema.parse(
        settings.connectedAccountPurposeBindingsV1,
      );
    },
    subscribe(listener) {
      const unsubscribe = subscribeActiveAccountSettingsSnapshot(() => listener());
      return Object.freeze({ dispose: unsubscribe });
    },
  });
}

export {
  readPurposeBinding,
  replacePurposeBinding,
};
