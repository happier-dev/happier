import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { fakeChromeCommandLine } from '../../testkit/core/fake_chrome_command_line.mjs';
import { captureDevTargetSyncFixture } from '../../testkit/core/dev_target_sync.mjs';
import { killProcessTree, spawnProc } from '../proc/proc.mjs';
import { runQaBrowserSession } from './qa_browser.mjs';

// Chromium's CDP reply is an external boundary. The authored remote command,
// custody pipe, worker launch, profile and cleanup execute in real processes.
class AnsweringCdpSocket extends EventTarget {
  constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  send(data) {
    const command = JSON.parse(data);
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ id: command.id, result: { product: 'fixture' } }),
    })));
  }
  close() {}
}

for (const end of ['cancellation', 'unexpected worker exit']) {
  test(`a clean forward exit restores the same real browser worker before ${end}`,
    { skip: process.platform === 'win32', timeout: 60_000 }, async t => {
      const fixture = await createTempFixture(t, { prefix: 'hstack-browser-recovery-', registerCleanup: false });
      const { root } = fixture;
      const chromePort = await fakeChromeCommandLine(t);
      const closedPath = join(root, 'browser-closed');
      const { binDir } = writeFakeBin({ root, name: 'agent-browser', content: `#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2);
const session=args[args.indexOf('--session')+1];
if(args.includes('open'))fs.writeFileSync(path.join(args[args.indexOf('--profile')+1],'DevToolsActivePort'),${JSON.stringify(`${chromePort}\n/devtools/browser/recovery-browser\n`)});
else if(!session.startsWith('hstack-discovery-'))fs.writeFileSync(${JSON.stringify(closedPath)},session);
` });
      const signals = new EventEmitter();
      const forwards = [];
      let worker;
      let observed;
      let workerStarts = 0;
      let resolveReady;
      const ready = new Promise(resolve => { resolveReady = resolve; });
      let resolveRestored;
      const restored = new Promise(resolve => { resolveRestored = resolve; });
      const result = runQaBrowserSession({
        target: { name: 'recovery-fixture', platform: 'posix', ssh: 'fixture',
          repoDir: fileURLToPath(new URL('../../../../../', import.meta.url)), cliHomeDir: root,
          remotePath: [binDir, dirname(process.execPath)] },
        stackName: 'browser-recovery', stackBaseDir: root, sessionName: end.replaceAll(' ', '-'),
        url: 'http://127.0.0.1:3000/', env: { ...process.env, TMPDIR: root }, onReady: resolveReady,
      }, {
        signalSource: signals,
        capture: async (command, args) => captureDevTargetSyncFixture(command, args)
          ?? { ok: true, exitCode: 0, out: '', err: '' },
        spawnProcess: (label, _command, args, env, options) => {
          if (label.startsWith('browser-forward:')) {
            // Replace only SSH: a separate live process ends cleanly on demand.
            const child = spawnProc(label, process.execPath, ['-e',
              "process.stdin.resume(); process.stdin.once('data',()=>process.exit(0));"], env,
            { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
            forwards.push({ child, args });
            return child;
          }
          workerStarts++;
          worker = spawnProc(label, '/bin/bash', ['-c', args.at(-1)], env, {
            ...options, onLine: event => {
              if (event.line.startsWith('HSTACK_QA_BROWSER=')) observed = JSON.parse(event.line.slice('HSTACK_QA_BROWSER='.length));
              options.onLine?.(event);
            },
          });
          return worker;
        },
        fetchImpl: async () => {
          if (forwards.length === 2) resolveRestored();
          return { ok: true, json: async () => ({ webSocketDebuggerUrl: 'fixture' }) };
        },
        WebSocketImpl: AnsweringCdpSocket,
      }).then(() => null, error => error);
      try {
        const admitted = await Promise.race([ready, result.then(error => { throw error ?? new Error('worker ended before admission'); })]);
        forwards[0].child.stdin.end('drop');
        assert.equal((await forwards[0].child.completion).code, 0);
        await Promise.race([restored, result.then(error => { throw error ?? new Error('worker ended during recovery'); })]);
        assert.equal(workerStarts, 1, 'restoring listeners must not replay the browser worker');
        assert.deepEqual(forwards[1].args, forwards[0].args, 'both listener bindings must remain unchanged');
        assert.equal(admitted.remotePid, observed.pid);
        process.kill(observed.pid, 0);
        await access(observed.profile);
        await assert.rejects(access(closedPath), { code: 'ENOENT' });
        if (end === 'cancellation') signals.emit('SIGINT');
        else worker.stdin.write('close\n'); // A remote close has no controller cancellation.
        const failure = await result;
        if (end === 'cancellation') assert.equal(failure, null);
        else assert.equal(failure?.code, 'qa-browser-worker-exited', 'an unrequested clean worker exit must be a terminal failure');
        assert.equal(await readFile(closedPath, 'utf8'), observed.session);
        await assert.rejects(access(observed.profile), { code: 'ENOENT' });
      } finally {
        signals.emit('SIGINT');
        await result;
        for (const { child } of forwards) await killProcessTree(child, 'SIGINT', { graceMs: 2_000 });
        if (worker) await killProcessTree(worker, 'SIGINT', { graceMs: 2_000 });
        await fixture.cleanup();
      }
    });
}
