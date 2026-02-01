import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { interactiveNew } from './utils/stack/interactive_stack_config.mjs';

function mkRl() {
  return { question: async () => '' };
}

test('interactive stack new in monorepo mode does not prompt for happy-server-light worktree', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-interactive-new-mono-'));

  const prevWorkspace = process.env.HAPPIER_STACK_WORKSPACE_DIR;
  try {
    const workspaceDir = join(tmp, 'workspace');
    process.env.HAPPIER_STACK_WORKSPACE_DIR = workspaceDir;

    const monoRoot = join(workspaceDir, '.worktrees', 'slopus', 'tmp', 'mono-wt');
    await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
    await mkdir(join(monoRoot, 'apps', 'cli'), { recursive: true });
    await mkdir(join(monoRoot, 'apps', 'server'), { recursive: true });
    await writeFile(join(monoRoot, '.git'), 'gitdir: dummy\n', 'utf-8');
    await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');

    const prompted = [];
    const out = await interactiveNew({
      rootDir,
      rl: mkRl(),
      defaults: {
        stackName: 'exp-mono-int',
        port: 1,
        serverComponent: 'happy-server-light',
        createRemote: 'upstream',
        repo: null,
      },
      deps: {
        prompt: async (_rl, question, { defaultValue } = {}) => {
          return defaultValue ?? '';
        },
        promptSelect: async (_rl, { title, options, defaultIndex = 0 } = {}) => {
          if (String(title ?? '').includes('Monorepo mode detected')) return true;
          return options?.[defaultIndex]?.value;
        },
        promptWorktreeSource: async ({ component }) => {
          prompted.push(component);
          if (component === 'happy') return 'slopus/tmp/mono-wt';
          throw new Error(`unexpected promptWorktreeSource call: ${component}`);
        },
      },
    });

    assert.deepEqual(prompted, ['happy']);
    assert.equal(out.repo, 'slopus/tmp/mono-wt');
  } finally {
    if (prevWorkspace == null) {
      delete process.env.HAPPIER_STACK_WORKSPACE_DIR;
    } else {
      process.env.HAPPIER_STACK_WORKSPACE_DIR = prevWorkspace;
    }
    await rm(tmp, { recursive: true, force: true });
  }
});
