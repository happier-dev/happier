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

  const prevWorkspace = process.env.HAPPY_STACKS_WORKSPACE_DIR;
  try {
    const workspaceDir = join(tmp, 'workspace');
    process.env.HAPPY_STACKS_WORKSPACE_DIR = workspaceDir;

    const monoRoot = join(workspaceDir, 'components', '.worktrees', 'happy', 'slopus', 'tmp', 'mono-wt');
    await mkdir(join(monoRoot, 'packages', 'app'), { recursive: true });
    await mkdir(join(monoRoot, 'packages', 'cli'), { recursive: true });
    await mkdir(join(monoRoot, 'packages', 'server'), { recursive: true });
    await writeFile(join(monoRoot, '.git'), 'gitdir: dummy\n', 'utf-8');
    await writeFile(join(monoRoot, 'packages', 'app', 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(monoRoot, 'packages', 'cli', 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(monoRoot, 'packages', 'server', 'package.json'), '{}\n', 'utf-8');

    const prompted = [];
    const out = await interactiveNew({
      rootDir,
      rl: mkRl(),
      defaults: {
        stackName: 'exp-mono-int',
        port: 1,
        serverComponent: 'happy-server-light',
        createRemote: 'upstream',
        components: { happy: null, 'happy-cli': null, 'happy-server-light': null, 'happy-server': null },
      },
      deps: {
        prompt: async (_rl, question, { defaultValue } = {}) => {
          if (question.includes('Derive happy-cli + happy-server')) return 'y';
          return defaultValue ?? '';
        },
        promptWorktreeSource: async ({ component }) => {
          prompted.push(component);
          if (component === 'happy') return 'slopus/tmp/mono-wt';
          throw new Error(`unexpected promptWorktreeSource call: ${component}`);
        },
      },
    });

    assert.deepEqual(prompted, ['happy']);
    assert.equal(out.components.happy, 'slopus/tmp/mono-wt');
    assert.equal(out.components['happy-cli'], null);
    assert.equal(out.components['happy-server'], null);
    assert.equal(out.components['happy-server-light'], null);
  } finally {
    if (prevWorkspace == null) {
      delete process.env.HAPPY_STACKS_WORKSPACE_DIR;
    } else {
      process.env.HAPPY_STACKS_WORKSPACE_DIR = prevWorkspace;
    }
    await rm(tmp, { recursive: true, force: true });
  }
});
