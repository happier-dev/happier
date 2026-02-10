import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNodeCapture } from './testkit/stack_script_command_testkit.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptsDir);

async function ensureMinimalHappierMonorepo({ monoRoot }) {
  await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'cli', 'bin'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'cli', 'dist'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
}

async function writeStubHappyCli({ cliDir }) {
  const script = [
    "import { appendFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    '',
    'const args = process.argv.slice(2);',
    "const home = process.env.HAPPIER_HOME_DIR || process.cwd();",
    "const logPath = join(home, 'resume-invocations.log');",
    "const supportsDaemonResume = process.env.STUB_DAEMON_RESUME_SUPPORT === '1';",
    '',
    'if (args[0] === \'daemon\' && args[1] === \'--help\') {',
    '  if (supportsDaemonResume) {',
    "    console.log('Usage:\\n  happier daemon resume <sessionId...>');",
    '  } else {',
    "    console.log('happier daemon - Daemon management');",
    "    console.log('Usage: happier daemon start|stop|status|list');",
    '  }',
    '  process.exit(0);',
    '}',
    '',
    'if (args[0] === \'daemon\' && args[1] === \'resume\') {',
    "  appendFileSync(logPath, `daemon resume ${args.slice(2).join(' ')}\\n`, 'utf-8');",
    '  process.exit(0);',
    '}',
    '',
    "appendFileSync(logPath, `unexpected ${args.join(' ')}\\n`, 'utf-8');",
    'process.exit(0);',
    '',
  ].join('\n');

  await writeFile(join(cliDir, 'dist', 'index.mjs'), script, 'utf-8');
  await writeFile(join(cliDir, 'bin', 'happier.mjs'), "import '../dist/index.mjs';\n", 'utf-8');
}

async function createResumeFixture(t, { stackName = 'exp-test', serverPort = 4101 } = {}) {
  const tmp = await mkdtemp(join(tmpdir(), 'happier-stack-resume-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');
  const monoRoot = join(workspaceDir, 'happier');
  const cliDir = join(monoRoot, 'apps', 'cli');
  const stackCliHome = join(storageDir, stackName, 'cli');

  await ensureMinimalHappierMonorepo({ monoRoot });
  await writeStubHappyCli({ cliDir });
  await mkdir(stackCliHome, { recursive: true });

  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${stackCliHome}`,
      `HAPPIER_STACK_SERVER_PORT=${serverPort}`,
      '',
    ].join('\n'),
    'utf-8'
  );

  return {
    stackName,
    stackCliHome,
    baseEnv: {
      ...process.env,
      HAPPIER_STACK_HOME_DIR: homeDir,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    },
  };
}

test('hstack stack resume fails closed when happier daemon does not support resume', async (t) => {
  const fixture = await createResumeFixture(t);
  const res = await runNodeCapture(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'resume', fixture.stackName, 'session-1', '--json'],
    { cwd: rootDir, env: fixture.baseEnv }
  );

  assert.equal(
    res.code,
    1,
    `expected exit 1 when daemon resume is unsupported\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
  );
  assert.match(res.stdout, /resume_not_supported/i);

  const invocationLog = join(fixture.stackCliHome, 'resume-invocations.log');
  assert.equal(existsSync(invocationLog), false, 'expected daemon resume not to be invoked');
});

test('hstack stack resume invokes happier daemon resume when supported', async (t) => {
  const fixture = await createResumeFixture(t);
  const res = await runNodeCapture(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'resume', fixture.stackName, 'session-a', 'session-b', '--json'],
    {
      cwd: rootDir,
      env: {
        ...fixture.baseEnv,
        STUB_DAEMON_RESUME_SUPPORT: '1',
      },
    }
  );

  assert.equal(res.code, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /"resumed":\s*\[\s*"session-a",\s*"session-b"\s*\]/);
});
