import { definePlugin, DeploymentTargetPreparationBaseV1ProtocolSchema,
  DeploymentTargetRoleInputProtocolSchemasV1, DeploymentTargetRoleResultV1ProtocolSchema,
  type JsonValue } from '@happier-dev/plugin-sdk';
import { DeploymentTargetLinkProviderContentV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/v2';

export const DEPLOYMENT_TARGETS_TEST_SERVICE = { pluginId: 'com.example.cloud', localId: 'cloud-account' };
export const DEPLOYMENT_TARGETS_TEST_EXECUTION = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } } as const;

/** A third-party plugin declaring two runtime platforms, Alpha and Beta, through the public deployment target contract. */
export function createDeploymentTargetsTestPlugin(pluginId: string, runInspect: (name: string, input: JsonValue) => Promise<void> = async () => {}) {
  const service = DEPLOYMENT_TARGETS_TEST_SERVICE;
  const execution = DEPLOYMENT_TARGETS_TEST_EXECUTION;
  const closed = { type: 'object', properties: {}, additionalProperties: false } as const;
  const inspect = (name: string) => ({
    title: `Inspect ${name}`, execution, surfaces: ['ui'], dangerLevel: 'safe', readOnly: true,
    hostAccess: [`${name}.manage`],
    connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: `${name}.manage` }],
    inputSchema: { ...DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema,
      properties: { ...DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema.properties, [name]: { type: 'string' } } },
    resultSchema: DeploymentTargetLinkProviderContentV1ProtocolSchema.jsonSchema,
    inputHints: { fields: [{ path: name, title: `${name} region`, widget: 'select', required: true,
      options: [{ value: `${name}-west`, label: `${name} West` }] },
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
    hostAccess: { required: ['alpha', 'beta'].map(name => ({ id: `${name}.manage`, capability: 'connectedAccounts', reason: `Use ${name}.`,
      scope: { serviceRefs: [service], operations: ['use'], materializationKinds: ['httpHeaders'] } } as const)), optional: [] },
    actions: { 'inspect-alpha': inspect('alpha'), 'inspect-beta': inspect('beta'),
      link: { ...inspect('alpha'), title: 'Link', dangerLevel: 'writesLocal', readOnly: false, confirmation: { title: 'Link this target?' } },
      deploy: { ...lifecycle, inputSchema: DeploymentTargetRoleInputProtocolSchemasV1.deploy.jsonSchema },
      observe: { ...lifecycle, dangerLevel: 'safe', readOnly: true, inputSchema: DeploymentTargetRoleInputProtocolSchemasV1.observe.jsonSchema } },
    deploymentTargets: {
      alpha: { role: 'runtime', title: 'Alpha runtime', targetKind: 'alpha', icon: 'server-outline', targetSchema: closed, linkSchema: closed,
        actions: { inspect: 'inspect-alpha', link: 'link', deploy: 'deploy', observe: 'observe' } },
      beta: { role: 'runtime', title: 'Beta runtime', targetKind: 'beta', icon: 'server-outline', targetSchema: closed, linkSchema: closed,
        actions: { inspect: 'inspect-beta', link: 'link', deploy: 'deploy', observe: 'observe' } },
    },
  });
}
