import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// gh is the external GitHub transport; all dispatch construction remains real. Run lookups answer with the
// RUN_LOOKUPS sequence (one entry per lookup, the last repeats): "404", "500", "401", or "<status>[:<conclusion>]".
function run(t, { environment = 'production', component = 'server', dispatchStatus = 0, watchStatus = 0, response = '{"workflow_run_id":123}', lookups = 'in_progress,completed:success' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hosted-deploy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls.jsonl');
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args.includes('--input') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({args,input})+'\\n');
if(args[0]==='api' && args.some((a)=>a.endsWith('/dispatches'))) {process.stdout.write(process.env.RESPONSE); process.exit(Number(process.env.DISPATCH_STATUS));}
if(args[0]==='api') {
  const seen = fs.readFileSync(process.env.CALL_LOG,'utf8').trim().split('\\n').filter((l)=>JSON.parse(l).args[0]==='api' && !l.includes('/dispatches')).length;
  const answers = process.env.RUN_LOOKUPS.split(',');
  const answer = answers[Math.min(seen, answers.length) - 1];
  if (answer === '404') { process.stderr.write('gh: Not Found (HTTP 404)'); process.exit(1); }
  if (answer === '500') { process.stderr.write('gh: HTTP 500: Server Error'); process.exit(1); }
  if (answer === '401') { process.stderr.write('gh: Bad credentials (HTTP 401)'); process.exit(1); }
  const [status, conclusion = null] = answer.split(':');
  process.stdout.write(JSON.stringify({ id: 123, status, conclusion })); process.exit(0);
}
process.exit(Number(process.env.WATCH_STATUS));
`);
  chmodSync(gh, 0o755);
  const image = `ghcr.io/happier-dev/${component === 'ui' ? 'webapp' : 'relay-server'}:0.2.21@sha256:${'a'.repeat(64)}`;
  const images = JSON.stringify(component === 'ui' ? { ui: image } : { api: image, worker: image });
  const result = spawnSync(process.execPath, ['scripts/pipeline/deploy/dispatch-hosted-deploy.mjs', '--images', images], {
    encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_REPO: 'happier-dev/happier', DEPLOY_ENVIRONMENT: environment, DEPLOY_COMPONENT: component, CALL_LOG: log, RESPONSE: response, DISPATCH_STATUS: String(dispatchStatus), WATCH_STATUS: String(watchStatus), RUN_LOOKUPS: lookups },
  });
  let calls = []; try { calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse); } catch {}
  const watches = calls.filter((call) => call.args[0] === 'run' && call.args[1] === 'watch');
  return { result, calls, images, watches };
}

test('dispatches the exact image map on each admitted deploy ref and waits for its returned run', { skip: process.platform === 'win32' }, (t) => {
  for (const environment of ['production', 'preview']) for (const component of ['server', 'ui']) {
    const { result, calls, images, watches } = run(t, { environment, component });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(calls[0].input), {
      ref: `deploy/${environment}/${component}`, return_run_details: true,
      inputs: { environment, component, confirm: `deploy ${environment} ${component}`, hosted_images: images },
    });
    assert.ok(calls[0].args.includes('repos/happier-dev/happier/actions/workflows/deploy.yml/dispatches'));
    assert.deepEqual(watches.map((call) => call.args), [['run', 'watch', '123', '--repo', 'happier-dev/happier']]);
  }
});

test('failed dispatch, missing run identity, and a failed or cancelled deploy fail promotion', { skip: process.platform === 'win32' }, (t) => {
  for (const options of [{ dispatchStatus: 1 }, { response: '{}' }]) {
    const { result, calls } = run(t, options);
    assert.notEqual(result.status, 0);
    assert.equal(calls.length, 1);
  }
  for (const conclusion of ['failure', 'cancelled']) {
    const { result } = run(t, { lookups: `in_progress,completed:${conclusion}` });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`ended ${conclusion}`));
  }
});

test('waits until the dispatched run is readable before watching it', { skip: process.platform === 'win32' }, (t) => {
  // Release run 45662976860: watching run 45683628055 right after dispatch got HTTP 404,
  // although that deploy then succeeded.
  const { result, watches } = run(t, { lookups: '404,404,in_progress,completed:success' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(watches.length, 1);
});

test('a watch that exits on a GitHub error while the deploy runs keeps waiting for the run outcome', { skip: process.platform === 'win32' }, (t) => {
  // Release run 45915649737: gh run watch exited 1 on HTTP 500 while deploy run 45927717957 went on to succeed.
  const { result, watches } = run(t, { watchStatus: 1, lookups: 'in_progress,500,in_progress,completed:success' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(watches.length, 2);
});

test('a run lookup failure other than not-found or a server error fails promotion without watching', { skip: process.platform === 'win32' }, (t) => {
  const { result, watches } = run(t, { lookups: '401' });
  assert.notEqual(result.status, 0);
  assert.equal(watches.length, 0);
});
