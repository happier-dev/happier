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

function createInteractiveDeps({ prompted = [], selectedRepo = 'tmp/mono-wt' } = {}) {
  return {
    prompt: async (_rl, _question, { defaultValue } = {}) => defaultValue ?? '',
    promptSelect: async (_rl, { options, defaultIndex = 0 } = {}) => options?.[defaultIndex]?.value,
    promptWorktreeSource: async ({ component }) => {
      prompted.push(component);
      if (selectedRepo != null) return selectedRepo;
      throw new Error(`unexpected promptWorktreeSource call: ${component}`);
    },
  };
}

test('interactive stack new in monorepo mode prompts once for shared repo source', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happier-stack-interactive-new-mono-'));
  const prompted = [];

  const prevWorkspace = process.env.HAPPIER_STACK_WORKSPACE_DIR;
  const prevOwner = process.env.HAPPIER_STACK_OWNER;
  try {
    const workspaceDir = join(tmp, 'workspace');
    process.env.HAPPIER_STACK_WORKSPACE_DIR = workspaceDir;
    process.env.HAPPIER_STACK_OWNER = 'test';

    const monoRoot = join(workspaceDir, 'tmp', 'test', 'mono-wt');
    await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
    await mkdir(join(monoRoot, 'apps', 'cli'), { recursive: true });
    await mkdir(join(monoRoot, 'apps', 'server'), { recursive: true });
    await writeFile(join(monoRoot, '.git'), 'gitdir: dummy\n', 'utf-8');
    await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');

    const out = await interactiveNew({
      rootDir,
      rl: mkRl(),
      defaults: {
        stackName: 'exp-mono-int',
        port: 1,
        serverComponent: 'happier-server-light',
        createRemote: 'upstream',
        repo: null,
      },
      deps: createInteractiveDeps({ prompted }),
    });

    assert.deepEqual(prompted, ['happier-ui']);
    assert.equal(out.repo, 'tmp/mono-wt');
  } finally {
    if (prevWorkspace == null) {
      delete process.env.HAPPIER_STACK_WORKSPACE_DIR;
    } else {
      process.env.HAPPIER_STACK_WORKSPACE_DIR = prevWorkspace;
    }
    if (prevOwner == null) {
      delete process.env.HAPPIER_STACK_OWNER;
    } else {
      process.env.HAPPIER_STACK_OWNER = prevOwner;
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('interactive stack new skips worktree prompt when repo is already provided', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happier-stack-interactive-new-mono-preseed-'));
  const prompted = [];

  const prevWorkspace = process.env.HAPPIER_STACK_WORKSPACE_DIR;
  const prevOwner = process.env.HAPPIER_STACK_OWNER;
  try {
    const workspaceDir = join(tmp, 'workspace');
    process.env.HAPPIER_STACK_WORKSPACE_DIR = workspaceDir;
    process.env.HAPPIER_STACK_OWNER = 'test';

    const monoRoot = join(workspaceDir, 'tmp', 'test', 'mono-wt');
    await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
    await mkdir(join(monoRoot, 'apps', 'cli'), { recursive: true });
    await mkdir(join(monoRoot, 'apps', 'server'), { recursive: true });
    await writeFile(join(monoRoot, '.git'), 'gitdir: dummy\n', 'utf-8');
    await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');

    const out = await interactiveNew({
      rootDir,
      rl: mkRl(),
      defaults: {
        stackName: 'exp-mono-preseed',
        port: 1,
        serverComponent: 'happier-server-light',
        createRemote: 'upstream',
        repo: 'dev',
      },
      deps: createInteractiveDeps({ prompted, selectedRepo: null }),
    });

    assert.deepEqual(prompted, []);
    assert.equal(out.repo, 'dev');
  } finally {
    if (prevWorkspace == null) {
      delete process.env.HAPPIER_STACK_WORKSPACE_DIR;
    } else {
      process.env.HAPPIER_STACK_WORKSPACE_DIR = prevWorkspace;
    }
    if (prevOwner == null) {
      delete process.env.HAPPIER_STACK_OWNER;
    } else {
      process.env.HAPPIER_STACK_OWNER = prevOwner;
    }
    await rm(tmp, { recursive: true, force: true });
  }
});
