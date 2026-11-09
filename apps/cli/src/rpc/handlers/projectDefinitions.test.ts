import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { ProjectDefinitionInspectOutputSchema, ProjectSetupReadinessV1Schema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { ProjectNativeCommandIo } from '@/workspaces/projectSetup/projectNativeResolution';
import { inspectProjectSetup, reviewProjectSetupEffect, type ProjectSetupPreparationInput } from '@/workspaces/projectSetup/projectSetupPreparation';
import { createProjectSetupSuccessStore } from '@/workspaces/projectSetup/projectSetupSuccess';
import { createProjectDefinitionAction, registerProjectDefinitionHandlers } from './projectDefinitions';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { assertActionOutputContract } from '@/testkit/actionOutputContract';
import { logger } from '@/ui/logger';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function setup(nativeIo?: ProjectNativeCommandIo, reviewInput?: (root: string) => ProjectSetupPreparationInput,
  profileId = 'home-a', homeId = profileId) {
  const root = await mkdtemp(join(tmpdir(), 'happier-project-definition-rpc-'));
  roots.push(root);
  const workspace = { serverId: homeId, machineId: 'machine-a', workspaceId: 'workspace-a', rootPath: root };
  const handlers = new Map<string, (input: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
  const producer = createProjectDefinitionAction({
    serverId: profileId, machineId: workspace.machineId, workingDirectory: root,
    accessPolicy: { kind: 'restrictedRoots', roots: [root] },
    ...(nativeIo ? { nativeIo } : {}),
    ...(reviewInput ? { inspectSetup: async () => inspectProjectSetup(reviewInput(root)) } : {}),
  });
  const executor = createActionExecutor({ ...createCliActionDeps({ token: 'fixture-token', mode: 'plain', ctx: null,
    sessionId: 'project-definition-fixture', serverId: profileId, serverHttpBaseUrl: 'https://project-definition.example' }),
    projectDefinitionAction: producer });
  registerProjectDefinitionHandlers({
    rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
    machineId: workspace.machineId, actionExecutor: executor,
  });
  return { root, workspace, handlers, producer };
}

describe('project definition Actions through registered Machine RPC', () => {
  it('keeps all 6230 Script summaries compact and performs no native discovery for the author document', async () => {
    const resolveTool = vi.fn(async () => ({ executablePath: '/installed/pnpm', version: '10' }));
    const h = await setup({ resolveTool });
    const scripts = Object.fromEntries(Array.from({ length: 6230 }, (_, index) => [`check-${index}`, `echo ${index}`]));
    await writeFile(join(h.root, 'package.json'), JSON.stringify({ scripts }));
    const inspect = h.handlers.get('daemon.projects.inspect.v1')!;
    const compact = ProjectDefinitionInspectOutputSchema.parse(await inspect({ workspace: h.workspace, read: { kind: 'scripts' } }));
    // The Scripts list carries every found reference (name, package file), never a per-row
    // native resolution: an opened row asks for its own `detail`.
    expect(compact.detection.entries).toHaveLength(6230);
    expect(compact.importCandidates).toHaveLength(0);
    expect(resolveTool).not.toHaveBeenCalled();
    expect.soft(compact.tools?.length ?? 0).toBe(0);
    const listBytes = Buffer.byteLength(JSON.stringify(compact.detection.entries));
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(listBytes + 2048);
    const opened = ProjectDefinitionInspectOutputSchema.parse(await inspect({ workspace: h.workspace,
      read: { kind: 'detail', sources: [compact.detection.entries[42]!] } }));
    expect(opened.importCandidates).toMatchObject([{ source: { target: 'check-42' }, availability: 'available' }]);
    await mkdir(join(h.root, '.happier'));
    const bytes = '{"version":1,"future":{"retained":true}}';
    await writeFile(join(h.root, '.happier/project.json'), bytes);
    resolveTool.mockClear();
    const editor = ProjectDefinitionInspectOutputSchema.parse(await inspect({ workspace: h.workspace, read: { kind: 'editor' } }));
    expect(editor.definition.document).toMatchObject({ bytes, original: { future: { retained: true } } });
    expect.soft(editor.detection.entries.length).toBe(0);
    expect.soft(editor.importCandidates.length).toBe(0);
    expect.soft(editor.commands?.length ?? 0).toBe(0);
    expect.soft(resolveTool).not.toHaveBeenCalled();
    resolveTool.mockClear();
    const guidance = ProjectDefinitionInspectOutputSchema.parse(await inspect({ workspace: h.workspace, read: { kind: 'guidance' } }));
    expect(guidance.detectionSummary).toMatchObject({ total: 6230, scripts: 6230, services: 0,
      files: [{ file: 'package.json', total: 6230, scripts: 6230, services: 0 }] });
    expect(guidance.detection.entries.length).toBe(0);
    expect(guidance.importCandidates.length).toBe(0);
    expect(guidance.commands?.length ?? 0).toBe(0);
    expect(guidance.tools?.length ?? 0).toBe(0);
    expect(resolveTool).not.toHaveBeenCalled();
    expect(Buffer.byteLength(JSON.stringify(guidance))).toBeLessThan(1024);
  });
  it('resends no Scripts body for an unchanged checkout and a full one after a package.json change', async () => {
    const h = await setup({ resolveTool: async () => ({ executablePath: '/installed/npm', version: '10' }) });
    const scripts = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`check-${index}`, `echo ${index}`]));
    await writeFile(join(h.root, 'package.json'), JSON.stringify({ scripts }));
    const inspect = h.handlers.get('daemon.projects.inspect.v1')!;
    const first = ProjectDefinitionInspectOutputSchema.parse(await inspect({ workspace: h.workspace, read: { kind: 'scripts' } }));
    expect(first.detection.entries).toHaveLength(2000);
    const revisit = await inspect({ workspace: h.workspace, read: { kind: 'scripts' }, ifRevision: first.revision });
    expect(revisit).toEqual({ unchanged: true, revision: first.revision });
    expect(Buffer.byteLength(JSON.stringify(revisit))).toBeLessThan(128);
    await writeFile(join(h.root, 'package.json'), JSON.stringify({ scripts: { ...scripts, added: 'echo added' } }));
    const changed = ProjectDefinitionInspectOutputSchema.parse(await inspect({ workspace: h.workspace, read: { kind: 'scripts' }, ifRevision: first.revision }));
    expect(changed.detection.entries).toHaveLength(2001);
    expect(changed.revision).not.toBe(first.revision);
  });
  it('keeps explicit Create preselection complete and its document lossless for all 6230 native offers', async () => {
    const h = await setup({ resolveTool: async () => ({ executablePath: '/installed/npm', version: '10' }) });
    const scripts = Object.fromEntries(Array.from({ length: 6230 }, (_, index) => [`check-${index}`, `echo ${index}`]));
    await writeFile(join(h.root, 'package.json'), JSON.stringify({ scripts }));
    await mkdir(join(h.root, '.happier'));
    const bytes = '{"version":1,"future":{"retained":true}}';
    await writeFile(join(h.root, '.happier/project.json'), bytes);
    const created = ProjectDefinitionInspectOutputSchema.parse(await h.handlers.get('daemon.projects.inspect.v1')!({
      workspace: h.workspace, read: { kind: 'create' },
    }));
    expect(created.importCandidates).toHaveLength(6230);
    expect(created.importCandidates.every(candidate => candidate.preselected && candidate.invocation !== undefined)).toBe(true);
    expect(created.definition.document).toMatchObject({ bytes, original: { future: { retained: true } } });
  });
  it('keeps named Script availability compact and excludes all 6230 already-declared native offers', async () => {
    const resolveTool = vi.fn(async () => ({ executablePath: '/installed/npm', version: '10' }));
    const h = await setup({ resolveTool });
    const scripts = Object.fromEntries(Array.from({ length: 6230 }, (_, index) => [`check-${index}`, `echo ${index}`]));
    await writeFile(join(h.root, 'package.json'), JSON.stringify({ scripts }));
    await mkdir(join(h.root, '.happier'));
    await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ version: 1,
      scripts: Object.fromEntries(Object.keys(scripts).map(name => [name, {
        source: { target: name, file: 'package.json', tool: 'package_script', kind: 'native' },
      }])) }));
    const declared = ProjectDefinitionInspectOutputSchema.parse(await h.handlers.get('daemon.projects.inspect.v1')!({
      workspace: h.workspace, read: { kind: 'scripts' },
    }));
    expect(declared.importCandidates).toHaveLength(0);
    expect(declared.detection.entries).toHaveLength(0);
    expect(declared.detectionSummary).toMatchObject({ total: 0, scripts: 0, services: 0, files: [] });
    expect(declared.commands).toHaveLength(6230);
    expect(declared.commands?.every(command => command.availability === 'available' && command.invocation === undefined)).toBe(true);
    expect(resolveTool).toHaveBeenCalledTimes(1);
  });
  it('reads only selected native details without sending a 6230-declaration manifest and observes the next source change', async () => {
    const resolveTool = vi.fn(async (tool: string) => ({ executablePath: `/installed/${tool}`, version: '1' }));
    const h = await setup({ resolveTool });
    await mkdir(join(h.root, '.happier'));
    const native = { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } as const;
    await writeFile(join(h.root, 'Makefile'), 'check:\n\techo current\n');
    await writeFile(join(h.root, 'justfile'), 'other:\n  echo unrelated\n');
    await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ version: 1,
      scripts: Object.fromEntries(Array.from({ length: 6230 }, (_, index) => [`declaration-${index}`, { source: native }])) }));
    const inspect = h.handlers.get('daemon.projects.inspect.v1')!;
    const request = { workspace: h.workspace, read: { kind: 'detail', sources: [{ source: native, usage: 'script' }] } };
    const detail = ProjectDefinitionInspectOutputSchema.parse(await inspect(request));
    expect(detail).toMatchObject({ definitionScope: 'statusOnly', definition: { document: { manifest: { version: 1 } } },
      importCandidates: [{ source: native, availability: 'available', invocation: { tool: 'make', args: ['-f', 'Makefile', 'check'] } }] });
    expect(detail.definition.document?.status === 'valid' && detail.definition.document.manifest.scripts).toBeUndefined();
    expect(detail.importCandidates).toHaveLength(1);
    expect(detail.commands?.length ?? 0).toBe(0);
    expect(resolveTool.mock.calls.map(([tool]) => tool)).toEqual(['make']);
    expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThan(2048);
    await writeFile(join(h.root, 'Makefile'), 'changed:\n\techo fresh\n');
    expect(ProjectDefinitionInspectOutputSchema.parse(await inspect(request))).toMatchObject({
      importCandidates: [{ source: native, availability: 'unavailable', code: 'native_target_missing' }],
    });
  });
  it('rejects service-only native detail requests with finite usage at input admission', async () => {
    const h = await setup({ resolveTool: async tool => ({ executablePath: `/installed/${tool}` }) });
    await writeFile(join(h.root, 'Procfile'), 'web: echo service\n');
    const inspect = h.handlers.get('daemon.projects.inspect.v1')!;
    expect(await inspect({ workspace: h.workspace, read: { kind: 'detail', sources: [{
      source: { kind: 'native', tool: 'procfile', file: 'Procfile', target: 'web' }, usage: 'script',
    }] } })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });
  it('separates all-usage import offers and toolchain facts from authoring and setup-readiness demand', async () => {
    let readinessReads = 0;
    const resolveTool = vi.fn(async (tool: string) => ({ executablePath: `/installed/${tool}`, version: '1' }));
    const h = await setup({ resolveTool }, root => {
      readinessReads++;
      const workspace = { id: 'workspace-a', serverId: 'home-a', machineId: 'machine-a', rootPath: root, projectKey: 'project', createdAtMs: 1 };
      return { workspace, projectAssociation: { workspace, project: { serverId: 'home-a', projectId: 'project' } },
        requester: { credentials: { token: 'fixture-requester', encryption: null }, serverHttpBaseUrl: 'https://requester.example' },
        purpose: 'setup', platform: { os: process.platform, arch: process.arch }, nativeIo: { resolveTool }, successHomeDir: root };
    });
    await writeFile(join(h.root, 'package.json'), JSON.stringify({ scripts: { check: 'echo checked', dev: 'node server.js' } }));
    await writeFile(join(h.root, 'Procfile'), 'web: node server.js\n');
    await writeFile(join(h.root, 'mise.toml'), '[tools]\nnode="1"\n');
    const inspect = h.handlers.get('daemon.projects.inspect.v1')!;
    const imports = ProjectDefinitionInspectOutputSchema.parse(await inspect({ workspace: h.workspace, read: { kind: 'imports' } }));
    expect(imports.importCandidates.some(candidate => candidate.usage === 'script')).toBe(true);
    expect(imports.importCandidates.some(candidate => candidate.usage === 'service')).toBe(true);
    expect(imports.importCandidates.every(candidate => candidate.invocation === undefined)).toBe(true);
    expect(imports.detection.toolchains).toEqual([]);
    expect(imports.tools ?? []).toEqual([]);
    resolveTool.mockClear();
    const tools = ProjectDefinitionInspectOutputSchema.parse(await inspect({ workspace: h.workspace, read: { kind: 'tools' } }));
    expect(tools.tools).toEqual(expect.arrayContaining([
      { tool: 'node', file: 'mise.toml', requestedVersion: '1', availability: 'available', version: '1' },
      { tool: 'npm', file: 'package.json', availability: 'available', version: '1' },
    ]));
    expect(tools.detection.toolchains).toEqual(expect.arrayContaining([{ kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' }]));
    expect(tools.importCandidates).toHaveLength(0);
    expect(tools.detection.entries).toHaveLength(0);
    expect(tools.commands?.length ?? 0).toBe(0);
    expect(resolveTool.mock.calls.map(([tool]) => tool)).toContain('npm');
    for (const read of [{ kind: 'editor' }, { kind: 'create' }, { kind: 'detail', sources: [] }, { kind: 'guidance' }] as const) {
      await inspect({ workspace: h.workspace, read });
    }
    expect(readinessReads).toBe(0);
    await inspect({ workspace: h.workspace, read: { kind: 'scripts' } });
    expect(readinessReads).toBe(1);
    await mkdir(join(h.root, '.happier'));
    await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ version: 1,
      services: { existing: { source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'check' } },
        worker: { source: { kind: 'native', tool: 'procfile', file: 'Procfile', target: 'web' } } },
      workspace: { setup: [{ target: 'dev', file: 'package.json', tool: 'package_script', kind: 'native' }] } }));
    const declaredElsewhere = ProjectDefinitionInspectOutputSchema.parse(await inspect({ workspace: h.workspace, read: { kind: 'scripts' } }));
    expect(declaredElsewhere.detection.entries).toHaveLength(0);
    expect(declaredElsewhere.importCandidates).toHaveLength(0);
    expect(declaredElsewhere.detectionSummary).toMatchObject({ total: 0, scripts: 0, services: 0 });
  });
  it('keeps unrelated declared Services out of compact Scripts reads while preserving their own consumers', async () => {
    const h = await setup();
    const services = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`worker-${index}`,
      { source: { kind: 'command', command: `echo ${'service-body'.repeat(128)}` } }]));
    const manifest = { version: 1, toolchain: { kind: 'host' },
      environmentVariables: [{ name: 'MODE', kind: 'config', required: true }],
      workspace: { setup: [{ kind: 'command', command: 'echo configure' }] },
      scripts: { verify: { execution: 'portable', source: { kind: 'command', command: 'echo checked' } } }, services };
    const bytes = JSON.stringify(manifest);
    await mkdir(join(h.root, '.happier'));
    await writeFile(join(h.root, '.happier/project.json'), bytes);
    const inspect = h.handlers.get('daemon.projects.inspect.v1')!;
    for (const kind of ['overview', 'rail'] as const) {
      const result = ProjectDefinitionInspectOutputSchema.parse(await inspect({
        workspace: h.workspace, read: { kind, detectedRows: 3 },
      }));
      expect(result.definition.document).toMatchObject({ status: 'valid', manifest: {
        scripts: manifest.scripts, workspace: manifest.workspace,
        toolchain: manifest.toolchain, environmentVariables: manifest.environmentVariables,
      } });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4096);
      expect(result.definition.document?.status === 'valid' && result.definition.document.manifest.services).toBeUndefined();
    }
    for (const read of [{ kind: 'services' }, { kind: 'scripts' }, { kind: 'editor' },
      { kind: 'execution', command: { usage: 'script', name: 'verify' } }] as const) {
      const result = ProjectDefinitionInspectOutputSchema.parse(await inspect({ workspace: h.workspace, read }));
      expect(result.definition.document).toMatchObject({ status: 'valid', manifest: { services } });
      if (read.kind === 'editor') expect(result.definition.document).toMatchObject({ bytes });
    }
  });
  it('keeps Overview file metadata proportional to displayed groups and distinct file names', async () => {
    const h = await setup({ resolveTool: async () => ({ executablePath: '/installed/npm' }) });
    for (let index = 0; index < 64; index++) {
      const path = join(h.root, `packages/package-${index}`);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'package.json'), JSON.stringify({ scripts: { check: 'echo checked' } }));
    }
    const output = ProjectDefinitionInspectOutputSchema.parse(await h.handlers.get('daemon.projects.inspect.v1')!({
      workspace: h.workspace, read: { kind: 'overview', detectedRows: 3 },
    }));
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(4096);
    expect(output.detectionSummary?.total).toBe(64);
    expect(output.detectionSummary?.files).toHaveLength(3);
    expect(output.detectionSummary?.sourceFiles).toEqual(['package.json']);
    expect(output.detection.entries).toHaveLength(3);
    expect(output.importCandidates.every(candidate => candidate.availability === 'ambiguous')).toBe(true);
    expect(output.importCandidates.every(candidate => !candidate.preselected)).toBe(true);
  });
  it('returns only the presented Overview rows at scale while keeping counts, fresh invocations and editor text', async () => {
    const h = await setup({ resolveTool: async () => ({ executablePath: '/installed/pnpm', version: '10' }) });
    const scripts = Object.fromEntries(Array.from({ length: 1024 }, (_, index) => [`check-${index}`, `echo ${index}`]));
    await writeFile(join(h.root, 'package.json'), JSON.stringify({ scripts }));
    const inspect = h.handlers.get('daemon.projects.inspect.v1')!;
    const input = { workspace: h.workspace, read: { kind: 'overview', detectedRows: 3 } };
    const result = ProjectDefinitionInspectOutputSchema.parse(await inspect(input));
    expect(result.detection.entries).toHaveLength(3);
    expect(result.importCandidates).toHaveLength(3);
    expect(result.detectionSummary).toMatchObject({ total: 1024, scripts: 1024,
      files: [{ file: 'package.json', total: 1024, scripts: 1024 }] });
    // A frame's read must not grow with the unseen inventory. The bound is the full
    // three-row projection plus its single file count, not a production payload cap.
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4096);
    await writeFile(join(h.root, 'package.json'), JSON.stringify({ scripts: { refreshed: 'echo changed' } }));
    expect(ProjectDefinitionInspectOutputSchema.parse(await inspect(input))).toMatchObject({
      detection: { entries: [{ source: { target: 'refreshed' } }] }, detectionSummary: { total: 1 },
      importCandidates: [{ invocation: { args: ['run', 'refreshed'] } }],
    });
    await mkdir(join(h.root, '.happier'));
    const bytes = JSON.stringify({ version: 1, future: { text: 'preserve me' }, scripts: {
      declared: { source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'refreshed' } },
    } });
    await writeFile(join(h.root, '.happier/project.json'), bytes);
    const declared = ProjectDefinitionInspectOutputSchema.parse(await inspect(input));
    expect(declared.detection.entries).toHaveLength(0);
    expect(declared.importCandidates).toHaveLength(0);
    expect(declared.commands).toMatchObject([{ name: 'declared', invocation: { args: ['run', 'refreshed'] } }]);
    expect(declared.definition.document).not.toHaveProperty('bytes');
    expect(declared.definition.document).not.toHaveProperty('original');
    const editor = ProjectDefinitionInspectOutputSchema.parse(await inspect({ workspace: h.workspace, read: { kind: 'editor' } }));
    expect(editor.definition.document).toMatchObject({ bytes, original: { future: { text: 'preserve me' } } });
  });
  it.each(['projects.inspect', 'projects.manifest.update'] as const)('emits the registered %s contract from real files with unicode, long commands and unknown author fields', async actionId => {
    const h = await setup({ resolveTool: async tool => tool === 'make' ? { executablePath: '/installed/make' } : null });
    await writeFile(join(h.root, 'Makefile'), 'check:\n\techo 世界\n');
    await writeFile(join(h.root, 'package.json'), JSON.stringify({ scripts: {
      'test:世界': `echo ${'🚀'.repeat(800)}`, dev: 'node server.js --host=0.0.0.0',
    } }));
    const bytes = JSON.stringify({ version: 1, futureAuthorField: { label: '界🚀' }, scripts: {
      'verify:世界': { source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } },
    } });
    if (actionId === 'projects.inspect') {
      await mkdir(join(h.root, '.happier'));
      await writeFile(join(h.root, '.happier/project.json'), bytes);
    }
    const input = actionId === 'projects.inspect' ? { workspace: h.workspace }
      : { workspace: h.workspace, expectedBasis: { kind: 'absent' as const }, bytes };
    // Inspect the producer before terminal Action validation can hide a malformed payload.
    const output = await h.producer({ actionId, input, context: { serverId: h.workspace.serverId } });
    assertActionOutputContract(actionId, output);
    expect(output).toMatchObject(actionId === 'projects.inspect'
      ? { detection: { entries: expect.any(Array) }, commands: [{ name: 'verify:世界' }] }
      : { status: 'saved' });
    const rpcOutput = await h.handlers.get(actionId === 'projects.inspect'
      ? 'daemon.projects.inspect.v1' : 'daemon.projects.manifest.update.v1')!(input);
    assertActionOutputContract(actionId, rpcOutput);
    expect(rpcOutput).toMatchObject(actionId === 'projects.inspect' ? { definition: { document: { status: 'valid' } } }
      : { status: 'conflict' });
  });
  it('admits portable Home definition inspection and mutation without widening filesystem access or lost bindings', async () => {
    const home = await mkdtemp(join(tmpdir(), 'definition-portable-home-')); roots.push(home);
    const scope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
    const profileId = 'definition-local-profile'; const homeId = 'srv_definitionHome';
    try {
      scope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: profileId }); reloadConfiguration();
      const url = 'https://project-definition.example';
      const profile = { id: profileId, name: 'Definition', serverUrl: url, webappUrl: url, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
        homeConnectionDescriptorAuthority: 'exact' as const, homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1,
          homeServerIdentityId: homeId, canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }) };
      await updateSettings(settings => ({ ...settings, activeServerId: profileId, servers: { [profileId]: profile } }));
      const h = await setup(undefined, undefined, profileId, homeId);
      const inspect = h.handlers.get('daemon.projects.inspect.v1')!;
      expect(await inspect({ workspace: h.workspace })).toMatchObject({ definition: { basis: { kind: 'absent' } } });
      expect(await inspect({ workspace: { ...h.workspace, rootPath: home } })).toMatchObject({ ok: false, errorCode: 'access_denied' });
      expect(await h.handlers.get('daemon.projects.manifest.update.v1')!({ workspace: h.workspace, expectedBasis: { kind: 'absent' },
        bytes: '{"version":1}' })).toMatchObject({ status: 'saved' });
      for (const scenario of ['wrong', 'ambiguous', 'retired'] as const) {
        await updateSettings(settings => {
          const servers: NonNullable<typeof settings.servers> = scenario === 'ambiguous'
            ? { [profileId]: profile, duplicate: { ...profile, id: 'duplicate' } } : scenario === 'retired' ? {} : { [profileId]: profile };
          return { ...settings, servers };
        });
        expect(await inspect({ workspace: { ...h.workspace, serverId: scenario === 'wrong' ? 'wrong-home' : homeId } }))
          .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
      }
    } finally { scope.restore(); reloadConfiguration(); }
  });
  it('reports current readiness as unknown when captured requester review inputs are unavailable', async () => {
    const { workspace, handlers } = await setup();
    expect(await handlers.get('daemon.projects.inspect.v1')!({ workspace })).toMatchObject({
      setupReadiness: { kind: 'unknown', code: 'project_setup_requester_review_unavailable' },
    });
  });
  it.each([['missing', 'ENOENT'], ['malformed', 'project_setup_inspection_failed']] as const)(
    'preserves a failed filesystem review reason (%s) and logs it without disclosing the error payload', async (kind, code) => {
    const { root, workspace } = await setup();
    const file = join(root, 'private-review-unavailable');
    if (kind === 'malformed') await writeFile(file, '{private-content');
    const diagnostic = vi.spyOn(logger, 'debug');
    try {
      const action = createProjectDefinitionAction({ serverId: workspace.serverId, machineId: workspace.machineId,
        workingDirectory: root, accessPolicy: { kind: 'restrictedRoots', roots: [root] },
        // The private review adapter's filesystem is the failing system boundary.
        inspectSetup: async () => ({ setupReadiness: ProjectSetupReadinessV1Schema.parse(JSON.parse(await readFile(file, 'utf8'))) }) });
      const executor = createActionExecutor({ ...createCliActionDeps({ token: 'fixture-token', mode: 'plain', ctx: null,
        sessionId: 'project-definition-fixture', serverId: workspace.serverId, serverHttpBaseUrl: 'https://project-definition.example' }), projectDefinitionAction: action });
      const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
      registerProjectDefinitionHandlers({ machineId: workspace.machineId, actionExecutor: executor,
        rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } } });
      const result = ProjectDefinitionInspectOutputSchema.parse(await handlers.get('daemon.projects.inspect.v1')!({ workspace }));
      expect(result.setupReadiness).toEqual({ kind: 'unknown', code });
      expect(diagnostic.mock.calls).toContainEqual(['[ProjectSetup] inspection failed', { code }]);
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-review-unavailable');
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-content');
    } finally { diagnostic.mockRestore(); }
  });
  it('projects reviewed target-local completion through inspect without evaluating setup or disclosing its basis', async () => {
    const reviewInput = (root: string): ProjectSetupPreparationInput => {
      const workspace = { id: 'workspace-a', serverId: 'home-a', machineId: 'machine-a', rootPath: root, projectKey: 'project', createdAtMs: 1 };
      return { workspace, projectAssociation: { workspace, project: { serverId: 'home-a', projectId: 'project' } },
        requester: { credentials: { token: 'fixture-requester', encryption: null }, serverHttpBaseUrl: 'https://requester.example' },
        purpose: 'setup', platform: { os: process.platform, arch: process.arch }, nativeIo: { resolveTool: async () => ({ executablePath: '/managed/make', version: '1' }) }, successHomeDir: root,
        configEnvironment: { MODE: 'development', PRIVATE: 'must-not-leak' } };
    };
    const { root, workspace, handlers } = await setup(undefined, reviewInput);
    await mkdir(join(root, '.happier'));
    await writeFile(join(root, 'Makefile'), 'bootstrap:\n\ttouch must-not-execute\n');
    await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1,
      environmentVariables: [{ name: 'MODE', kind: 'config', required: true }], workspace: { setup: [
        { kind: 'command', command: 'touch must-not-execute' },
        { kind: 'native', tool: 'make', file: 'Makefile', target: 'bootstrap' },
      ] } }));
    const inspect = handlers.get('daemon.projects.inspect.v1')!;
    expect(await inspect({ workspace })).toMatchObject({ setupReadiness: { kind: 'unprepared' } });
    const reviewed = await reviewProjectSetupEffect(reviewInput(root));
    if (reviewed.kind !== 'reviewed') throw new Error(reviewed.code);
    await createProjectSetupSuccessStore({ homeDir: root }).recordCompletion({ serverId: workspace.serverId, machineId: workspace.machineId, workspaceRefId: workspace.workspaceId },
      { v: 1, workspaceRefId: workspace.workspaceId, completedAtMs: 123, ...reviewed.plan.successBasis });
    const result = ProjectDefinitionInspectOutputSchema.parse(await inspect({ workspace, read: { kind: 'setup' } }));
    expect(result).toMatchObject({ setupReadiness: { kind: 'current', completedAtMs: 123, reviewedEffectDigest: reviewed.plan.reviewedEffectDigest } });
    expect(result.setupReview).toMatchObject({ reviewedEffectDigest: reviewed.plan.reviewedEffectDigest, reviewedEffect: {
      commands: [{ kind: 'command', command: 'touch must-not-execute' }, { source: { tool: 'make', target: 'bootstrap' } }],
      configEnvironment: { MODE: 'development' },
    } });
    expect(JSON.stringify(result.setupReview)).not.toContain('must-not-leak');
    expect(JSON.stringify(result)).not.toContain('environmentBindingReferences');
    await expect(readFile(join(root, 'must-not-execute'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1, workspace: { setup: [{ kind: 'command', command: 'touch changed' }] } }));
    expect(await inspect({ workspace })).toMatchObject({ setupReadiness: { kind: 'unprepared' } });
  });
  it('projects canonical runner argv and actual installed tool facts without copying scripts or presenting requested versions as installed', async () => {
    // Installed-tool lookup is an OS boundary; native parsing/resolution and DTO validation stay real.
    const { root, workspace, handlers } = await setup({ resolveTool: async tool => tool === 'yarn'
      ? { executablePath: join(tmpdir(), 'node'), args: [join(tmpdir(), 'installed-yarn.cjs')], version: '4.6.0' }
      : tool === 'node' ? { executablePath: join(tmpdir(), 'node'), version: '22.19.0' } : null });
    await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.6.0', scripts: { test: 'touch must-not-execute' } }));
    await writeFile(join(root, 'mise.toml'), '[tools]\nnode="24"\nyarn="4.6.0"\nprotoc="29"\n');
    await mkdir(join(root, '.happier'));
    await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1, scripts: {
      verify: { source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'test' } },
    } }));
    const result = await handlers.get('daemon.projects.inspect.v1')!({ workspace, read: { kind: 'create' } });
    expect(result).toMatchObject({
      importCandidates: [{ invocation: { tool: 'yarn', args: ['run', 'test'], cwd: root }, availability: 'available' }],
      commands: [{ name: 'verify', usage: 'script', availability: 'available', invocation: { tool: 'yarn', args: ['run', 'test'], cwd: root } }],
      tools: expect.arrayContaining([
        { tool: 'node', file: 'mise.toml', requestedVersion: '24', availability: 'available', version: '22.19.0' },
        { tool: 'protoc', file: 'mise.toml', requestedVersion: '29', availability: 'unavailable' },
        { tool: 'yarn', file: 'package.json', requestedVersion: '4.6.0', availability: 'available', version: '4.6.0' },
      ]),
    });
    expect(ProjectDefinitionInspectOutputSchema.safeParse(result).success).toBe(true);
    await expect(readFile(join(root, 'must-not-execute'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: 'yarn@99.0.0', scripts: { test: 'touch must-not-execute' } }));
    expect(await handlers.get('daemon.projects.inspect.v1')!({ workspace, read: { kind: 'create' } })).toMatchObject({
      commands: [{ availability: 'unavailable', code: 'native_tool_version_mismatch', invocation: { tool: 'yarn', args: ['run', 'test'] } }],
      tools: expect.arrayContaining([{ tool: 'yarn', file: 'package.json', requestedVersion: '99.0.0', availability: 'available', version: '4.6.0' }]),
    });
  });
  it('preselects only passively proven installed native imports, without running the checkout', async () => {
    // The injected port is the OS tool lookup boundary, not native resolution logic.
    const { root, workspace, handlers } = await setup({ resolveTool: async tool => tool === 'make' ? { executablePath: join(tmpdir(), 'installed-make') } : null });
    await writeFile(join(root, 'Makefile'), 'check:\n\techo must-not-run\n');
    await writeFile(join(root, 'justfile'), 'other:\n  echo must-not-run\n');
    expect(await handlers.get('daemon.projects.inspect.v1')!({ workspace, read: { kind: 'imports' } })).toMatchObject({ importCandidates: [
      { source: { tool: 'make', target: 'check' }, availability: 'available', preselected: true },
      { source: { tool: 'just', target: 'other' }, availability: 'unavailable', preselected: false },
    ] });
  });
  it('publishes selected command and environment execution inputs before tool availability without freezing ordinary data', async () => {
    // Installed lookup is the OS boundary; selected-file resolution and strict
    // public Action output validation remain the real production owners.
    const { root, workspace, handlers } = await setup({ resolveTool: async () => null });
    const make = 'check:\n\ttouch must-not-execute\n';
    const environment = '[tools]\nnode="22"\n';
    await writeFile(join(root, 'Makefile'), make);
    await writeFile(join(root, 'mise.toml'), environment);
    await writeFile(join(root, 'input.txt'), 'ordinary input');
    await mkdir(join(root, '.happier'));
    await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1,
      toolchain: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' },
      scripts: { verify: { execution: 'portable', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } },
    }));
    const inspect = handlers.get('daemon.projects.inspect.v1')!;
    const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
    const request = { workspace, read: { kind: 'execution', command: { usage: 'script', name: 'verify' } } };
    const initial = await inspect(request);
    expect(initial).toEqual(expect.objectContaining({ commands: [expect.objectContaining({ name: 'verify', usage: 'script', availability: 'unavailable',
      executionInputs: [{ file: 'Makefile', hash: hash(make) }] })],
      toolchainExecutionInputs: [{ file: 'mise.toml', hash: hash(environment) }],
    }));
    expect(ProjectDefinitionInspectOutputSchema.safeParse(initial).success).toBe(true);
    await writeFile(join(root, 'input.txt'), 'fresh ordinary input');
    expect(await inspect(request)).toEqual(initial);
    const changed = 'check:\n\ttouch changed-must-not-execute\n';
    await writeFile(join(root, 'Makefile'), changed);
    expect(await inspect(request)).toMatchObject({ commands: [{ executionInputs: [{ file: 'Makefile', hash: hash(changed) }] }],
      toolchainExecutionInputs: [{ file: 'mise.toml', hash: hash(environment) }],
    });
    await expect(readFile(join(root, 'must-not-execute'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(root, 'changed-must-not-execute'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('includes only contained selected toolchain executable bytes in the passive environment basis', async () => {
    let executablePath: string | undefined;
    const { root, workspace, handlers } = await setup({ resolveTool: async tool => tool === 'mise' && executablePath
      ? { executablePath, version: '1' } : null });
    executablePath = join(root, 'project-mise');
    const config = '[env]\nMODE="selected"\n';
    await writeFile(join(root, 'mise.toml'), config);
    await writeFile(executablePath, 'original selected executable');
    await mkdir(join(root, '.happier'));
    await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1,
      toolchain: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' },
      scripts: { verify: { execution: 'portable', source: { kind: 'command', command: 'echo checked' } } },
    }));
    const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
    const inspect = handlers.get('daemon.projects.inspect.v1')!;
    const request = { workspace, read: { kind: 'execution', command: { usage: 'script', name: 'verify' } } };
    expect(await inspect(request)).toEqual(expect.objectContaining({ toolchainExecutionInputs: [
      { file: 'mise.toml', hash: hash(config) }, { file: 'project-mise', hash: hash('original selected executable') },
    ] }));
    await writeFile(executablePath, 'changed selected executable');
    expect(await inspect(request)).toMatchObject({ toolchainExecutionInputs: [
      { file: 'mise.toml', hash: hash(config) }, { file: 'project-mise', hash: hash('changed selected executable') },
    ] });
    executablePath = join(tmpdir(), 'system-mise');
    expect(await inspect(request)).toMatchObject({ toolchainExecutionInputs: [{ file: 'mise.toml', hash: hash(config) }] });
  });
  it('inspects native references and preserves exact raw bytes while refusing a stale or absent basis', async () => {
    const { root, workspace, handlers } = await setup();
    await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.0.0', scripts: { check: 'echo must-not-run' } }));
    const inspect = handlers.get('daemon.projects.inspect.v1')!;
    const update = handlers.get('daemon.projects.manifest.update.v1')!;
    expect(inspect).toBeTypeOf('function');
    expect(update).toBeTypeOf('function');
    expect(await inspect({ workspace })).toMatchObject({ definition: { basis: { kind: 'absent' }, document: null },
      detection: { entries: [{ source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'check' } }] } });
    const bytes = '{\n  "version": 1,\n  "unknown": {"retained": true},\n  "scripts": {"check":{"source":{"kind":"native","tool":"package_script","file":"package.json","target":"check"},"extra":7}}\n}\n';
    const saved = await update({ workspace, expectedBasis: { kind: 'absent' }, bytes });
    expect(saved).toMatchObject({ status: 'saved', basis: { kind: 'present' }, document: { status: 'valid' } });
    expect(await readFile(join(root, '.happier/project.json'), 'utf8')).toBe(bytes);
    const snapshot = ProjectDefinitionInspectOutputSchema.parse(await inspect({ workspace }));
    const external = '{"version":1,"external":true}\n';
    await writeFile(join(root, '.happier/project.json'), external);
    expect(await update({ workspace, expectedBasis: snapshot.definition.basis, bytes: '{"version":1}' }))
      .toMatchObject({ status: 'conflict', current: { document: { bytes: external } } });
    expect(await update({ workspace, expectedBasis: { kind: 'absent' }, bytes: '{"version":1}' })).toMatchObject({ status: 'conflict' });
    expect(await readFile(join(root, '.happier/project.json'), 'utf8')).toBe(external);
  });

  it('refuses mismatched Home, Machine, unauthorized roots and unknown request authority fields before filesystem mutation', async () => {
    const { root, workspace, handlers } = await setup();
    const update = handlers.get('daemon.projects.manifest.update.v1')!;
    for (const changed of [{ serverId: 'home-b' }, { machineId: 'machine-b' }, { rootPath: tmpdir() }]) {
      expect(await update({ workspace: { ...workspace, ...changed }, expectedBasis: { kind: 'absent' }, bytes: '{"version":1}' }))
        .toMatchObject({ ok: false });
    }
    expect(await update({ workspace, expectedBasis: { kind: 'absent' }, bytes: '{"version":1}', bypassApprovals: true }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    await expect(readFile(join(root, '.happier/project.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an escaped manifest symlink through the same contained writer', async () => {
    const { root, workspace, handlers } = await setup();
    const outside = await mkdtemp(join(tmpdir(), 'happier-project-definition-outside-'));
    roots.push(outside);
    await mkdir(join(root, '.happier'));
    const { symlink } = await import('node:fs/promises');
    await symlink(join(outside, 'project.json'), join(root, '.happier', 'project.json'));
    expect(await handlers.get('daemon.projects.manifest.update.v1')!({ workspace, expectedBasis: { kind: 'absent' }, bytes: '{"version":1}' }))
      .toMatchObject({ status: 'refused', code: 'access_denied' });
    await expect(readFile(join(outside, 'project.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the configurable agent approval default ahead of the real writer', async () => {
    const { root, workspace, handlers } = await setup();
    const signal = new AbortController().signal;
    expect(await handlers.get('daemon.projects.manifest.update.v1')!({ workspace, expectedBasis: { kind: 'absent' }, bytes: '{"version":1}' }, {
      signal, localActionContext: { surface: 'agent', authority: 'account_automation' },
    })).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    await expect(readFile(join(root, '.happier/project.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
