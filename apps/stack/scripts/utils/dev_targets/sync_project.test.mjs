import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import {
  INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  ensureDevTargetSyncProject,
  releaseIndependentDevTargetSyncProject,
  runDevTargetControlProcess,
} from './sync_project.mjs';
import { renderMutagenProject } from './mutagen_project.mjs';

const target = {
  name: 'mac',
  platform: 'posix',
  ssh: 'mac',
  repoDir: '/Users/dev/happier',
  cliHomeDir: '/Users/dev/.happier',
};

test('canonical dev-target control runner captures stdout while streaming diagnostics', async () => {
  const result = await runDevTargetControlProcess({
    label: 'dev-target-control-test',
    command: process.execPath,
    args: ['-e', 'process.stdout.write("session-json\\n"); process.stderr.write("diagnostic\\n")'],
    env: process.env,
  });

  assert.equal(result.code, 0);
  assert.equal(result.out, 'session-json\n');
  assert.equal(result.err, 'diagnostic\n');
});

async function writeMutagenStatusStub(root) {
  const binDir = join(root, 'bin');
  const scriptPath = join(binDir, 'mutagen-stub.mjs');
  await mkdir(binDir, { recursive: true });
  await writeFile(scriptPath, [
    "const args = process.argv.slice(2);",
    "if (args[0] === 'sync' && args[1] === 'list') {",
    "  const sessionName = args[2];",
    "  process.stderr.write(`status warning for ${sessionName}\\n`);",
    "  if (sessionName === process.env.FAKE_MUTAGEN_FAIL_SESSION) process.exit(7);",
    "  process.stdout.write(`${JSON.stringify([{ name: sessionName, status: 'watching', successfulCycles: 1 }])}\\n`);",
    "}",
  ].join('\n'));
  const executablePath = join(binDir, 'mutagen');
  await writeFile(executablePath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`);
  await chmod(executablePath, 0o755);
  await writeFile(
    `${executablePath}.cmd`,
    `@"${process.execPath}" "${scriptPath}" %*\r\n`,
  );
  return binDir;
}

test('independent sync start owns and resumes the canonical Mutagen project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-start-'));
  const calls = [];
  const result = await ensureDevTargetSyncProject({
    stackBaseDir: root,
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
    allowIndependentBorrow: false,
    env: {},
  }, {
    runProcess: async ({ command, args }) => {
      calls.push({ command, args });
      return { code: 0 };
    },
  });

  assert.equal(result.ownership, 'owned');
  assert.deepEqual(
    calls.filter((call) => call.command === 'mutagen').map((call) => call.args[1] ?? call.args[0]),
    ['version', 'terminate', 'start', 'list'],
  );
  assert.match(
    await readFile(result.projectFile, 'utf8'),
    new RegExp(`^# hstack-owner: ${JSON.stringify(INDEPENDENT_DEV_TARGET_SYNC_OWNER)}`),
  );
});

test('Stack borrows an equivalent independent project without changing its lifecycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-borrow-'));
  const projectFile = join(root, 'mutagen', 'mutagen.yml');
  await mkdir(join(root, 'mutagen'), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));
  const calls = [];

  const result = await ensureDevTargetSyncProject({
    stackBaseDir: root,
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: 123,
    allowIndependentBorrow: true,
    env: {},
  }, {
    runProcess: async ({ command, args }) => {
      calls.push({ command, args });
      return {
        code: 0,
        ...(args[0] === 'sync'
          ? { out: JSON.stringify([{ name: 'happier-mac', status: 'watching', successfulCycles: 1 }]) }
          : {}),
      };
    },
  });

  assert.equal(result.ownership, 'independent');
  assert.deepEqual(calls.map((call) => call.args[1] ?? call.args[0]), ['version', 'list', 'list']);
  await result.release('pause');
  assert.deepEqual(calls.map((call) => call.args[1] ?? call.args[0]), ['version', 'list', 'list']);
});

test('Stack default runner captures active independent status for every configured target', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-default-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = await writeMutagenStatusStub(root);
  const targets = [
    { ...target, name: 'windows', platform: 'windows', ssh: 'windows' },
    target,
    { ...target, name: 'mac2', ssh: 'mac2' },
  ];
  await mkdir(join(root, 'mutagen'), { recursive: true });
  await writeFile(join(root, 'mutagen', 'mutagen.yml'), renderMutagenProject({
    sourceDir: '/source/happier',
    targets,
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));

  const result = await ensureDevTargetSyncProject({
    stackBaseDir: root,
    sourceDir: '/source/happier',
    targets,
    ownerId: process.pid,
    allowIndependentBorrow: true,
    env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
  });

  assert.equal(result.ownership, 'independent');
});

test('Stack default runner preserves a nonzero independent status exit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-default-runner-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = await writeMutagenStatusStub(root);
  await mkdir(join(root, 'mutagen'), { recursive: true });
  await writeFile(join(root, 'mutagen', 'mutagen.yml'), renderMutagenProject({
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));

  await assert.rejects(
    ensureDevTargetSyncProject({
      stackBaseDir: root,
      sourceDir: '/source/happier',
      targets: [target],
      ownerId: process.pid,
      allowIndependentBorrow: true,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
        FAKE_MUTAGEN_FAIL_SESSION: 'happier-mac',
      },
    }),
    /mac independent synchronization status failed \(code=7\)/,
  );
});

test('independent sync stop pauses and releases the generated project to Stack ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-stop-'));
  const projectFile = join(root, 'mutagen', 'mutagen.yml');
  await mkdir(join(root, 'mutagen'), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));
  const calls = [];

  const released = await releaseIndependentDevTargetSyncProject({
    stackBaseDir: root,
    env: {},
  }, {
    runProcess: async ({ command, args }) => {
      calls.push({ command, args });
      return { code: 0 };
    },
  });

  assert.equal(released, true);
  assert.deepEqual(calls.map((call) => call.args[1] ?? call.args[0]), ['pause']);
  assert.doesNotMatch(await readFile(projectFile, 'utf8'), /^# hstack-owner:/);
});
