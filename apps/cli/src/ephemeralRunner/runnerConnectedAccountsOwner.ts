import { PluginError, type Disposable } from '@happier-dev/plugin-sdk';
import { QualifiedConnectedAccountPurposeBindingsV1Schema } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { classifyRunnerConnectedServiceSelectionV1 } from '@happier-dev/protocol/ephemeralRunner/runnerConnectedServices';
import type { ConnectedServiceBindingsV2, QualifiedConnectedAccountPurposeV1, QualifiedConnectedAccountRef } from '@happier-dev/protocol';

import {
  createConnectedAccountPurposeBindingOwner,
  type ConnectedAccountPurposeBindingLease,
} from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn, type AgentSpawnPurposeContributions } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';

type ExecutableRegistry = Readonly<{
    contributes: AgentSpawnPurposeContributions;
  }>;

function unavailable(): PluginError {
  return new PluginError({
    code: 'plugin_connected_account_binding_out_of_scope',
    message: 'Runner Connected Account binding is no longer current',
  });
}

export type RunnerConnectedAccountsAuthorityV1 = Readonly<{
  owner: StablePluginConnectedAccountsOwner;
  bind(input: Readonly<{ registry: ExecutableRegistry; agentId: string }>): void;
  resolveSessionConnectedAccounts(): readonly Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1;
    account: QualifiedConnectedAccountRef;
  }>[];
  dispose(): void;
}>;

/** Empty scoped purpose composition until Lane 10 supplies Connected-Service brokering. */
export function createRunnerConnectedAccountsAuthorityV1(input: Readonly<{
  sessionId: string;
  bindings: ConnectedServiceBindingsV2;
}>): RunnerConnectedAccountsAuthorityV1 {
  let active = true;
  let registry: ExecutableRegistry | null = null;
  let lease: ConnectedAccountPurposeBindingLease | null = null;
  const invalidationListeners = new Set<() => void>();
  if (Object.values(input.bindings.bindingsByServiceId).some((selection) =>
    classifyRunnerConnectedServiceSelectionV1(selection) === 'not_portable')) {
    throw unavailable();
  }

  const owner = createConnectedAccountPurposeBindingOwner({
    store: Object.freeze({
      async read() { return QualifiedConnectedAccountPurposeBindingsV1Schema.parse({ v: 1, bindings: [] }); },
      async update() { throw unavailable(); },
      subscribe(): Disposable { return Object.freeze({ dispose() {} }); },
    }),
    async selectTarget() { throw unavailable(); },
    async resolveTarget() { return null; },
    async materializeAccount() { throw unavailable(); },
    async projectTargetAccounts() {
      return Object.freeze({ status: 'complete' as const, accounts: Object.freeze([]) });
    },
    async assertTargetAccountMaterializable() { throw unavailable(); },
    async resolveCredentialRevision() { return null; },
    subscribeInvalidations(listener): Disposable {
      invalidationListeners.add(listener);
      return Object.freeze({ dispose() { invalidationListeners.delete(listener); } });
    },
  });

  return Object.freeze({
    owner,
    bind(bound) {
      if (!active || registry || lease) throw unavailable();
      const snapshot = resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
        agentId: bound.agentId,
        bindings: input.bindings,
        contributions: bound.registry.contributes,
      });
      registry = bound.registry;
      lease = owner.activateSessionPurposeBindings({
        sessionId: input.sessionId,
        purposes: snapshot?.purposes ?? Object.freeze([]),
        bindings: snapshot?.bindings ?? Object.freeze([]),
        ...(snapshot?.directMaterialOrigins?.length
          ? { directMaterialOrigins: snapshot.directMaterialOrigins }
          : {}),
      });
    },
    resolveSessionConnectedAccounts() {
      if (!active || !lease?.isCurrent()) throw unavailable();
      return Object.freeze([]);
    },
    dispose() {
      if (!active) return;
      active = false;
      lease?.dispose();
      lease = null;
      registry = null;
      for (const listener of invalidationListeners) listener();
      invalidationListeners.clear();
    },
  });
}
