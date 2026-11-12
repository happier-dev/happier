import { definePlugin, DeploymentTargetPreparationBaseV1ProtocolSchema,
  DeploymentTargetRoleInputProtocolSchemasV1, DeploymentTargetRoleResultV1ProtocolSchema,
  type JsonValue } from '@happier-dev/plugin-sdk';
import { DeploymentTargetLinkProviderContentV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/v2';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { ScmHostingRepositoryIdentityV1ProtocolSchema } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import type { HomeGovernanceHarness } from '@/dev/testkit/harness/homeGovernanceHarness';

export const DEPLOYMENT_TARGETS_TEST_SERVICE = { pluginId: 'com.example.cloud', localId: 'cloud-account' };
export const DEPLOYMENT_TARGETS_TEST_EXECUTION = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } } as const;

/** Remote Machine boundary: the real front door dispatches to the authored SDK Action. */
export async function answerDeploymentTargetInspectForHome(params: Readonly<{
  homes: HomeGovernanceHarness; serverId: string; accountId: string; machineId: string;
  plugin: ReturnType<typeof createDeploymentTargetsTestPlugin>;
}>) {
  const kit = await createPluginTestkit({ manifest: params.plugin.manifest, module: params.plugin });
  await answerExternalActionAccountForHome(params.homes, params.serverId, {
    machineId: params.machineId, installationId: `${params.machineId}-installation`,
    actionId: 'action.invoke', tokenEpoch: 0,
    execute: async (raw, context) => {
      const input = getActionSpec('action.invoke').inputSchema.parse(raw);
      if (input.action.pluginId !== params.plugin.manifest.id) throw new Error('Unexpected remote plugin');
      try {
        return await kit.invokeAction(input.action.localId, StrictJsonValueSchema.parse(input.input ?? null), {
          surface: context.invocation.surface,
          accountScope: { serverId: params.serverId, accountId: params.accountId },
          ...(context.signal ? { signal: context.signal } : {}),
        });
      } catch (error) {
        if (!(error instanceof PluginError)) throw error;
        return { ok: false, errorCode: error.code, error: error.message };
      }
    },
    failure: result => typeof result === 'object' && result !== null && 'errorCode' in result
      && typeof result.errorCode === 'string' && 'error' in result && typeof result.error === 'string'
      ? { errorCode: result.errorCode, error: result.error } : null,
  });
  return kit;
}

