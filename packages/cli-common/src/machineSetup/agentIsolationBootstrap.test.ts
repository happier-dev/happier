import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveFirstPartyInstallLayout } from '../firstPartyRuntime/installLayout.js';
import { firstPartyComponentCatalog } from '../firstPartyRuntime/componentCatalog.js';
import { resolveManagedToolsRoot } from '../agents/managedToolsRoot.js';
import { buildAgentIsolationBootstrapSteps } from './agentIsolationBootstrap.js';

describe('Agent isolation launch principal', () => {
  it.skipIf(process.platform !== 'linux')('checks and configures both global Git homes without access to the daemon cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-isolation-git-'));
    try {
      const cwd = join(root, 'daemon-cwd');
      mkdirSync(cwd);
      const steps = buildAgentIsolationBootstrapSteps({ daemonUsername: 'happier', daemonPrimaryGroup: 'happier',
        binaryPath: '/opt/happier/cli/current/happier', toolsRoot: '/opt/happier/tools' })
        .filter(step => step.kind === 'command');
      // Only runuser is substituted at the OS privilege boundary. Real Git runs
      // from an unlinked cwd, which neither the daemon nor the Agent can stat.
      const child = spawnSync(process.execPath, ['-e', `
        const fs = require('node:fs'), cp = require('node:child_process');
        const { cwd, steps, root } = JSON.parse(fs.readFileSync(0, 'utf8'));
        process.chdir(cwd); fs.rmdirSync(cwd);
        const results = [];
        for (const step of steps) {
          const env = { ...process.env, GIT_CONFIG_GLOBAL: root + '/' + step.id };
          const apply = cp.spawnSync(step.args[3], step.args.slice(4), { env, encoding: 'utf8' });
          const check = cp.spawnSync(step.check.args[3], step.check.args.slice(4), { env, encoding: 'utf8' });
          results.push({ id: step.id, apply: apply.status, check: check.status, value: check.stdout.trim(),
            stderr: apply.stderr + check.stderr });
        }
        console.log(JSON.stringify(results));
      `], { input: JSON.stringify({ cwd, steps, root }), encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' } });
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual(['happier-shared-git', 'happier-agent-shared-git'].map(id =>
        ({ id, apply: 0, check: 0, value: 'core.sharedrepository group', stderr: '' })));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('uses the install owner selected per-stack CLI in the exact RunAs command', () => {
    const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', channel: 'stable',
      processEnv: { HAPPIER_HOME_DIR: '/home/happier/.happier/stack-state/agent-qa/cli' } });
    const binaryPath = posix.join(layout.currentPath, firstPartyComponentCatalog['happier-cli'].binaryRelativePath);
    const steps = buildAgentIsolationBootstrapSteps({ daemonUsername: 'happier', daemonPrimaryGroup: 'happier', binaryPath,
      toolsRoot: resolveManagedToolsRoot() });
    expect(steps.find(step => step.id === 'agent-runas')).toMatchObject({ content: {
      kind: 'literal', value: expect.stringContaining(`Cmnd_Alias HAPPIER_AGENT_LAUNCH = ${binaryPath} agent-launch\n`),
    } });
  });

  it('provisions tools in the selected managed install home independently of private state', () => {
    const processEnv = { HAPPIER_HOME_DIR: '/private/daemon', HAPPIER_FIRST_PARTY_INSTALL_HOME: '/srv/agent-qa-payload' };
    const steps = buildAgentIsolationBootstrapSteps({ daemonUsername: 'alice', daemonPrimaryGroup: 'engineers',
      binaryPath: '/srv/agent-qa-payload/cli/current/happier', toolsRoot: resolveManagedToolsRoot(processEnv) });
    expect(steps.find(step => step.id === 'tools-root')).toMatchObject({ kind: 'directory',
      path: resolveManagedToolsRoot(processEnv), owner: 'alice', group: 'engineers', mode: 0o755 });
  });

  it.each(['relative/happier', '/tmp/happier\n', '/tmp/happier\nALL ALL=(ALL) ALL', '/tmp/happier, /bin/sh',
    '/tmp/*/happier', '/tmp/happier:ALL', '/tmp/happier\\', '/tmp/happier#comment'])('refuses nonliteral sudoers command path %j', binaryPath => {
    expect(() => buildAgentIsolationBootstrapSteps({ daemonUsername: 'happier', daemonPrimaryGroup: 'happier', binaryPath,
      toolsRoot: resolveManagedToolsRoot() })).toThrow();
  });
});
