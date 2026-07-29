import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { killDetachedProcessGroup, spawnDaemonLikeProcess } from './spawn_daemon_like_process.mjs';

async function waitForState(statePath, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return JSON.parse(await readFile(statePath, 'utf-8'));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for daemon state at ${statePath}`);
}

async function waitForReplacementState(statePath, previousPid, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await waitForState(statePath, timeoutMs);
    if (state.pid !== previousPid) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for replacement daemon state at ${statePath}`);
}

test('spawnDaemonLikeProcess writes authenticated pingable daemon state', async (t) => {
  const cliHomeDir = await mkdtemp(join(tmpdir(), 'happier-test-daemon-like-'));
  const statePath = join(cliHomeDir, 'servers', 'test-server', 'daemon.state.json');
  const child = spawnDaemonLikeProcess({
    cliHomeDir,
    internalServerUrl: 'http://127.0.0.1:3005',
    statePaths: [statePath],
    distClosureFingerprint: 'abcdef1234567890',
  });
  let replacementPid = null;
  t.after(async () => {
    killDetachedProcessGroup(child.pid);
    killDetachedProcessGroup(replacementPid);
    await rm(cliHomeDir, { recursive: true, force: true });
  });

  const state = await waitForState(statePath);
  assert.equal(state.pid, child.pid);
  assert.equal(typeof state.controlToken, 'string');
  assert.ok(state.controlToken.length > 0);
  assert.ok(Number.isFinite(state.httpPort) && state.httpPort > 0);

  const response = await fetch(`http://127.0.0.1:${state.httpPort}/ping`, {
    method: 'POST',
    headers: { 'x-happier-daemon-token': state.controlToken },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    distClosureFingerprint: 'abcdef1234567890',
  });

  const restartResponse = await fetch(`http://127.0.0.1:${state.httpPort}/restart`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-happier-daemon-token': state.controlToken,
    },
    body: JSON.stringify({ successorDistClosureFingerprint: '0123456789abcdef' }),
  });
  assert.equal(restartResponse.status, 200);
  assert.deepEqual(await restartResponse.json(), { status: 'restarting' });

  const replacement = await waitForReplacementState(statePath, state.pid);
  replacementPid = replacement.pid;
  const replacementPing = await fetch(`http://127.0.0.1:${replacement.httpPort}/ping`, {
    method: 'POST',
    headers: { 'x-happier-daemon-token': replacement.controlToken },
  });
  assert.equal(replacementPing.status, 200);
  assert.deepEqual(await replacementPing.json(), {
    ok: true,
    distClosureFingerprint: '0123456789abcdef',
  });
});
