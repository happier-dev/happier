import { afterAll, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  AccountEncryptionCurrentnessResponseSchema, AccountEncryptionModeResponseSchema, buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, decodePlainArtifactStoredContent, decodePlainMachineStoredContent,
  DeploymentActionOutputSchemasV1, FeaturesResponseSchema,
} from '@happier-dev/protocol';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema, ProjectAccountWorkspaceRefV1Schema }
  from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { projectProjectListV1, resolveProjectContextSourceV1 } from '@happier-dev/protocol/projects/projectListProjectionV1';
import { readDeploymentDomainServingUrlV1 } from '@happier-dev/protocol/deployments/deploymentDomainContentV1';

import { fetchArtifactViaApi, decodeEncryptedArtifactJsonBase64ForCliAccessKey, listArtifactsViaApi } from '../artifactApi';
import { buildTestAccountCliAuthCredentials } from '../cliAuth';
import { fetchJson } from '../http';
import type { MachineIdentityRow } from '../machineIdentity';
import { fetchAllMessages, fetchSessionV2, fetchSessionsV2 } from '../sessions';
import { startServerLight, type StartedServer } from '../process/serverLight';
import { createRunDirs } from '../runDir';
import { isQaBedProfileName, seedQaBedAccount } from './seedQaBedAccount';
import { QA_BED_DEMO_STORY } from './demoStory';

let server: StartedServer | undefined;
let demoServer: StartedServer | undefined;
afterAll(async () => { await server?.stop(); await demoServer?.stop(); });

it('admits the record-only deployment preview bed through the canonical profile owner', () => {
  expect(isQaBedProfileName('deploy-preview')).toBe(true);
  expect(isQaBedProfileName('deploy-preview-live')).toBe(false);
});