/** A third-party plugin declaring two runtime platforms, Alpha and Beta, through the public deployment target contract. */
export function createDeploymentTargetsTestPlugin(pluginId: string, runInspect: (name: string, input: JsonValue) => Promise<void> = async () => {},
  options: Readonly<{ emptyChoices?: boolean; upload?: boolean; create?: boolean }> = {}) {
  const service = DEPLOYMENT_TARGETS_TEST_SERVICE;
  const execution = DEPLOYMENT_TARGETS_TEST_EXECUTION;
  const closed = { type: 'object', properties: {}, additionalProperties: false } as const;
  const inspect = (name: string) => ({
    title: `Inspect ${name}`, execution, surfaces: ['ui', 'cli'], dangerLevel: 'safe', readOnly: true,
    hostAccess: [`${name}.manage`],
    connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: `${name}.manage` }],
    inputSchema: { ...DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema,
      properties: { ...DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema.properties, [name]: { type: 'string' },
        repository: ScmHostingRepositoryIdentityV1ProtocolSchema.jsonSchema,
        sourceMethod: { anyOf: [DeploymentTargetRoleInputProtocolSchemasV1.deploy.jsonSchema.properties!.sourceMethod!, DeploymentTargetRoleInputProtocolSchemasV1.uploadDeploy.jsonSchema.properties!.sourceMethod!] } } },
    resultSchema: DeploymentTargetLinkProviderContentV1ProtocolSchema.jsonSchema,
    inputHints: { fields: [{ path: name, title: `${name} region`, widget: 'select', required: true,
      ...(options.emptyChoices ? { inputType: { pluginId, localId: 'region-choice' } }
        : { options: [{ value: `${name}-west`, label: `${name} West` }] }) },
      { path: 'providerAccountId', title: 'Account', widget: 'text', required: true },
      { path: 'providerEnvironment', title: 'Environment', widget: 'json', required: true }] },
    run: async (input: JsonValue) => {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected admitted object');
      const admitted = input as Readonly<Record<string, JsonValue>>;
      const credentialPrincipal = admitted.credentialPrincipal;
      if (credentialPrincipal === undefined) throw new Error('Expected admitted credential principal');
      await runInspect(name, input);
      return { credentialPrincipal,
        providerIdentity: { providerAccountId: 'cloud', providerResourceId: String(admitted[name]), providerEnvironment: 'production' },
        providerEnvironment: { kind: 'production' } };
    },
  } as const);
  const lifecycle = { title: 'Deploy', execution, surfaces: ['plugin'], dangerLevel: 'writesLocal', readOnly: false,
    resultSchema: DeploymentTargetRoleResultV1ProtocolSchema.jsonSchema, run: async () => ({ v: 1, state: 'succeeded', observedAtMs: 1 }) } as const;
  return definePlugin({ id: pluginId, version: '1.0.0', displayName: 'Independent Cloud',
    ...(options.emptyChoices ? {
      inputTypes: { 'region-choice': { title: 'Region', semantic: 'region-choice', valueSchema: { type: 'string' },
        options: { resource: 'region-choices' } } },
      resources: { 'region-choices': { source: 'dynamic', kind: 'config', contentType: 'application/json', scope: 'global', execution,
        runtime: { async read() { return JSON.stringify({ options: [] }); }, observe() { return { dispose() {} }; } } } },
    } as const : {}),
    hostAccess: { required: ['alpha', 'beta'].map(name => ({ id: `${name}.manage`, capability: 'connectedAccounts', reason: `Use ${name}.`,
      scope: { serviceRefs: [service], operations: ['use'], materializationKinds: ['httpHeaders'] } } as const)), optional: [] },
    actions: { 'inspect-alpha': inspect('alpha'), 'inspect-beta': inspect('beta'),
      ...(options.create ? { 'create-beta': { ...inspect('beta'), title: 'Create Beta project', dangerLevel: 'writesRemote', readOnly: false,
        confirmation: { title: 'Create this provider project?' }, inputSchema: DeploymentTargetRoleInputProtocolSchemasV1.create.jsonSchema,
        inputHints: { fields: [
          { path: 'providerAccountId', title: 'Account', widget: 'text', required: true },
          { path: 'resourceName', title: 'Project name', widget: 'text', required: true },
          { path: 'providerEnvironment', title: 'Environment', widget: 'json', required: true, defaultValue: { kind: 'production' } },
          { path: 'sourceMethod', title: 'Source method', widget: 'select', required: true, defaultValue: 'upload', options: [{ value: 'upload', label: 'Upload' }] },
        ] },
        run: async (input: JsonValue) => {
          if (input === null || typeof input !== 'object' || Array.isArray(input) || input.credentialPrincipal === undefined)
            throw new Error('Expected admitted create input');
          return { credentialPrincipal: input.credentialPrincipal,
            providerIdentity: { providerAccountId: String(input.providerAccountId), providerResourceId: 'created-beta', providerEnvironment: 'production' },
            providerEnvironment: { kind: 'production' } };
        },
      } } as const : {}),
      link: { ...inspect('alpha'), title: 'Link', dangerLevel: 'writesLocal', readOnly: false, confirmation: { title: 'Link this target?' } },
      deploy: { ...lifecycle, inputSchema: DeploymentTargetRoleInputProtocolSchemasV1.deploy.jsonSchema },
      ...(options.upload ? { upload: { ...lifecycle, execution: { target: 'daemon' },
        inputSchema: DeploymentTargetRoleInputProtocolSchemasV1.uploadDeploy.jsonSchema } } as const : {}),
      observe: { ...lifecycle, dangerLevel: 'safe', readOnly: true, inputSchema: DeploymentTargetRoleInputProtocolSchemasV1.observe.jsonSchema } },
    deploymentTargets: {
      alpha: { role: 'runtime', title: 'Alpha runtime', targetKind: 'alpha', icon: 'server-outline', targetSchema: closed, linkSchema: closed,
        actions: { inspect: 'inspect-alpha', link: 'link', deploy: 'deploy', observe: 'observe' } },
      beta: { role: 'runtime', title: 'Beta runtime', targetKind: 'beta', icon: 'server-outline', targetSchema: closed, linkSchema: closed,
        actions: { inspect: 'inspect-beta', link: 'link', deploy: 'deploy', observe: 'observe',
          ...(options.create ? { create: 'create-beta' } : {}),
          ...(options.upload ? { uploadDeploy: 'upload' } : {}) } },
    },
  });
}
