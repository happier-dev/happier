import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// gh is the external GitHub transport; all dispatch construction remains real.
function run(t, { environment = 'production', component = 'server', dispatchStatus = 0, watchStatus = 0, response = '{"workflow_run_id":123}' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hosted-deploy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls.jsonl');
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args.includes('--input') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({args,input})+'\\n');
if(args[0]==='api') {process.stdout.write(process.env.RESPONSE); process.exit(Number(process.env.DISPATCH_STATUS));}
process.exit(Number(process.env.WATCH_STATUS));
`);
  chmodSync(gh, 0o755);
  const image = `ghcr.io/happier-dev/${component === 'ui' ? 'webapp' : 'relay-server'}:0.2.21@sha256:${'a'.repeat(64)}`;
  const images = JSON.stringify(component === 'ui' ? { ui: image } : { api: image, worker: image });
  const result = spawnSync(process.execPath, ['scripts/pipeline/deploy/dispatch-hosted-deploy.mjs', '--images', images], {
    encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_REPO: 'happier-dev/happier', DEPLOY_ENVIRONMENT: environment, DEPLOY_COMPONENT: component, CALL_LOG: log, RESPONSE: response, DISPATCH_STATUS: String(dispatchStatus), WATCH_STATUS: String(watchStatus) },
  });
  let calls = []; try { calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse); } catch {}
  return { result, calls, images };
}

test('dispatches the exact image map on each admitted deploy ref and waits for its returned run', { skip: process.platform === 'win32' }, (t) => {
  for (const environment of ['production', 'preview']) for (const component of ['server', 'ui']) {
    const { result, calls, images } = run(t, { environment, component });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(calls[0].input), {
      ref: `deploy/${environment}/${component}`, return_run_details: true,
      inputs: { environment, component, confirm: `deploy ${environment} ${component}`, hosted_images: images },
    });
    assert.ok(calls[0].args.includes('repos/happier-dev/happier/actions/workflows/deploy.yml/dispatches'));
    assert.deepEqual(calls[1].args, ['run', 'watch', '123', '--repo', 'happier-dev/happier', '--exit-status']);
  }
});
test('failed dispatch, missing run identity, and failed or cancelled deploy fail promotion', { skip: process.platform === 'win32' }, (t) => {
  for (const options of [{ dispatchStatus: 1 }, { response: '{}' }, { watchStatus: 1 }]) {
    const { result, calls } = run(t, options);
    assert.notEqual(result.status, 0);
    assert.equal(calls.length, options.watchStatus ? 2 : 1);
  }
});
