import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeCapture } from './stack_script_cmd.testHelper.mjs';

test('hstack stack eas help routing covers explicit, implicit, and missing-stack branches', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stack-eas-help-'));
  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const stackName = 'exp-eas-help';
  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(envPath, 'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light\n', 'utf-8');

  t.after(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  const env = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HSTACK_EAS_TEST_STUB: '1',
  };

  const cases = [
    {
      name: 'explicit --help',
      args: ['eas', stackName, '--help'],
      expectedCode: 0,
      expectStdout: (stdout) => {
        assert.match(stdout, /^\[eas\] usage:/m, stdout);
        assert.ok(!stdout.includes('[stack] usage:'), stdout);
      },
    },
    {
      name: 'implicit help with no subcommand',
      args: ['eas', stackName],
      expectedCode: 0,
      expectStdout: (stdout) => {
        assert.match(stdout, /^\[eas\] usage:/m, stdout);
      },
    },
    {
      name: 'unknown stack returns stack-scoped env error',
      args: ['eas', 'missing-stack', 'whoami'],
      expectedCode: 1,
      expectStdout: (stdout) => {
        assert.equal(stdout, '', stdout);
      },
      expectStderr: (stderr) => {
        assert.match(stderr, /^\[stack\] failed: \[stack\] stack "missing-stack" does not exist yet\./m, stderr);
      },
    },
  ];

  for (const testCase of cases) {
    const res = await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), ...testCase.args], { cwd: rootDir, env });
    assert.equal(
      res.code,
      testCase.expectedCode,
      `${testCase.name}: expected exit ${testCase.expectedCode}, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );
    testCase.expectStdout(res.stdout);
    testCase.expectStderr?.(res.stderr);
  }
});
