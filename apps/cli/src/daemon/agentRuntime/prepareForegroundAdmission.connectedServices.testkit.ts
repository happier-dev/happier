import type { AgentConnectedAccountLaunchContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import {
  QualifiedConnectedAccountPurposeBindingsV1Schema,
  type QualifiedConnectedAccountPurposeBindingV1,
  type QualifiedConnectedAccountServiceRef,
  type PluginContributionIdentityV1,
} from '@happier-dev/protocol';

import {
  createConnectedAccountPurposeBindingOwner,
  type ConnectedAccountPurposeBindingOwnerDependencies,
} from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import type { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
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
  const plugins: Parameters<typeof createAuthoredAdmittedPluginRuntimeFixture>[0]['plugins'][number][] = [{
    manifest: createPluginManifestV2Fixture({
      id: pluginId,
      ...(input.launch?.stateSharingDescriptor?.nativeHome ? {
        hostAccess: { required: [{
          id: 'native-home-environment', capability: 'environment',
          reason: 'Launch the Agent with its exact materialized native home.',
          scope: { keys: [input.launch.stateSharingDescriptor.nativeHome.environmentKey] },
        }], optional: [] },
      } : {}),
      contributes: { agents: [{
        id: localId, title: 'Foreground Account Fixture', runtime: { kind: 'custom' }, primary: 'sessions',
        cli: {
          displayName: 'Foreground fixture CLI',
          executable: { binaryName: 'foreground-agent', sourcePreference: 'system-first' },
          install: { manual: { kind: 'none' } },
          auth: { support: 'unsupported', loginLaunches: [] },
        },
        capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } },
        connectedAccounts: [{ purpose: 'primary', service: input.service, required: false, materializationKinds: input.materializationKinds }],
      }] },
    }),
    files: {
      'agent-runtime.mjs': agentRuntimeSource,
      'daemon.mjs': [
        'import { createRuntime } from "./agent-runtime.mjs";',
        'export function activate(api) {',
        `  api.agents.register(${JSON.stringify(localId)}, createRuntime, {`,
        '    sessionRunnerFactory: { module: "./agent-runtime.mjs", export: "createRuntime", runtimeApiVersion: 1 },',
        ...(input.launch ? [`    connectedAccountLaunch: ${JSON.stringify(input.launch)},`] : []),
        '  });',
        '}',
      ].join('\n'),
    },
  }];
  const bundledService = loadCurrentBundledPluginLocatorResult().loadedPlugins.some(plugin => (
    plugin.manifest.id === input.service.pluginId
    && plugin.manifest.contributes.connectedAccountDescriptors?.some(descriptor => descriptor.id === input.service.localId)
  ));
  if (!bundledService) {
    // A cross-plugin reference needs a genuinely admitted declaration producer.
    // Bundled services already have that canonical declaration; novel services
    // are authored and committed alongside this external Agent instead.
    plugins.push({
      manifest: createPluginManifestV2Fixture({
        id: input.service.pluginId,
        contributes: { connectedAccountDescriptors: [{
          id: input.service.localId, title: 'Foreground fixture Account',
          authentication: {
            defaultModeId: 'manual',
            modes: [{
              id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
              fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
            }],
          },
        }] },
      }),
      files: {
        'daemon.mjs': [
          'export function activate(api) {',
          `  api.connectedAccounts.register(${JSON.stringify(input.service.localId)}, {`,
          '    authentication: { modes: { manual: { kind: "manual", async complete() { return { status: "rejected" }; } } } },',
          '    async refresh() { return { status: "connected" }; },',
          '    async revoke() { return { status: "remoteUnsupported" }; },',
          '    async status() { return { status: "connected" }; },',
          '    async materialize() { throw new Error("Account materialization belongs to the fixture Account-store boundary"); },',
          '  });',
          '}',
        ].join('\n'),
      },
    });
  }
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
