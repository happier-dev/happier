import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { installWorkspaceAdmissionProcessFixture } from '../../testkit/core/native_admission_fixture.mjs';

const owner = new URL('./proc.mjs', import.meta.url).href;
const admissionOwner = new URL('./workspace_build_admission.mjs', import.meta.url).href;
const heartbeat = fileURLToPath(new URL('../../../../../scripts/runWithHeartbeat.mjs', import.meta.url));

function running(pid) {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() !== '' && !result.stdout.trim().startsWith('Z');
}

async function waitFor(read, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

for (const entry of ['foreground', 'workspace worker', 'heartbeat']) {
for (const cooperative of [false, true]) {
for (const cancellation of ['SIGINT', 'SIGTERM', 'abort', 'child default', 'child SIGKILL']) {
  if (entry === 'heartbeat' && (!cooperative || cancellation !== 'SIGTERM')) continue;
  if (entry === 'workspace worker' && (cancellation === 'abort' || cancellation.startsWith('child '))) continue;
  test(`owned ${entry} ${cancellation} retires its worker before settling (cooperative command=${cooperative})`, {
    skip: process.platform === 'win32',
  }, async t => {
    const fixture = await createTempFixture(t, { prefix: 'happier-foreground-cancel-' });
    const admission = entry === 'workspace worker'
      ? await installWorkspaceAdmissionProcessFixture(t, fixture.root) : null;
    const ready = fixture.path('ready.json');
    const settled = fixture.path('settled.json');
    const descendant = `process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); process.send(process.pid); setInterval(() => {}, 1000);`;
    const command = `
      const { fork } = require('node:child_process');
      process.on('SIGINT', () => { ${cooperative ? 'process.exit(0);' : ''} }); process.on('SIGTERM', () => { ${cooperative ? 'process.exit(0);' : ''} });
      const child = fork('-e', [${JSON.stringify(descendant)}], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.once('message', pid => require('node:fs').writeFileSync(${JSON.stringify(ready)}, JSON.stringify([process.pid, pid])));
      setInterval(() => {}, 1000);
    `;
    const wrapperPath = fixture.path('wrapper.mjs');
    const commandArgs = ['-e', command];
    const invocation = entry !== 'workspace worker' ? `
      import { getForegroundCommandResult, runCommand, spawnForegroundCommand } from ${JSON.stringify(owner)};
      const cancellation = new AbortController();
      const options = { ownedProcessGroup: true, stdio: 'ignore', signal: cancellation.signal };
      const direct = ${JSON.stringify(cancellation.startsWith('child '))};
      const child = direct ? spawnForegroundCommand(process.execPath, ${JSON.stringify(commandArgs)}, options) : null;
      if (child && child.kill(0) !== true) throw new Error('live owned child probe failed');
      const pending = child ? new Promise(resolve => {
        child.once('error', error => resolve({ error }));
        child.once('close', (status, signal) => resolve(getForegroundCommandResult(child, status, signal)));
      }) : runCommand(process.execPath, ${JSON.stringify(commandArgs)}, options);
      process.on('message', () => {
        if (child) {
          const accepted = ${JSON.stringify(cancellation)} === 'child default' ? child.kill() : child.kill('SIGKILL');
          if (!accepted) throw new Error('owned child cancellation was not accepted');
        } else cancellation.abort();
      });
      const result = await pending;
      if (child && child.kill(0) !== false) throw new Error('closed owned child probe succeeded');
    ` : `
      import { runWorkspaceBuildAdmissionWorker } from ${JSON.stringify(admissionOwner)};
      await runWorkspaceBuildAdmissionWorker(['--dev-startup', '[]', ${JSON.stringify(admission?.launcher ?? '')}, 'package-dist', '--', process.execPath, '-e', ${JSON.stringify(command)}]);
      const result = { status: process.exitCode };
    `;
    await writeFile(wrapperPath, `
      import { writeFileSync } from 'node:fs';
      ${invocation}
      writeFileSync(${JSON.stringify(settled)}, JSON.stringify({ status: result.status, signal: result.signal, errorCode: result.error?.code }));
      process.disconnect();
    `);
    const wrapperArgs = entry === 'heartbeat' ? [heartbeat, '--', process.execPath, '-e', command] : [wrapperPath];
    const wrapper = spawn(process.execPath, wrapperArgs, { ...(admission ? { env: admission.env } : {}), detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let entryResult;
    wrapper.once('close', (status, signal) => { entryResult = { status, signal }; });
    let stderr = '';
    wrapper.stderr.on('data', chunk => { stderr += chunk; });
    let pids = [];
    t.after(() => {
      for (const pid of [...pids, wrapper.pid]) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
      if (wrapper.connected) wrapper.disconnect();
    });
    pids = await waitFor(async () => JSON.parse(await readFile(ready, 'utf8').catch(() => 'null')), 'preparation tree did not start');
    assert.ok(pids.every(running), 'both real preparation processes must be running before cancellation');
    if (cancellation === 'abort' || cancellation.startsWith('child ')) wrapper.send('cancel');
    else wrapper.kill(cancellation);
    const result = await waitFor(async () => entry === 'heartbeat' ? entryResult : JSON.parse(await readFile(settled, 'utf8').catch(() => 'null')), `foreground cancellation did not settle: ${stderr}`);
    assert.deepEqual(pids.filter(running), [], 'cancellation must stop the whole preparation tree before its owner settles');
    if (cancellation === 'abort') assert.equal(result.errorCode, 'ABORT_ERR');
    else if (entry === 'foreground' && (!cooperative || cancellation === 'child SIGKILL')) assert.notEqual(result.signal, null);
    else if (entry === 'workspace worker') assert.equal(result.status, 130);
    else assert.equal(result.status, 0);
  });
}
}
}
