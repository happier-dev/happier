import { describe, expect, it } from 'vitest';
import { DeploymentPublishPrepareInputV1Schema, DeploymentPublishPrepareResultV1Schema, type ActionExecutorContext } from '@happier-dev/protocol';
import { DeploymentTemplateV1Schema } from '@happier-dev/protocol/registries';
import { createPublishCatalogPreparation } from './publishProject';

// The host port loads admitted Project/catalog/default records; no deployment or credential adapter is needed.
describe('catalog Publish recommendation context', () => {
  it('returns Configure syntax facts from the same inert prepare read, retaining invalid drafts', async () => {
    const input = DeploymentPublishPrepareInputV1Schema.parse({ serverId: 'home', machineId: 'chosen', installationId: 'installed',
      newProject: { name: 'App', requestKey: 'new-project', owner: { kind: 'account', accountId: 'owner' } },
      templateRef: { sourceId: 'apps', itemId: 'app', version: '1', ref: { kind: 'content', digest: `sha256:${'c'.repeat(64)}` } } });
    const template = DeploymentTemplateV1Schema.parse({ schemaVersion: 1, title: 'App',
      compose: { document: 'services: { app: { image: nginx } }', profiles: [], services: ['app'] },
      variables: [], generatedSecrets: [], domains: [], volumes: [] });
    const prepare = createPublishCatalogPreparation({ readSelection: async () => ({ newProject: input.newProject, template, defaultInputs: {} }) });
    const context: ActionExecutorContext = { surface: 'ui', authority: 'account_automation', serverId: 'home', runtimeAccountId: 'owner' };
    expect(await prepare({ ...input, configure: { name: ' App ', port: '3000', hostname: 'app.example.test' } }, context))
      .toMatchObject({ kind: 'prepared', configurePreflight: {
        name: { status: 'valid', value: 'App' }, port: { status: 'valid', value: 3000 },
        dns: { status: 'valid', value: 'app.example.test' },
      } });
    expect(await prepare({ ...input, configure: { name: ' ', port: '65536', hostname: 'https://app.example.test/path' } }, context))
      .toMatchObject({ kind: 'prepared', configurePreflight: {
        name: { status: 'invalid', value: null }, port: { status: 'invalid', value: null }, dns: { status: 'invalid', value: null },
      } });
  });
  it('returns stored workload evidence and preserves the exact reviewed Machine without claiming presence', async () => {
    const input = DeploymentPublishPrepareInputV1Schema.parse({ serverId: 'home', machineId: 'chosen', installationId: 'installed',
      newProject: { name: 'App', requestKey: 'new-project', owner: { kind: 'account', accountId: 'owner' } },
      templateRef: { sourceId: 'apps', itemId: 'app', version: '1', ref: { kind: 'content', digest: `sha256:${'c'.repeat(64)}` } } });
    const template = DeploymentTemplateV1Schema.parse({ schemaVersion: 1, title: 'App',
      compose: { document: 'services:\n  app:\n    image: nginx:1\n', profiles: [], services: ['app'] },
      variables: [], generatedSecrets: [], domains: [], volumes: [], firstRunSetup: true });
    const prepare = createPublishCatalogPreparation({ readSelection: async () => ({ newProject: input.newProject,
      template, defaultInputs: {} }) });
    const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation', serverId: 'home',
      runtimeAccountId: 'owner', actionRequestId: 'prepare' };
    const result = DeploymentPublishPrepareResultV1Schema.parse(await prepare(input, context));
    expect(result.recommendation).toMatchObject({ target: { id: 'chosen', targetClass: 'ownServer' },
      compatibleTargetIds: ['chosen'], evidence: ['explicit_target', 'stored_definition'],
      uncertainty: ['machine_availability_unknown'] });
  });
});
