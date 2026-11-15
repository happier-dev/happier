import { expect, it } from 'vitest';
import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1, readDeploymentActionOperationRequestIdV1 } from './deploymentActionsV1.js';
import { buildDeploymentTargetLinkInputV1 } from './targetLinkInput.js';

const credential = { service: { pluginId: 'example.platform', localId: 'account' }, accountId: 'connection' };
const create = { serverId: 'home', environmentId: 'environment', expectedRevision: 2, requestKey: 'one-create',
  targetId: 'runtime', role: 'runtime', targetKind: 'platform', machines: [],
  source: { kind: 'plugin', contribution: { pluginId: 'example.platform', localId: 'runtime' } },
  providerCreate: { credentialRef: credential,
    credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: {
      pluginId: 'example.platform', localId: 'create' }, purpose: 'deploy.manage' },
      target: { kind: 'account', account: credential } },
    providerAccountId: 'native-account', providerEnvironment: { kind: 'production' }, resourceName: 'reviewed-name',
    sourceMethod: 'upload' } };

it('admits reviewed runtime creation without fabricating an existing provider resource', () => {
  expect(DeploymentActionInputSchemasV1['deployments.targets.link'].safeParse(create)).toMatchObject({ success: true });
  expect(DeploymentActionInputSchemasV1['deployments.targets.link'].safeParse({ ...create,
    providerCreate: { ...create.providerCreate, providerIdentity: { providerAccountId: 'native-account',
      providerResourceId: 'guessed-id', providerEnvironment: 'production' } } }).success).toBe(false);
});

it('retains exact created coordinates as an ordinary adopt intent after association fails', () => {
  const { providerCreate, ...base } = create;
  const recovery = { ...base, provisioned: true, provider: {
    credentialPrincipal: providerCreate.credentialPrincipal,
    providerIdentity: { providerAccountId: 'native-account', providerResourceId: 'returned-id', providerEnvironment: 'production' },
    providerEnvironment: providerCreate.providerEnvironment, preparedNative: { projectName: 'reviewed-name' } } };
  const retained = { ok: false, error: 'deployment_link_incomplete', recovery };
  expect(DeploymentActionOutputSchemasV1['deployments.targets.link'].safeParse(retained)).toMatchObject({ success: true });
  expect(DeploymentActionInputSchemasV1['deployments.targets.link'].safeParse(recovery)).toMatchObject({ success: true });
  expect(DeploymentActionOutputSchemasV1['deployments.targets.link'].safeParse({ ...retained,
    recovery: { ...recovery, provider: { ...recovery.provider, providerIdentity: undefined } } }).success).toBe(false);
});

it.each([false, true])('publishes titled provider intents as canonical storage inputs (provisioned=%s)', provisioned => {
  const { providerCreate, ...base } = create;
  const intent = DeploymentActionInputSchemasV1['deployments.targets.link'].parse({ ...base,
    title: 'Reviewed destination', ...(provisioned ? { provisioned: true } : {}), provider: {
      credentialPrincipal: providerCreate.credentialPrincipal,
      providerIdentity: { providerAccountId: 'native-account', providerResourceId: 'returned-id', providerEnvironment: 'production' },
      providerEnvironment: providerCreate.providerEnvironment } });
  if (!('provider' in intent)) throw new Error('Expected provider intent');
  const prepared = buildDeploymentTargetLinkInputV1(intent, { artifactId: 'published-provider',
    revision: { headerVersion: 1, bodyVersion: 2 } });
  expect(prepared).toEqual({ ...base, ...(provisioned ? { provisioned: true } : {}), contentArtifactId: 'published-provider',
    contentHeaderVersion: 1, contentBodyVersion: 2 });
});

it('binds native-create replay to its request key while exact association recovery is a separate operation', () => {
  const original = readDeploymentActionOperationRequestIdV1('deployments.targets.link', create);
  expect(original).toEqual(expect.any(String));
  expect(readDeploymentActionOperationRequestIdV1('deployments.targets.link', structuredClone(create))).toBe(original);
  expect(readDeploymentActionOperationRequestIdV1('deployments.targets.link', { ...create, requestKey: 'another-review' })).not.toBe(original);
  const { providerCreate, ...base } = create;
  const recovery = { ...base, provisioned: true, provider: { credentialPrincipal: providerCreate.credentialPrincipal,
    providerIdentity: { providerAccountId: 'native-account', providerResourceId: 'returned-id', providerEnvironment: 'production' },
    providerEnvironment: { kind: 'production' } } };
  expect(readDeploymentActionOperationRequestIdV1('deployments.targets.link', recovery)).toBeUndefined();
});
