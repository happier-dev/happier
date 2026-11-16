import { afterAll, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { FeaturesResponseSchema, DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema, ProjectAccountWorkspaceRefV1Schema }
  from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { projectProjectListV1, resolveProjectContextSourceV1 } from '@happier-dev/protocol/projects/projectListProjectionV1';
import { readDeploymentDomainServingUrlV1 } from '@happier-dev/protocol/deployments/deploymentDomainContentV1';

import { fetchArtifactViaApi, decodeEncryptedArtifactJsonBase64ForCliAccessKey } from '../artifactApi';
import { buildTestAccountCliAuthCredentials } from '../cliAuth';
import { fetchJson } from '../http';
import { startServerLight, type StartedServer } from '../process/serverLight';
import { createRunDirs } from '../runDir';
import { isQaBedProfileName, seedQaBedAccount } from './seedQaBedAccount';

let server: StartedServer | undefined;
afterAll(async () => { await server?.stop(); });

it('admits the record-only deployment preview bed through the canonical profile owner', () => {
  expect(isQaBedProfileName('deploy-preview')).toBe(true);
  expect(isQaBedProfileName('deploy-preview-live')).toBe(false);
});

it('seeds Production and a deployed preview as ordinary API records without a daemon or provider', async () => {
  const profile = 'deploy-preview';
  expect(isQaBedProfileName(profile)).toBe(true);
  if (!isQaBedProfileName(profile)) throw new Error('deploy-preview profile unavailable');
  server = await startServerLight({ testDir: createRunDirs({ runLabel: 'qa-bed' }).testDir('deploy-preview'), dbProvider: 'sqlite',
    extraEnv: { HAPPIER_FEATURE_DEPLOYMENTS__ENABLED: '1', HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1' } });
  const seeded = await seedQaBedAccount({ baseUrl: server.baseUrl, profile, seed: 90210 });
  const features = await fetchJson<unknown>(`${server.baseUrl}/v1/features`);
  const serverId = FeaturesResponseSchema.parse(features.data).capabilities.serverIdentity.serverIdentityId;
  const headers = { Authorization: `Bearer ${seeded.auth.token}` };
  const census = await fetchJson<unknown>(`${server.baseUrl}${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ serverId }),
  });
  const rows = ProjectAccountRowListResponseV1Schema.parse(census.data);
  if (rows.status !== 'listed') throw new Error(rows.status);
  const cipher = createProjectAccountRowCipherV1({ mode: 'e2ee',
    material: { type: 'dataKey', machineKey: seeded.auth.accountMachineKey }, randomBytes });
  const refs = rows.rows.flatMap(row => row.key.kind === 'workspace-ref' && row.content
    ? [ProjectAccountWorkspaceRefV1Schema.parse(cipher.open(row.key, row.content).value)] : []);
  const projects = projectProjectListV1({ serverId, workspaceRefs: refs, listing: 'listed' });
  expect(projects.listedProjectGroups).toHaveLength(1);
  expect(resolveProjectContextSourceV1({ projectRef: projects.listedProjectGroups[0].projectKey,
    workspaceRefs: refs, organizationPresent: false })).toEqual({ kind: 'source', sourceId: seeded.summary.deployments?.projectSourceId });
  const list = await fetchJson<unknown>(`${server.baseUrl}/v1/deployments/environments?serverId=${serverId}`, { headers });
  expect(list.status).toBe(200);
  const environments = DeploymentActionOutputSchemasV1['deployments.environments.list'].parse(list.data);
  expect(environments).toMatchObject({ ok: true, items: expect.arrayContaining([
    expect.objectContaining({ protection: 'production', purpose: 'standard' }),
    expect.objectContaining({ protection: 'nonProduction', purpose: 'preview' }),
  ]) });
  if (!environments.ok) throw new Error(environments.error);
  const preview = environments.items.find(environment => environment.purpose === 'preview');
  if (!preview) throw new Error('preview missing');
  const read = await fetchJson<unknown>(`${server.baseUrl}/v1/deployments/environments/${preview.id}?serverId=${serverId}`, { headers });
  const detail = DeploymentActionOutputSchemasV1['deployments.environments.get'].parse(read.data);
  expect(detail).toMatchObject({ ok: true, targetLinks: [expect.objectContaining({ state: 'deployed', activeDeploymentId: expect.any(String) })] });
  const domainsRead = await fetchJson<unknown>(`${server.baseUrl}/v1/deployments/environments/${preview.id}/domains?serverId=${serverId}`, { headers });
  const domains = DeploymentActionOutputSchemasV1['deployments.domains.list'].parse(domainsRead.data);
  expect(domains).toMatchObject({ ok: true, domains: [expect.objectContaining({ state: 'warning', targetLinkId: expect.any(String) })] });
  if (!domains.ok || !domains.domains[0]) throw new Error('preview Domain missing');
  const domain = domains.domains[0];
  const saved = await fetchArtifactViaApi({ baseUrl: server.baseUrl, token: seeded.auth.token, artifactId: domain.contentArtifactId });
  const opened = decodeEncryptedArtifactJsonBase64ForCliAccessKey<{ body: string }>({ encryptedJsonBase64: saved.body,
    dataEncryptionKeyBase64: saved.dataEncryptionKey, cliAccessKey: buildTestAccountCliAuthCredentials({ auth: seeded.auth, mode: 'dataKey' }) });
  expect(readDeploymentDomainServingUrlV1(JSON.parse(opened?.body ?? 'null'))).toBe('https://preview.records-only.invalid/');
  expect(domain.targetLinkId).toBe(detail.ok ? detail.targetLinks[0]?.id : undefined);
}, 240_000);
