import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { RequestOptions } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginPublishInspectResultSchema, PluginPublishPrepareResultSchema } from '@happier-dev/protocol/actions/actionSpecs';
import type { PluginPublicationBotTemplate } from '@happier-dev/protocol/actions/actionSpecs';
import type { PluginPublishActionInput, PluginPublishResult } from '@happier-dev/protocol/actions/actionSpecs';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createBotTemplateActionExecuteV1 } from '@happier-dev/protocol/bots/templates/botTemplateOperations';
import { projectBotTemplateArtifactHeaderV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import * as tar from 'tar';
import { createWorkBoardArtifactBoundary } from '../../../../../packages/protocol/src/boards/workBoardArtifactV1.testkit';

import { createPluginManifestV2Fixture } from '../testkit/manifestV2Fixture';
import { createNpmRegistryProfileService } from '../distribution/npm/profiles/service';
import { npmHttpRequestBoundary, npmHttpResponse } from '../distribution/testkit/npmHttp';
import { checkPluginPublicationStatus, inspectPluginPublication, preparePluginPublication, publishPluginPublication } from './publish';

describe('generic plugin publication', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'happier-publication-'));
    roots.push(root);
    const projectRoot = join(root, 'plugin');
    const happyHomeDir = join(root, 'home');
    await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(createPluginManifestV2Fixture()));
    await writeFile(join(projectRoot, 'daemon.mjs'), 'export function activate() {}\n');
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'happier-plugin-publication-fixture', version: '1.0.0', keywords: ['happier-plugin'],
      happier: { manifest: '.happier-plugin/plugin.json' }, files: ['.happier-plugin', 'daemon.mjs'],
    }));
    const profiles = createNpmRegistryProfileService({ happyHomeDir });
    await profiles.mutate({ action: 'add', machineId: 'fixture-machine', expectedRevision: 0, mutationId: 'add-fixture',
      profileId: 'registry_fixture', profile: { displayName: 'Fixture', origin: 'https://registry.fixture.test',
        scopes: [], useAsDefault: true, allowPrivateNetwork: false } });
    await profiles.mutate({ action: 'login', machineId: 'fixture-machine', expectedRevision: 1, mutationId: 'login-fixture',
      profileId: 'registry_fixture', credential: { kind: 'bearer_token', secret: 'publication-boundary-fixture' } });
    return { projectRoot, happyHomeDir, profileId: 'registry_fixture' };
  }

  const publication = { packageName: '@fixture/plugin', version: '1.1.0', title: 'Reviewed plugin', description: 'Listing',
    keywords: ['automation'], readme: '# Reviewed', changelog: 'Added listing' };
  const lookup = async () => [{ address: '93.184.216.34', family: 4 as const }];
  const templateSeed = (): PluginPublicationBotTemplate => ({ draftArtifactId: '8e60ee82-ac53-4f6f-b04c-ff7ef873b9c9',
    expectedRevision: { headerVersion: 1, bodyVersion: 2 }, release: { v: 1, version: '1.0.0', releasedAtMs: 100,
      changelog: 'Initial', content: { v: 1, identity: { name: 'Garden', description: 'Garden advice', madeFromName: 'Garden Bot' },
        instructions: { markdown: 'Explain tradeoffs.' }, memoryRules: [], skills: [],
        needs: { software: [], connectedAccounts: [], mcpServers: [] } } } });

  function templatePublicationHost(botTemplate: PluginPublicationBotTemplate, options: Parameters<typeof publishPluginPublication>[1]) {
    const boundary = createWorkBoardArtifactBoundary();
    const draft = { v: 1 as const, state: 'draft' as const, releaseArtifactId: '84a6bc9c-0418-44f6-a593-8a751bde13e0',
      sourceSessionRef: { serverId: 'home', sessionId: 'private-author' }, content: botTemplate.release.content,
      candidates: { memoryRules: [], skills: [] } };
    boundary.rows.set(botTemplate.draftArtifactId, { artifactId: botTemplate.draftArtifactId, header: projectBotTemplateArtifactHeaderV1(draft),
      body: JSON.stringify(draft), revision: botTemplate.expectedRevision, access: 'owner', shared: false });
    const release = createBotTemplateActionExecuteV1({ artifacts: boundary.forAccount('author'), randomId: () => 'unused',
      readSourceDraftRef: async () => null, writeSourceDraftRef: async () => undefined, grant: async () => undefined,
      nowMs: () => botTemplate.release.releasedAtMs });
    const executor = createActionExecutor({ botTemplateAction: release,
      pluginsDevLoopAction: async ({ input, context }) => ({ ok: true, kind: 'plugins_dev_publish',
        result: await publishPluginPublication(input as PluginPublishActionInput, { ...options, hostReviewedChild: context.hostReviewedChild }) }) });
    return { boundary, draft, publish: async (input: PluginPublishActionInput): Promise<PluginPublishResult> => {
      const response = await executor.execute('plugins.dev.publish', input, { surface: 'ui', authority: 'present_user', runtimeAccountId: 'author',
        serverId: 'home', serverIdentityId: 'home-identity', actionCaller: { kind: 'host' },
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'plugins.dev.publish': ['ui'] } }) });
      if (!response.ok) throw new Error(response.errorCode);
      return (response.result as { result: PluginPublishResult }).result;
    } };
  }

  it('generates a single cold template package through the ordinary pack owner without author addresses', async () => {
    const fixtureInput = await fixture();
    const botTemplate = templateSeed();
    const input = { botTemplate, profileId: fixtureInput.profileId, publication };
    const options = { happyHomeDir: fixtureInput.happyHomeDir };
    const inspected = await inspectPluginPublication({ botTemplate }, options);
    expect(inspected, JSON.stringify(inspected)).toMatchObject({ status: 'ready', publication: { title: 'Garden' } });
    expect(inspected).not.toHaveProperty('projectRoot');
    const prepared = await preparePluginPublication(input, options);
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ status: 'prepared', version: '1.1.0' });
    if (prepared.status !== 'prepared') throw new Error('Template package not prepared');
    expect(prepared).not.toHaveProperty('projectRoot');
    expect(prepared.files.map(file => file.path)).toContain('.happier-plugin/bot-template.json');
    const bodies: (string | undefined)[] = [];
    const seen: RequestOptions[] = [];
    const host = templatePublicationHost(botTemplate,
      { ...options, npmHttp: { lookup, request: npmHttpRequestBoundary({ responses: [new Error('connection_lost'), npmHttpResponse({ ok: true })], seen, bodies }) } });
    expect(host.boundary.rows.size).toBe(1);
    const finalInput = { ...input, access: 'public' as const, mode: 'direct' as const, expectedArchiveIntegrity: prepared.archiveIntegrity };
    expect(await host.publish({ ...finalInput, expectedArchiveIntegrity: 'old-reviewed-archive' })).toMatchObject({ status: 'review_required' });
    expect(host.boundary.reads).toEqual([]);
    expect(await host.publish({ ...finalInput, botTemplate: { ...botTemplate,
      expectedRevision: { headerVersion: 1, bodyVersion: 3 } } })).toMatchObject({ status: 'failed', code: 'version_mismatch' });
    expect(seen).toEqual([]);
    const readsBeforeUpload = host.boundary.reads.filter(id => id === botTemplate.draftArtifactId).length;
    expect(await host.publish(finalInput)).toMatchObject({ status: 'outcome_unknown' });
    expect(host.boundary.rows.size).toBe(2);
    const retainedRelease = host.boundary.rows.get(host.draft.releaseArtifactId);
    expect(host.boundary.reads.filter(id => id === botTemplate.draftArtifactId)).toHaveLength(readsBeforeUpload + 1);
    const result = await host.publish(finalInput);
    expect(result).toMatchObject({ status: 'published', version: publication.version });
    expect(host.boundary.rows.get(host.draft.releaseArtifactId)).toEqual(retainedRelease);
    expect(host.boundary.reads.filter(id => id === botTemplate.draftArtifactId)).toHaveLength(readsBeforeUpload + 2);
    expect(JSON.parse(host.boundary.rows.get(host.draft.releaseArtifactId)!.body!)).toMatchObject({ state: 'released',
      release: { version: publication.version, changelog: publication.changelog, releasedAtMs: 100 } });
    const document = JSON.parse(bodies.at(-1)!);
    const archive = join(fixtureInput.projectRoot, 'uploaded.tgz');
    await writeFile(archive, Buffer.from(Object.values(document._attachments as Record<string, { data: string }>)[0]!.data, 'base64'));
    const files = new Map<string, string>();
    await tar.t({ file: archive, onentry(entry) { const chunks: Buffer[] = []; entry.on('data', (chunk: Buffer) => chunks.push(chunk));
      entry.on('end', () => files.set(entry.path, Buffer.concat(chunks).toString('utf8'))); } });
    const release = JSON.parse(files.get('package/.happier-plugin/bot-template.json')!);
    expect(release).toEqual({ ...botTemplate.release, version: publication.version, changelog: publication.changelog });
    expect(JSON.parse(files.get('package/.happier-plugin/plugin.json')!)).toMatchObject({ version: publication.version,
      contributes: { botTemplates: [{ id: 'template', path: '.happier-plugin/bot-template.json' }] } });
    expect([...files.values()].join('\n')).not.toContain(botTemplate.draftArtifactId);
  });

  it('requires an admitted template release before any public upload', async () => {
    const fixtureInput = await fixture();
    const input = { botTemplate: templateSeed(), profileId: fixtureInput.profileId, publication };
    const prepared = await preparePluginPublication(input, { happyHomeDir: fixtureInput.happyHomeDir });
    if (prepared.status !== 'prepared') throw new Error(JSON.stringify(prepared));
    const seen: RequestOptions[] = [];
    const result = await publishPluginPublication({ ...input, access: 'public', mode: 'direct', expectedArchiveIntegrity: prepared.archiveIntegrity },
      { happyHomeDir: fixtureInput.happyHomeDir, npmHttp: { lookup,
        request: npmHttpRequestBoundary({ responses: [npmHttpResponse({ ok: true })], seen }) } });
    expect(result).toMatchObject({ status: 'failed', code: 'template_admission_unavailable' });
    expect(seen).toEqual([]);
  });

  it('prepares the effective archive listing without rewriting author source', async () => {
    const input = await fixture();
    const original = await readFile(join(input.projectRoot, 'package.json'), 'utf8');
    const result = await preparePluginPublication({ ...input, publication }, { happyHomeDir: input.happyHomeDir });
    expect(result).toMatchObject({ status: 'prepared', packageName: '@fixture/plugin', version: '1.1.0',
      publication: { title: 'Reviewed plugin' }, tests: { status: 'not_configured' }, npmIntegrity: expect.stringMatching(/^sha512-/) });
    expect(result).toHaveProperty('files', expect.arrayContaining([expect.objectContaining({ path: 'README.md' })]));
    expect(await readFile(join(input.projectRoot, 'package.json'), 'utf8')).toBe(original);
  });

  it('prepares the canonical package directory when given a manifest file locator', async () => {
    const input = await fixture();
    const result = await preparePluginPublication({
      projectRoot: join(input.projectRoot, '.happier-plugin', 'plugin.json'), publication,
    }, { happyHomeDir: input.happyHomeDir });
    expect(result).toMatchObject({ status: 'prepared', projectRoot: input.projectRoot });
  });

  it('requires review of changed archive bytes before any npm request', async () => {
    const input = await fixture();
    const seen: RequestOptions[] = [];
    const result = await publishPluginPublication({ ...input, publication, access: 'public', mode: 'direct',
      expectedArchiveIntegrity: 'sha256-old-reviewed-candidate' }, { happyHomeDir: input.happyHomeDir,
      npmHttp: { lookup, request: npmHttpRequestBoundary({ responses: [], seen }) } });
    expect(result).toMatchObject({ status: 'review_required', preparation: { packageName: '@fixture/plugin' } });
    expect(seen).toHaveLength(0);
  });

  it('projects localized manifest text through public inspect and prepared schemas', async () => {
    const input = await fixture();
    await writeFile(join(input.projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(createPluginManifestV2Fixture({
      displayName: { key: 'plugin.title', fallback: 'Localized listing' },
      description: { key: 'plugin.description', fallback: 'Localized description' },
    })));
    const inspected = PluginPublishInspectResultSchema.parse(await inspectPluginPublication({ projectRoot: input.projectRoot }, { happyHomeDir: input.happyHomeDir }));
    expect(inspected).toMatchObject({ status: 'ready', publication: { title: 'Localized listing', description: 'Localized description' } });
    const prepared = PluginPublishPrepareResultSchema.parse(await preparePluginPublication({ projectRoot: input.projectRoot }, { happyHomeDir: input.happyHomeDir }));
    expect(prepared).toMatchObject({ status: 'prepared', publication: { title: 'Localized listing', description: 'Localized description' } });
    if (prepared.status !== 'prepared') throw new Error('Fixture archive was not prepared');
    const repeated = await preparePluginPublication({ projectRoot: input.projectRoot, publication: prepared.publication }, { happyHomeDir: input.happyHomeDir });
    expect(repeated).toMatchObject({ status: 'prepared', archiveIntegrity: prepared.archiveIntegrity });
  });

  it('reproduces a reviewed uploaded icon from the effective preparation metadata', async () => {
    const input = await fixture();
    const bytes = await readFile(new URL('../../../../../packages/plugins/custom-acp/assets/brand.png', import.meta.url));
    const iconSource = { contentType: 'image/png' as const, dataBase64: bytes.toString('base64') };
    const prepared = await preparePluginPublication({ projectRoot: input.projectRoot, publication: { ...publication, iconSource } }, { happyHomeDir: input.happyHomeDir });
    expect(prepared).toMatchObject({ status: 'prepared', publication: { iconSource } });
    if (prepared.status !== 'prepared') throw new Error('Fixture archive was not prepared');
    const repeated = await preparePluginPublication({ projectRoot: input.projectRoot, publication: prepared.publication }, { happyHomeDir: input.happyHomeDir });
    expect(repeated).toMatchObject({ status: 'prepared', archiveIntegrity: prepared.archiveIntegrity });
  });

  it('lists packaged icon choices from the canonical resource declarations', async () => {
    const input = await fixture();
    await writeFile(join(input.projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(createPluginManifestV2Fixture({
      contributes: { resources: [{ id: 'mark', kind: 'asset', path: '.happier-plugin/mark.svg', contentType: 'image/svg+xml' }] },
    })));
    await writeFile(join(input.projectRoot, '.happier-plugin', 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const result = await inspectPluginPublication({ projectRoot: input.projectRoot }, { happyHomeDir: input.happyHomeDir });
    expect(result).toMatchObject({ status: 'ready', resources: [{ id: 'mark', kind: 'asset', path: '.happier-plugin/mark.svg', contentType: 'image/svg+xml' }] });
  });

  it('hands a standalone source module to the existing scaffold flow without writing it', async () => {
    const input = await fixture();
    await rm(join(input.projectRoot, 'package.json'));
    const locator = join(input.projectRoot, 'daemon.mjs');
    const original = await readFile(locator, 'utf8');
    const inspected = PluginPublishInspectResultSchema.parse(await inspectPluginPublication({ projectRoot: locator }, { happyHomeDir: input.happyHomeDir }));
    expect(inspected).toMatchObject({ status: 'failed', diagnostics: [{ code: 'publication_scaffold_required' }],
      scaffold: { sourceRootPath: locator, sessionDirectory: input.projectRoot } });
    expect(await readFile(locator, 'utf8')).toBe(original);
  });

  it('publishes the reviewed archive once and exposes only public profile facts', async () => {
    const input = await fixture();
    const prepared = await preparePluginPublication({ ...input, publication }, { happyHomeDir: input.happyHomeDir });
    if (prepared.status !== 'prepared') throw new Error('Fixture archive was not prepared');
    const seen: RequestOptions[] = [];
    const bodies: (string | undefined)[] = [];
    const result = await publishPluginPublication({ ...input, publication, access: 'public', mode: 'direct',
      expectedArchiveIntegrity: prepared.archiveIntegrity }, { happyHomeDir: input.happyHomeDir,
      npmHttp: { lookup, request: npmHttpRequestBoundary({ responses: [npmHttpResponse({ ok: true })], seen, bodies }) } });
    expect(result).toMatchObject({ status: 'published', packageName: '@fixture/plugin', version: '1.1.0', integrity: prepared.npmIntegrity });
    expect(seen.map(request => request.method)).toEqual(['PUT']);
    const document: unknown = JSON.parse(bodies[0] ?? '{}');
    expect(document).toMatchObject({ name: '@fixture/plugin', versions: { '1.1.0': { name: '@fixture/plugin', version: '1.1.0' } } });
    expect(JSON.stringify(result).includes('publication-boundary-fixture')).toBe(false);
  });

  it('recovers a lost upload reply with one explicit version read and no upload replay', async () => {
    const input = await fixture();
    const prepared = await preparePluginPublication({ ...input, publication }, { happyHomeDir: input.happyHomeDir });
    if (prepared.status !== 'prepared') throw new Error('Fixture archive was not prepared');
    const seen: RequestOptions[] = [];
    const result = await publishPluginPublication({ ...input, publication, access: 'public', mode: 'direct',
      expectedArchiveIntegrity: prepared.archiveIntegrity }, { happyHomeDir: input.happyHomeDir,
      npmHttp: { lookup, request: npmHttpRequestBoundary({ responses: [new Error('lost reply')], seen }) } });
    expect(result).toMatchObject({ status: 'outcome_unknown' });
    if (!('integrity' in result) || typeof result.integrity !== 'string') throw new Error('Recovery needs expected npm integrity');
    const recovered = await checkPluginPublicationStatus({ profileId: input.profileId, packageName: '@fixture/plugin',
      version: '1.1.0', integrity: result.integrity }, { happyHomeDir: input.happyHomeDir,
      npmHttp: { lookup, request: npmHttpRequestBoundary({ responses: [npmHttpResponse({ name: '@fixture/plugin', version: '1.1.0',
        dist: { integrity: result.integrity } })], seen }) } });
    expect(recovered).toMatchObject({ status: 'published' });
    expect(seen.map(request => request.method ?? 'GET')).toEqual(['PUT', 'GET']);
  });

  it('inspects only selected package history without disclosing stored authorization', async () => {
    const input = await fixture();
    const seen: RequestOptions[] = [];
    const result = await inspectPluginPublication({ ...input, packageName: '@fixture/plugin' }, { happyHomeDir: input.happyHomeDir,
      npmHttp: { lookup, request: npmHttpRequestBoundary({ responses: [npmHttpResponse({ name: '@fixture/plugin', versions: {
        '1.3.0': { version: '1.3.0', dist: { integrity: 'sha512-fixture' } },
      }, 'dist-tags': { latest: '1.3.0' } })], seen }) } });
    expect(result).toMatchObject({ status: 'ready', nextVersions: { patch: '1.3.1', minor: '1.4.0', major: '2.0.0' },
      history: { packageUrl: 'https://registry.fixture.test/@fixture%2fplugin',
        versions: [{ version: '1.3.0', versionUrl: 'https://registry.fixture.test/@fixture%2fplugin/1.3.0' }] }, profiles: [{ profileId: input.profileId }] });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('/@fixture%2fplugin');
    expect(JSON.stringify(result).includes('publication-boundary-fixture')).toBe(false);
  });

  it('reports a stage awaiting maintainer approval and does not run GitHub effects', async () => {
    const input = await fixture();
    const prepared = await preparePluginPublication({ ...input, publication }, { happyHomeDir: input.happyHomeDir });
    if (prepared.status !== 'prepared') throw new Error('Fixture archive was not prepared');
    const seen: RequestOptions[] = [];
    const result = await publishPluginPublication({ ...input, publication, access: 'public', mode: 'staged',
      expectedArchiveIntegrity: prepared.archiveIntegrity, github: { repository: { kind: 'github', deployment: 'https://github.com', repository: 'fixture/plugin' },
        release: { tagName: 'v1.1.0', targetCommitish: 'main', name: 'Release', body: 'Notes', prerelease: false, makeLatest: 'false' } } },
      { happyHomeDir: input.happyHomeDir, npmHttp: { lookup,
        request: npmHttpRequestBoundary({ responses: [npmHttpResponse({ stageId: 'fixture-stage' })], seen }) } });
    expect(result).toMatchObject({ status: 'awaiting_maintainer', stageId: 'fixture-stage' });
    expect(result).not.toHaveProperty('github');
    expect(seen.map(request => request.method)).toEqual(['POST']);
  });

  it('checks public bytes for explicit GitHub-only retry without another npm upload', async () => {
    const input = await fixture();
    const prepared = await preparePluginPublication({ ...input, publication }, { happyHomeDir: input.happyHomeDir });
    if (prepared.status !== 'prepared') throw new Error('Fixture archive was not prepared');
    const seen: RequestOptions[] = [];
    const bodies: (string | undefined)[] = [];
    const uploaded = await publishPluginPublication({ ...input, publication, access: 'public', mode: 'direct',
      expectedArchiveIntegrity: prepared.archiveIntegrity }, { happyHomeDir: input.happyHomeDir,
      npmHttp: { lookup, request: npmHttpRequestBoundary({ responses: [npmHttpResponse({ ok: true })], seen, bodies }) } });
    if (!('integrity' in uploaded)) throw new Error('Fixture upload has no integrity');
    const retried = await publishPluginPublication({ ...input, publication, access: 'public', mode: 'direct', githubOnly: true,
      expectedArchiveIntegrity: prepared.archiveIntegrity, github: { repository: { kind: 'github', deployment: 'https://github.com', repository: 'fixture/plugin' } } },
      { happyHomeDir: input.happyHomeDir, npmHttp: { lookup, request: npmHttpRequestBoundary({
        responses: [npmHttpResponse({ name: '@fixture/plugin', version: '1.1.0', dist: { integrity: uploaded.integrity } })], seen }) } });
    expect(retried).toMatchObject({ status: 'published', github: { status: 'failed', errorCode: 'github_admission_unavailable' } });
    expect(seen.map(request => request.method ?? 'GET')).toEqual(['PUT', 'GET']);
  });

  it('honors cancellation before any candidate or registry effect', async () => {
    const input = await fixture();
    const controller = new AbortController(); controller.abort();
    const seen: RequestOptions[] = [];
    const result = await publishPluginPublication({ ...input, access: 'public', mode: 'direct' }, {
      happyHomeDir: input.happyHomeDir, signal: controller.signal,
      npmHttp: { lookup, request: npmHttpRequestBoundary({ responses: [], seen }) },
    });
    expect(result).toMatchObject({ status: 'cancelled' });
    expect(seen).toHaveLength(0);
  });
});
