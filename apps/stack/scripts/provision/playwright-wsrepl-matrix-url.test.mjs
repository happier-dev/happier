import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

async function loadQaUrlModule() {
  const repoRoot = resolve(join(__dirname, '../../../../'));
  const modPath = resolve(join(repoRoot, 'scripts/qa/resolveQaUiUrl.mjs'));
  return import(pathToFileURL(modPath).href);
}

test('qa wsrepl url helper resolves stack runtime ports using a loopback 127.0.0.1 server url', async () => {
  const qa = await loadQaUrlModule();
  assert.equal(typeof qa.resolveQaUiUrl, 'function', 'expected resolveQaUiUrl.mjs to export resolveQaUiUrl');

  const root = await mkdtemp(join(tmpdir(), 'qa-wsrepl-uiurl-'));
  const runtimePath = resolve(join(root, 'stack.runtime.json'));
  await writeFile(
    runtimePath,
    JSON.stringify({ ports: { server: 53288 }, expo: { webPort: 19364 } }) + '\n',
    'utf8',
  );

  const prev = process.env.HAPPIER_QA_STACK_RUNTIME_JSON_PATH;
  process.env.HAPPIER_QA_STACK_RUNTIME_JSON_PATH = runtimePath;
  try {
    const out = qa.resolveQaUiUrl();
    const parsed = new URL(out);
    assert.equal(parsed.origin, 'http://127.0.0.1:19364');
    assert.equal(parsed.searchParams.get('server'), 'http://127.0.0.1:53288');
  } finally {
    if (prev === undefined) delete process.env.HAPPIER_QA_STACK_RUNTIME_JSON_PATH;
    else process.env.HAPPIER_QA_STACK_RUNTIME_JSON_PATH = prev;
  }
});

test('qa wsrepl url helper can auto-detect the newest stack.runtime.json when stack name and explicit runtime path are unset', async () => {
  const qa = await loadQaUrlModule();

  const root = await mkdtemp(join(tmpdir(), 'qa-wsrepl-uiurl-autodetect-'));
  const stacksDir = resolve(join(root, 'stacks'));
  await mkdir(stacksDir, { recursive: true });

  const stackA = join(stacksDir, 'stack-a');
  const stackB = join(stacksDir, 'stack-b');
  await mkdir(stackA, { recursive: true });
  await mkdir(stackB, { recursive: true });

  await writeFile(
    join(stackA, 'stack.runtime.json'),
    JSON.stringify({ ports: { server: 40001 }, expo: { webPort: 40002 }, updatedAt: '2026-03-22T00:00:00.000Z' }) + '\n',
    'utf8',
  );
  await writeFile(
    join(stackB, 'stack.runtime.json'),
    JSON.stringify({ ports: { server: 50001 }, expo: { webPort: 50002 }, updatedAt: '2026-03-23T00:00:00.000Z' }) + '\n',
    'utf8',
  );

  const prevStacksDir = process.env.HAPPIER_QA_STACKS_DIR;
  const prevRuntimePath = process.env.HAPPIER_QA_STACK_RUNTIME_JSON_PATH;
  const prevStackName = process.env.HAPPIER_QA_STACK_NAME;
  delete process.env.HAPPIER_QA_STACK_RUNTIME_JSON_PATH;
  delete process.env.HAPPIER_QA_STACK_NAME;
  process.env.HAPPIER_QA_STACKS_DIR = stacksDir;

  try {
    const out = qa.resolveQaUiUrl();
    const parsed = new URL(out);
    assert.equal(parsed.origin, 'http://127.0.0.1:50002');
    assert.equal(parsed.searchParams.get('server'), 'http://127.0.0.1:50001');
  } finally {
    if (prevStacksDir === undefined) delete process.env.HAPPIER_QA_STACKS_DIR;
    else process.env.HAPPIER_QA_STACKS_DIR = prevStacksDir;
    if (prevRuntimePath === undefined) delete process.env.HAPPIER_QA_STACK_RUNTIME_JSON_PATH;
    else process.env.HAPPIER_QA_STACK_RUNTIME_JSON_PATH = prevRuntimePath;
    if (prevStackName === undefined) delete process.env.HAPPIER_QA_STACK_NAME;
    else process.env.HAPPIER_QA_STACK_NAME = prevStackName;
  }
});

test('qa wsrepl url helper preserves server query param by default', async () => {
  const qa = await loadQaUrlModule();
  assert.equal(typeof qa.withQaUiBase, 'function', 'expected resolveQaUiUrl.mjs to export withQaUiBase');

  const base = 'http://localhost:19364/?server=http%3A%2F%2F127.0.0.1%3A53288&happier_hmr=0';
  const next = qa.withQaUiBase(base, '/session/sess_123/info');

  const parsed = new URL(next);
  assert.equal(parsed.pathname, '/session/sess_123/info');
  assert.equal(parsed.searchParams.get('server'), 'http://127.0.0.1:53288');
  assert.equal(parsed.searchParams.get('happier_hmr'), '0');
});

test('qa wsrepl url helper can strip server query param when requested', async () => {
  const qa = await loadQaUrlModule();
  assert.equal(typeof qa.withQaUiBase, 'function', 'expected resolveQaUiUrl.mjs to export withQaUiBase');

  const base = 'http://localhost:19364/?server=http%3A%2F%2F127.0.0.1%3A53288&happier_hmr=0';
  const next = qa.withQaUiBase(base, '/session/sess_123/info', { stripServerParam: true });

  const parsed = new URL(next);
  assert.equal(parsed.pathname, '/session/sess_123/info');
  assert.equal(parsed.searchParams.get('server'), null);
  assert.equal(parsed.searchParams.get('happier_hmr'), '0');
});

test('qa wsrepl url helper can force happier_hmr=0', async () => {
  const qa = await loadQaUrlModule();
  assert.equal(
    typeof qa.ensureQaUiUrlHasHmrDisabled,
    'function',
    'expected resolveQaUiUrl.mjs to export ensureQaUiUrlHasHmrDisabled',
  );

  const base = 'http://localhost:19364/?server=http%3A%2F%2F127.0.0.1%3A53288';
  const next = qa.ensureQaUiUrlHasHmrDisabled(base);
  const parsed = new URL(next);
  assert.equal(parsed.searchParams.get('server'), 'http://127.0.0.1:53288');
  assert.equal(parsed.searchParams.get('happier_hmr'), '0');
});

test('qa wsrepl url helper can match a path suffix', async () => {
  const qa = await loadQaUrlModule();
  assert.equal(
    typeof qa.isQaUiUrlPathSuffix,
    'function',
    'expected resolveQaUiUrl.mjs to export isQaUiUrlPathSuffix',
  );

  assert.equal(
    qa.isQaUiUrlPathSuffix('http://localhost:19364/session/abc/info?server=http%3A%2F%2F127.0.0.1%3A53288', '/session/abc/info'),
    true,
  );
  assert.equal(
    qa.isQaUiUrlPathSuffix('http://localhost:19364/new?server=http%3A%2F%2F127.0.0.1%3A53288', '/session/abc/info'),
    false,
  );
});
