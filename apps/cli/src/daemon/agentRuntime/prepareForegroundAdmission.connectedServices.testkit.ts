import type { AgentConnectedAccountLaunchContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { basename } from 'node:path';
import {
  QualifiedConnectedAccountPurposeBindingsV1Schema,
  PluginConnectedAccountDescriptorContributionV2Schema,
  PluginManifestHostAccessV2Schema,
  PluginAgentCliMetadataSchema,
  type QualifiedConnectedAccountPurposeBindingV1,
  type QualifiedConnectedAccountServiceRef,
  type PluginContributionIdentityV1,
} from '@happier-dev/protocol';

import {
  createConnectedAccountPurposeBindingOwner,
  type ConnectedAccountPurposeBindingOwnerDependencies,
} from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PrepareForegroundAgentRuntimeAdmissionDependencies } from './prepareForegroundAdmission';

const pluginId = 'acme.foreground';
const localId = 'fixture-agent';

/** Canonical launch authority over an explicitly isolated Account-store boundary. */
export function createForegroundPurposeOwnerFixture(input: Readonly<{
  consumer: PluginContributionIdentityV1;
  service: QualifiedConnectedAccountServiceRef;
  accountId?: string;
  materializeAccount: ConnectedAccountPurposeBindingOwnerDependencies['materializeAccount'];
  resolveTarget?: ConnectedAccountPurposeBindingOwnerDependencies['resolveTarget'];
  resolveCredentialRevision?: ConnectedAccountPurposeBindingOwnerDependencies['resolveCredentialRevision'];
}>) {
  const purpose = { consumer: input.consumer, purpose: 'primary' } as const;
  const binding: QualifiedConnectedAccountPurposeBindingV1 = {
    purpose, target: { kind: 'account', account: { service: input.service, accountId: input.accountId ?? 'selected-account' } },
  };
  let stored = QualifiedConnectedAccountPurposeBindingsV1Schema.parse({ v: 1, bindings: [binding] });
  const listeners = new Set<() => void>();
  const store: ConnectedAccountPurposeBindingOwnerDependencies['store'] = {
    read: async () => stored,
    update: async (mutate) => {
      stored = QualifiedConnectedAccountPurposeBindingsV1Schema.parse(mutate(stored));
      for (const listener of listeners) listener();
      return stored;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
  };
  const owner = createConnectedAccountPurposeBindingOwner({
    store,
    selectTarget: async () => { throw new Error('Foreground launch must not choose a replacement Account'); },
    // This is the Account metadata projection boundary, not a replacement for
    // purpose selection/currentness. The store and owner retain those rules.
    resolveTarget: input.resolveTarget ?? (async (target) => target.kind === 'account'
      ? { displayName: target.account.accountId, account: target.account }
      : null),
    materializeAccount: input.materializeAccount,
    ...(input.resolveCredentialRevision ? { resolveCredentialRevision: input.resolveCredentialRevision } : {}),
    projectTargetAccounts: async () => { throw new Error('Foreground admission does not list purpose Accounts'); },
    assertTargetAccountMaterializable: async () => { throw new Error('Foreground admission does not materialize listed Accounts'); },
  });
  return { owner, store, purpose, binding };
}

/** Physical external Agent plus the canonical purpose owner over an Account-store boundary. */
export function createExternalConnectedAccountForegroundFixture(input: Readonly<{
  service: QualifiedConnectedAccountServiceRef;
  materializationKinds: readonly ('files' | 'httpHeaders')[];
  launch?: AgentConnectedAccountLaunchContributionV1;
  materializeAccount: ConnectedAccountPurposeBindingOwnerDependencies['materializeAccount'];
  resolveCredentialRevision?: ConnectedAccountPurposeBindingOwnerDependencies['resolveCredentialRevision'];
}>) {
  const { owner, store, purpose, binding } = createForegroundPurposeOwnerFixture({
    ...input, consumer: { pluginId, localId },
  });
  const agentRuntimeSource = [
    'export function createRuntime() {',
    '  return { sessions: { async open(request) {',
    '    return { sessionId: request.sessionId, async send() { return { status: "admitted" }; },',
    '      watch() { return { dispose() {} }; }, async dispose() {} };',
    '  } } };',
    '}',
  ].join('\n');
  const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
    id: input.service.localId,
    title: 'Foreground fixture Account',
    authentication: { defaultModeId: 'fixture', modes: [{
      id: 'fixture', kind: 'oauthDeviceCode', outcomeReconciliation: 'none',
    }] },
  });
  // Claim runs the same real executable admission as daemon spawn. Use this
  // test process's native executable; no vendor installer or CLI probe is needed.
  const cli = PluginAgentCliMetadataSchema.parse({
    executable: { binaryName: basename(process.execPath), sourcePreference: 'system-first' },
    install: { manual: { kind: 'none' } },
    auth: { support: 'unsupported', loginLaunches: [] },
  });
  const launchEnvironmentKeys = [...new Set([
    ...(input.launch?.fileEnvironmentUses ?? []).map(use => use.environmentKey),
    ...(input.launch?.environmentUses ?? []).map(use => use.environmentKey),
    ...(input.launch?.stateSharingDescriptor?.nativeHome?.environmentKey
      ? [input.launch.stateSharingDescriptor.nativeHome.environmentKey] : []),
  ])];
  const hostAccess = PluginManifestHostAccessV2Schema.parse({
    required: launchEnvironmentKeys.length === 0 ? [] : [{
      id: 'foreground-account-environment', reason: 'Expose the isolated foreground Account home',
      capability: 'environment', scope: { keys: launchEnvironmentKeys },
    }], optional: [],
  });
  const accountRegistrationSource = [
    'const outsideFixtureBoundary = async () => { throw new Error("Foreground fixture Account operations must use the exact isolated Account-store boundary"); };',
    `api.connectedAccounts.register(${JSON.stringify(input.service.localId)}, {`,
    '  authentication: { modes: { fixture: { kind: "oauthDeviceCode",',
    '    begin: outsideFixtureBoundary, poll: outsideFixtureBoundary, async cancel() {} } } },',
    '  refresh: outsideFixtureBoundary, revoke: outsideFixtureBoundary,',
    '  status: outsideFixtureBoundary, materialize: outsideFixtureBoundary,',
    '});',
  ];
  // Admit the real referenced descriptor alongside the Agent. The purpose
  // owner below supplies the isolated Account-store boundary, not a catalog mock.
  const descriptorPlugins = input.service.pluginId === pluginId ? [] : [{
    manifest: createPluginManifestV2Fixture({
      id: input.service.pluginId,
      contributes: { connectedAccountDescriptors: [descriptor] },
    }),
    files: { 'daemon.mjs': ['export function activate(api) {', ...accountRegistrationSource, '}'].join('\n') },
  }];
  const plugins = [...descriptorPlugins, {
    manifest: createPluginManifestV2Fixture({
      id: pluginId,
      hostAccess,
      contributes: {
        ...(input.service.pluginId === pluginId ? { connectedAccountDescriptors: [descriptor] } : {}),
        agents: [{
        id: localId, title: 'Foreground Account Fixture', runtime: { kind: 'custom' }, primary: 'sessions',
        cli,
        capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } },
        connectedAccounts: [{ purpose: 'primary', service: input.service, required: false, materializationKinds: input.materializationKinds }],
      }] },
    }),
    files: {
      'agent-runtime.mjs': agentRuntimeSource,
      'daemon.mjs': [
        'import { createRuntime } from "./agent-runtime.mjs";',
        'export function activate(api) {',
        ...(input.service.pluginId === pluginId ? accountRegistrationSource : []),
        `  api.agents.register(${JSON.stringify(localId)}, createRuntime, {`,
        '    sessionRunnerFactory: { module: "./agent-runtime.mjs", export: "createRuntime", runtimeApiVersion: 1 },',
        ...(input.launch ? [`    connectedAccountLaunch: ${JSON.stringify(input.launch)},`] : []),
        '  });',
        '}',
      ].join('\n'),
    },
  }];
  const dependencies: Pick<PrepareForegroundAgentRuntimeAdmissionDependencies,
    'activateSessionPurposeBindings' | 'resolveExternalAgentSessionPurposeBindingSnapshot'> = {
    activateSessionPurposeBindings: owner.activateSessionPurposeBindings,
    resolveExternalAgentSessionPurposeBindingSnapshot: async ({ authorizedPurposes, signal }) => (
      await owner.resolveCurrentSessionPurposeBindingSnapshot({ authorizedPurposes, signal })
    ),
  };
  return {
    plugins, owner, store, purpose, binding, dependencies,
    requestFor(registry: ResolvedExecutablePluginRuntimeRegistry) {
      const contribution = [...registry.contributes.agentDefinitionsById.values()].find(candidate => (
        candidate.identity?.pluginId === pluginId && candidate.identity.localId === localId
      ));
      if (!contribution) throw new Error('External Agent was not admitted into the canonical catalog');
      return { agentId: contribution.id, backendTarget: { kind: 'backend' as const, backendId: contribution.id } };
    },
  };
}
