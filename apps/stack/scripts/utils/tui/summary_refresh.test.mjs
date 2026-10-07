import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import http from 'node:http';

import { createTuiSummaryRefresh, readTuiDaemonView } from './summary_refresh.mjs';
import { spawnDetachedInlineNodeTestProcess } from '../../testkit/core/spawn_test_process.mjs';
import { resolvePreferredStackDaemonStatePaths } from '../auth/credentials_paths.mjs';
import { applyTuiStackAuthScopeEnv } from './stack_scope_env.mjs';

test('summary and daemon pane share one control observation, with fresh status on the next refresh', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-tui-observation-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const stackName = 'tui-observation';
  const cliHomeDir = join(tmp, 'cli');
  const envPath = join(tmp, 'env');
  const env = { ...process.env, HAPPIER_STACK_STACK: stackName, HAPPIER_STACK_ENV_FILE: envPath,
    HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir, HAPPIER_STACK_START_DAEMON: '1' };
  const child = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1000)', { env });
  t.after(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} });
  let requests = 0;
  let reachable = true;
  // HTTP is the genuine boundary; state selection, ownership and notice projection stay real.
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/ping');
    assert.equal(req.headers['x-happier-daemon-token'], 'fixture-token');
    requests++;
    res.writeHead(reachable ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: reachable }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir,
    env: applyTuiStackAuthScopeEnv({ env, stackName }) });
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify({ pid: child.pid, httpPort: server.address().port, controlToken: 'fixture-token' }));
  let view;
  const refresh = createTuiSummaryRefresh(async () => {
    view = await readTuiDaemonView({ stackName, cliHomeDir, internalServerUrl: '', runtime: {}, env });
  });
  await refresh();
  assert.equal(view.observedDaemon.status, 'running');
  assert.equal(view.daemonRunning, true);
  assert.equal(view.notice.show, false);
  assert.equal(requests, 1, 'one refresh must not repeat its daemon control probe');
  reachable = false;
  await refresh();
  assert.equal(view.observedDaemon.status, 'unreachable');
  assert.equal(view.daemonRunning, false);
  assert.equal(view.notice.show, true);
  assert.equal(requests, 2, 'a new refresh must observe the changed transport');
  await writeFile(statePath, JSON.stringify({ pid: process.pid, httpPort: server.address().port, controlToken: 'fixture-token' }));
  await refresh();
  assert.equal(requests, 2, 'foreign daemon state must not receive a control token');
});

test('timer and action refreshes share an in-flight summary read and render', async () => {
  let releaseRead;
  const read = new Promise((resolve) => { releaseRead = resolve; });
  let activeReads = 0;
  let peakReads = 0;
  let rendered = 0;
  const refresh = createTuiSummaryRefresh(async () => {
    activeReads += 1;
    peakReads = Math.max(peakReads, activeReads);
    await read;
    activeReads -= 1;
    rendered += 1;
  });

  const timerRefresh = refresh();
  const actionRefresh = refresh();
  await Promise.resolve();
  releaseRead();
  await Promise.all([timerRefresh, actionRefresh]);
  assert.equal(peakReads, 1, 'a slow read must not multiply network and filesystem work');
  assert.equal(rendered, 1);

  await refresh();
  assert.equal(rendered, 2, 'the next tick still reads and renders current state');
});

test('a failed refresh rejects its observers and leaves the next refresh runnable', async () => {
  const failure = new Error('summary read unavailable');
  let unavailable = true;
  let rendered = false;
  const refresh = createTuiSummaryRefresh(async () => {
    if (unavailable) throw failure;
    rendered = true;
  });
  const outcomes = await Promise.allSettled([refresh(), refresh()]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ['rejected', 'rejected']);
  for (const outcome of outcomes) assert.equal(outcome.reason, failure);
  unavailable = false;
  await refresh();
  assert.equal(rendered, true);
});
