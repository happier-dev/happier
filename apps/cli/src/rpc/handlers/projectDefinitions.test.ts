import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { ProjectNativeCommandIo } from '@/workspaces/projectSetup/projectNativeResolution';
import { createProjectDefinitionAction, registerProjectDefinitionHandlers } from './projectDefinitions';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function setup(nativeIo?: ProjectNativeCommandIo) {
  const root = await mkdtemp(join(tmpdir(), 'happier-project-definition-rpc-'));
  roots.push(root);
  const workspace = { serverId: 'home-a', machineId: 'machine-a', workspaceId: 'workspace-a', rootPath: root };
  const handlers = new Map<string, (input: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
  const executor = createActionExecutor({ ...createCliActionDeps({ token: 'fixture-token', mode: 'plain', ctx: null,
    sessionId: 'project-definition-fixture', serverId: workspace.serverId, serverHttpBaseUrl: 'https://project-definition.example' }),
    projectDefinitionAction: createProjectDefinitionAction({
    serverId: workspace.serverId, machineId: workspace.machineId, workingDirectory: root,
    accessPolicy: { kind: 'restrictedRoots', roots: [root] },
    ...(nativeIo ? { nativeIo } : {}),
  }) });
  registerProjectDefinitionHandlers({
    rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
    machineId: workspace.machineId, actionExecutor: executor,
  });
  return { root, workspace, handlers };
}

describe('project definition Actions through registered Machine RPC', () => {
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
    const result = await handlers.get('daemon.projects.inspect.v1')!({ workspace });
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
    expect(await handlers.get('daemon.projects.inspect.v1')!({ workspace })).toMatchObject({
      commands: [{ availability: 'unavailable', code: 'native_tool_version_mismatch', invocation: { tool: 'yarn', args: ['run', 'test'] } }],
      tools: expect.arrayContaining([{ tool: 'yarn', file: 'package.json', requestedVersion: '99.0.0', availability: 'available', version: '4.6.0' }]),
    });
  });
  it('preselects only passively proven installed native imports, without running the checkout', async () => {
    // The injected port is the OS tool lookup boundary, not native resolution logic.
    const { root, workspace, handlers } = await setup({ resolveTool: async tool => tool === 'make' ? { executablePath: join(tmpdir(), 'installed-make') } : null });
    await writeFile(join(root, 'Makefile'), 'check:\n\techo must-not-run\n');
    await writeFile(join(root, 'justfile'), 'other:\n  echo must-not-run\n');
    expect(await handlers.get('daemon.projects.inspect.v1')!({ workspace })).toMatchObject({ importCandidates: [
      { source: { tool: 'make', target: 'check' }, availability: 'available', preselected: true },
      { source: { tool: 'just', target: 'other' }, availability: 'unavailable', preselected: false },
    ] });
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