it.each(['plain', 'e2ee'] as const)('seeds a small bed on an optional Home with %s as its default', async (mode) => {
  const home = await startServerLight({ testDir: createRunDirs({ runLabel: 'qa-bed' }).testDir(`small-${mode}`), dbProvider: 'sqlite',
    extraEnv: {
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
      HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: mode,
      HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
    } });
  try {
    const seeded = await seedQaBedAccount({ baseUrl: home.baseUrl, profile: 'small' });
    const headers = { Authorization: `Bearer ${seeded.auth.token}`,
      ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
    const account = await fetchJson<unknown>(`${home.baseUrl}/v1/account/encryption`, { headers });
    expect(AccountEncryptionModeResponseSchema.parse(account.data).mode).toBe(mode);
    expect(seeded.summary).toMatchObject({ sessions: 12, machines: 2, artifacts: 6 });
    const machineList = await fetchJson<MachineIdentityRow[]>(`${home.baseUrl}/v1/machines`, { headers });
    expect(machineList.status).toBe(200);
    const machines = machineList.data;
    const artifacts = await listArtifactsViaApi({ baseUrl: home.baseUrl, token: seeded.auth.token });
    expect(machines).toHaveLength(2);
    expect(artifacts).toHaveLength(6);
    if (mode === 'plain') {
      const currentness = await fetchJson<unknown>(`${home.baseUrl}/v1/account/encryption/currentness`, { headers });
      expect(AccountEncryptionCurrentnessResponseSchema.parse(currentness.data).contentKeyFingerprint).toBeNull();
      expect(machines.map(machine => typeof machine.metadata === 'string' ? decodePlainMachineStoredContent(machine.metadata) : null)).toEqual(expect.arrayContaining([
        expect.objectContaining({ host: 'qa-dev-000' }),
        expect.objectContaining({ host: 'qa-dev-001' }),
      ]));
      expect(artifacts.map(artifact => decodePlainArtifactStoredContent(artifact.header))).toContainEqual({ title: 'qa artifact 0' });
    }
    const longSessionId = seeded.summary.longSessionIds[0];
    expect(longSessionId).toBeDefined();
    const messages = await fetchJson<{ messages: Array<{ content: unknown }> }>(`${home.baseUrl}/v1/sessions/${longSessionId}/messages?afterSeq=0&limit=120`, { headers });
    expect(messages.status).toBe(200);
    expect(messages.data.messages).toHaveLength(120);
    expect(messages.data.messages[0]?.content).toMatchObject(mode === 'plain'
      ? { t: 'plain', v: { role: 'user' } }
      : { t: 'encrypted', c: expect.any(String) });
  } finally {
    await home.stop();
  }
}, 240_000);

it('seeds Production and a deployed preview as ordinary API records without a daemon or provider', async () => {
  const profile = 'deploy-preview';
  expect(isQaBedProfileName(profile)).toBe(true);
  if (!isQaBedProfileName(profile)) throw new Error('deploy-preview profile unavailable');
  server = await startServerLight({ testDir: createRunDirs({ runLabel: 'qa-bed' }).testDir('deploy-preview'), dbProvider: 'sqlite',
    extraEnv: { HAPPIER_FEATURE_DEPLOYMENTS__ENABLED: '1', HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1' } });
  const seeded = await seedQaBedAccount({ baseUrl: server.baseUrl, profile, seed: 90210 });
  if (!('accountMachineKey' in seeded.auth)) throw new Error('deploy-preview fixture requires E2EE');
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

it('seeds the demo story world: named Sessions, a featured turn with a diff and terminal output, and a pending approval', async () => {
  const profile = 'demo';
  expect(isQaBedProfileName(profile)).toBe(true);
  if (!isQaBedProfileName(profile)) throw new Error('demo profile unavailable');
  demoServer = await startServerLight({ testDir: createRunDirs({ runLabel: 'qa-bed' }).testDir('demo'), dbProvider: 'sqlite' });
  const seeded = await seedQaBedAccount({ baseUrl: demoServer.baseUrl, profile, seed: 4242 });
  if (!('accountMachineKey' in seeded.auth)) throw new Error('demo fixture expected E2EE');
  const cliAccessKey = buildTestAccountCliAuthCredentials({ auth: seeded.auth, mode: 'dataKey' });
  const open = <T>(encryptedJsonBase64: string, dataEncryptionKeyBase64: unknown) => decodeEncryptedArtifactJsonBase64ForCliAccessKey<T>({
    encryptedJsonBase64, dataEncryptionKeyBase64: String(dataEncryptionKeyBase64), cliAccessKey });

  // The list row omits metadata and agent state; the by-id read carries them.
  const listed = await fetchSessionsV2(demoServer.baseUrl, seeded.auth.token, { limit: 50 });
  const sessions = await Promise.all(listed.sessions.map(row => fetchSessionV2(demoServer!.baseUrl, seeded.auth.token, row.id)));
  const named = sessions.map(session => ({ session, name: open<{ name: string }>(session.metadata, session.dataEncryptionKey)?.name }));
  expect(named.map(entry => entry.name).sort()).toEqual(QA_BED_DEMO_STORY.sessions.map(story => story.name).sort());
  expect(seeded.summary).toMatchObject({ profile, machines: 1, sessions: QA_BED_DEMO_STORY.sessions.length });

  const featured = named.find(entry => entry.session.id === seeded.summary.demo?.featuredSessionId);
  if (!featured) throw new Error('featured demo Session missing');
  expect(featured.name).toBe(QA_BED_DEMO_STORY.sessions.find(story => story.featured)?.name);
  const agentState = open<{ requests?: Record<string, { tool: string }> }>(String(featured.session.agentState), featured.session.dataEncryptionKey);
  expect(agentState?.requests?.[QA_BED_DEMO_STORY.pendingApproval.id]?.tool).toBe(QA_BED_DEMO_STORY.pendingApproval.tool);

  const turn = (await fetchAllMessages(demoServer.baseUrl, seeded.auth.token, featured.session.id))
    .map(row => JSON.stringify(open<unknown>(row.content.c, featured.session.dataEncryptionKey)));
  expect(turn).toHaveLength(QA_BED_DEMO_STORY.featuredTurn(String).length);
  expect(turn.some(message => message.includes('"name":"Edit"') && message.includes('old_string'))).toBe(true);
  expect(turn.some(message => message.includes('"tool_result"') && message.includes('PASS'))).toBe(true);
}, 240_000);
