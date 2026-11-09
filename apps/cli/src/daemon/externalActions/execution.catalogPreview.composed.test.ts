import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectDeploymentDefaultsOutputV1Schema } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema,
  projectExternalActionDeploymentPreparationEnvelopeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createRegistryHostV1, DeploymentTemplateV1Schema, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1,
  type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { createHarness, resetFilesystemApprovalSocketBoundary } from './executeExternalAction.filesystemApprovals.testkit';

afterEach(() => { vi.restoreAllMocks(); resetFilesystemApprovalSocketBoundary(); resetServerFeaturesClientForTests(); });

it.each(['deployments.templates.instantiate', 'deployments.environments.create'] as const)(
  'rejects an undeclared generator and previews a Catalog App through the public CLI and installed daemon: %s', async actionId => {
    let installationId = '';
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 1,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const h = await createHarness(actionId, 'allowed', false, 'srv_n2', { token,
      request: () => null,
      mintAuthorization: async (requestedActionId, envelope, authentication) => ExternalActionExecutionAuthorizationV1Schema.parse({
        v: 1, token: 'catalog-preview-admission', binding: { accountId: 'account', custodianAccountId: 'account', authentication,
          admittedMachineRole: 'manage', accountEncryptionMode: 'plain', serverIdentityId: 'srv_n2', machineId: 'machine', installationId,
          actionId: requestedActionId, requestId: envelope.requestId, target: envelope.target,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
          deploymentPreparationAdmission: projectExternalActionDeploymentPreparationEnvelopeAdmissionV1({ actionId: requestedActionId, envelope }) } }),
    });
    installationId = h.installation.installationId;
    try {
      const passwordKey = 'SERVICE_PASSWORD_TERRARIA';
      const app = DeploymentTemplateV1Schema.parse({ schemaVersion: 1, title: 'Catalog App',
        compose: { document: 'services:\n  web:\n    image: nginx:1\n    environment:\n      PASSWORD: ${SERVICE_PASSWORD_TERRARIA}\n', profiles: [], services: ['web'] },
        variables: [{ key: passwordKey, label: 'Password', required: true, secret: true, valueKind: 'string',
          sites: [{ service: 'web', path: ['environment', 'PASSWORD'] }] }],
        generatedSecrets: [{ key: passwordKey, purpose: 'Password', label: 'Password',
          profile: { kind: 'alphanumeric-characters', characters: 32 } }], domains: [], volumes: [] });
      const source: RegistrySourceDescriptorV1 = { id: 'apps', title: 'Apps', format: 'happier-catalog', kinds: ['app'],
        url: 'https://apps.test/catalog.json', enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
      const catalog = { schemaVersion: 1, apps: [{ itemId: 'app', app }] };
      const registry = createRegistryHostV1({ host: 'node', readSources: async () => [source], http: {
        getJson: async () => ({ ok: true, value: catalog, fetchedAt: 1 }),
        getText: async () => { throw new Error('Unexpected text fetch'); },
        getBytes: async () => { throw new Error('Unexpected binary fetch'); },
      } });
      const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute(
        'registries.items.read', { sourceId: source.id, kind: 'app', itemId: 'app' })).item;
      expect(selected.payload).toMatchObject({ kind: 'app', state: 'ready' });
      if (selected.payload.kind !== 'app') throw new Error('Expected Catalog App');
      const templateRef = { sourceId: source.id, itemId: 'app', version: selected.summary.version!, ref: selected.payload.ref };
      const { origin: _origin, removable: _removable, ...sourceRow } = source;
      // Substitute Home/catalog HTTP only. CLI placement, private control HTTP,
      // authorization projection, daemon composition and template preparation stay real.
      const get = vi.mocked(axios.get).getMockImplementation()!;
      vi.mocked(axios.get).mockImplementation(async (...args) => {
        if (new URL(String(args[0])).pathname === '/v1/account/entity-rows/prompt-library') return { status: 200,
          data: PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
            key, revision: 1, content: key === 'registry-sources' ? { t: 'plain', v: { key,
              value: { v: 2, sources: [sourceRow], disabledSourceIds: [] } } } : null })) }) };
        return get(...args);
      });
      const request = vi.mocked(axios.request).getMockImplementation()!;
      vi.mocked(axios.request).mockImplementation(async config => {
        const path = config.url ? new URL(config.url).pathname : '';
        if (path === '/v1/projects/sources/project') return { status: 200, data: { ok: true, canManage: true,
          source: { id: 'project', revision: 1, name: 'Project', createdByAccountId: 'account', audience: [] } } };
        if (path === '/v1/projects/project/deployment-defaults') return { status: 200,
          data: ProjectDeploymentDefaultsOutputV1Schema.parse({ ok: true, projectSourceId: 'project', sourceRevision: 1,
            revision: 0, content: null }) };
        if (path === '/v1/machines/managed/actions/list') return request(config);
        if (config.url && config.method?.toUpperCase() === 'GET') return axios.get(config.url, config);
        if (config.url && config.method?.toUpperCase() === 'POST') return axios.post(config.url, config.data, config);
        return request(config);
      });
      const post = vi.mocked(axios.post).getMockImplementation()!;
      const boundaryFailures: string[] = [];
      vi.mocked(axios.post).mockImplementation(async (...args) => {
        const response = await post(...args).catch(error => {
          boundaryFailures.push(`${new URL(String(args[0])).pathname}: ${String(error)}`);
          throw error;
        });
        return response;
      });
      const fetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
      vi.mocked(globalThis.fetch).mockImplementation(async (...args) => String(args[0]) === source.url
        ? Response.json(catalog) : fetch(...args));
      const environment = { name: 'Catalog App', requestKey: 'catalog-preview', protection: 'nonProduction',
        purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'machine', buildMachineId: 'machine' };
      const shared = { mode: 'preview', serverId: 'srv_n2', projectSourceId: 'project',
        generatedSecretAudience: { accountGrants: ['account'] },
        bindings: [{ purpose: 'variable', name: passwordKey, phase: 'runtime',
          source: { kind: 'generated', key: passwordKey } }] };
      const input = actionId === 'deployments.templates.instantiate'
        ? { ...shared, machineId: 'machine', templateRef, environment: { kind: 'create', ...environment },
          target: { kind: 'new', installationId: h.installation.installationId }, destination: { kind: 'stored' } }
        : { ...shared, ...environment, definition: { from: 'catalogApp', templateRef },
          firstTargetLink: { machines: [{ machineId: 'machine', installationId: h.installation.installationId }] } };
      // Registry readiness describes the template. An instance still has to
      // select its declared generator, rather than invent a Saved Secret name.
      const invalid = await h.runPublicCli({ ...input, bindings: [{ ...shared.bindings[0],
        source: { kind: 'generated', key: 'app-journey-b-1101-terraria-password' } }] }, actionId);
      expect(invalid).toMatchObject({ ok: false, error: { code: 'template_generator_undeclared' } });
      const result = await h.runPublicCli(input, actionId);
      expect(result, JSON.stringify({ result, boundaryFailures, paths: h.networkPaths, outcomes: h.rpcOutcomes }))
        .toMatchObject({ ok: true, data: { kind: 'preview' } });
      const templateReview = { generatedSecrets: [{ name: passwordKey, key: passwordKey }] };
      expect(result).toMatchObject({ data: { review: actionId === 'deployments.environments.create'
        ? { template: templateReview } : templateReview } });
      expect(h.networkPaths.filter(path => path === 'POST /v1/artifacts')).toEqual([]);
      expect(h.spawned).toEqual([]);
    } finally { await h.close(); }
  }, 120_000);
