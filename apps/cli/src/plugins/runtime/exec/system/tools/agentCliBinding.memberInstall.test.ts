import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { resolveAgentCliManagedCommandPathForRuntime, type AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import { createRetainedAgentCliSystemToolService } from './agentCliBinding';
import { resolveMemberAgentInstallCli } from '@/capabilities/installJobs/memberResolveEffect';
import { buildMemberAgentInstallEnvironment } from '@/capabilities/installJobs/memberInstallEnvironment';

test('retained native member launch grants preserve the canonical selection without daemon filesystem access', async () => {
  const spec = { source: 'system' as const, resolvedPath: '/private-member-home/.local/bin/fixture',
    command: '/public-runtime/node', args: ['/private-member-home/.local/bin/fixture'], providerExitOwnership: 'direct' as const };
  const service = createRetainedAgentCliSystemToolService({ agentId: 'fixture', binding: { toolId: 'fixture-cli' },
    definition: { toolId: 'fixture-cli', displayName: 'Fixture', lookupNames: ['fixture'] }, launch: spec,
    delegate: { async resolve() { throw new Error('No alternate executable resolution'); } } });
  await expect(service.resolve({ toolId: 'fixture-cli', purpose: 'Run Fixture', preferredPath: '/owner/override' }))
    .resolves.toMatchObject({ executablePath: spec.resolvedPath,
      launch: { executablePath: spec.command, args: spec.args }, providerExitOwnership: 'direct' });
});

test('retained native grants preserve the system-tool runtime refusal', async () => {
  const service = createRetainedAgentCliSystemToolService({ agentId: 'fixture', binding: { toolId: 'fixture-cli' },
    definition: { toolId: 'fixture-cli', displayName: 'Fixture', lookupNames: ['fixture'] },
    launch: { source: 'system', resolvedPath: '/private-member-home/bin/node', command: '/private-member-home/bin/node', args: [] },
    delegate: { async resolve() { throw new Error('No alternate executable resolution'); } } });
  await expect(service.resolve({ toolId: 'fixture-cli', purpose: 'Run Fixture' }))
    .rejects.toMatchObject({ code: 'plugin_exec_system_tool_denied' });
});

test.skipIf(process.platform !== 'linux')('member resolution prefers its own vendor and managed installations and retains shared managed code as fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-member-install-resolution-'));
  const owner = join(root, 'owner'); const home = join(root, 'member');
  const spec: AgentCliRuntimeDescriptor = { id: 'fixture-member', title: 'Member Agent', binaryName: 'fixture-member',
    knownUserBinDirSuffixes: ['.local/bin'], sourcePreferenceDefault: 'managed-first',
    manualInstallKind: 'none', manualInstallRecipes: null, acceptsJavaScriptFileOverride: false,
    managedInstall: { kind: 'github_release_binary', githubRepo: 'fixture/member', binaryName: 'fixture-member' } };
  const environment = { HOME: owner, HAPPIER_HOME_DIR: join(owner, '.happier'), HAPPIER_MANAGED_TOOLS_ROOT: join(root, 'shared'), PATH: '' };
  const shared = resolveAgentCliManagedCommandPathForRuntime(spec, { processEnv: environment });
  const local = resolveAgentCliManagedCommandPathForRuntime(spec, { processEnv: { HOME: home } });
  const vendor = join(home, '.local/bin/fixture-member');
  const executable = async (path: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, '#!/bin/sh\nexit 0\n'); await chmod(path, 0o755); };
  const resolve = () => {
    const resolved = resolveMemberAgentInstallCli({ runtimeSpec: spec, sharedManagedToolsRoot: environment.HAPPIER_MANAGED_TOOLS_ROOT },
      buildMemberAgentInstallEnvironment(home));
    if (!resolved) throw new Error('Expected an installed member executable');
    return resolved;
  };
  try {
    await executable(shared);
    expect((await resolve()).resolvedPath).toBe(shared);
    await executable(local);
    expect((await resolve()).resolvedPath).toBe(local);
    await executable(vendor);
    expect((await resolve()).resolvedPath).toBe(vendor);
    await rm(vendor); await rm(local);
    await executable(join(owner, '.local/bin/fixture-member'));
    expect((await resolve()).resolvedPath).toBe(shared);
  } finally { await rm(root, { recursive: true, force: true }); }
});
