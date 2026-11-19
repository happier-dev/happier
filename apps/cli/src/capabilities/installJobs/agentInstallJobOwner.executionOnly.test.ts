import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';

import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';

import { createAgentInstallJobOwner } from './agentInstallJobOwner';

it('installs an execution-only bundled Agent through its declared vendor recipe', async () => {
  const registry = resolveBuiltInContributions({ pluginIds: ['happier.review.coderabbit'] });
  const agent = registry.agents.find(candidate => candidate.identity?.localId === 'coderabbit');
  expect(agent?.richDefinition?.definition.primary).toBe('executionRuns');
  const root = await mkdtemp(join(tmpdir(), 'happier-execution-only-install-'));
  const recipeCommand = process.platform === 'win32' ? 'powershell.exe' : 'sh';
  const recipePath = join(root, 'bin', recipeCommand);
  const installedPath = process.platform === 'win32'
    ? join(root, 'Programs', 'coderabbit', 'coderabbit.exe')
    : join(root, '.local', 'bin', 'coderabbit');
  let executedRecipe = false;
  const owner = createAgentInstallJobOwner({
    readRegistry: () => registry,
    readTrackedSessions: () => [],
    env: { HOME: root, USERPROFILE: root, LOCALAPPDATA: root, HAPPIER_HOME_DIR: root, PATH: join(root, 'bin') },
    installerDeps: {
      // The OS process boundary substitutes the vendor download/install and version
      // process. Cold declarations, projections, consent, job and install logic stay real.
      execFileWithDeadline: async (_command, args) => {
        if (args.some(arg => arg.includes('https://cli.coderabbit.ai/install.'))) {
          executedRecipe = true;
          await mkdir(dirname(installedPath), { recursive: true });
          await writeFile(installedPath, 'fixture-installed-coderabbit');
          await chmod(installedPath, 0o755);
          return { stdout: '', stderr: '' };
        }
        return { stdout: 'CodeRabbit CLI 0.9.5\n', stderr: '' };
      },
    },
  });
  try {
    await mkdir(dirname(recipePath), { recursive: true });
    await writeFile(recipePath, 'fixture-installer-shell');
    await chmod(recipePath, 0o755);
    if (!agent) throw new Error('Missing bundled CodeRabbit Agent');
    const started = owner.start({ agentId: agent.id, intent: 'install', consent: { vendorRecipe: true } });
    expect(started).toMatchObject({ ok: true });
    if (!started.ok) return;
    const completed = await owner.read({ jobId: started.jobId, cursor: 0, waitForTerminal: true });
    expect(completed).toMatchObject({ ok: true, done: true, outcome: { kind: 'succeeded', version: '0.9.5' } });
    expect(executedRecipe).toBe(true);
    expect(await readFile(installedPath, 'utf8')).toBe('fixture-installed-coderabbit');
  } finally {
    await owner.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
