import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { redactFailureDiagnostic } from '../../apps/stack/scripts/utils/proc/proc.mjs';

test('incomplete package results show a bounded redacted stderr reason', async t => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const temporary = join(repoRoot, '.project/tmp');
  await mkdir(temporary, { recursive: true });
  const cwd = await mkdtemp(join(temporary, 'touched-failure-probe-'));
  const packagePath = relative(repoRoot, cwd).replaceAll('\\', '/');
  const baselineDirectory = join(temporary, 'systemic-orch');
  await mkdir(baselineDirectory, { recursive: true });
  const baseline = join(baselineDirectory, `${basename(cwd)}-baseline.locs`);
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(baseline, { force: true });
  });
  await writeFile(baseline, '');
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: basename(cwd), private: true,
    scripts: { typecheck: 'node fail.mjs' } }));
  // Generated credentials never appear in test source or assertion diagnostics.
  const secret = randomUUID();
  const unboundSecret = randomUUID();
  const signedToken = ['eyJ' + randomUUID().replaceAll('-', ''), randomUUID(), randomUUID()].join('.');
  await writeFile(join(cwd, 'fail.mjs'), `
    process.stderr.write('HSTACK_TRACE: discarded-start\\n' + 'HSTACK_TRACE: padding\\n'.repeat(1000));
    process.stderr.write('[typecheck-failure] compiler: exit=2 signal=none reason=no-complete-diagnostics\\n');
    process.stdout.write('\\u001b[31m\\u2009ERR_PNPM_NO_SCRIPT\\u2009 Missing script: typecheck\\u001b[0m\\n');
    process.stderr.write('HSTACK_ADMISSION_REFUSED: worker unavailable\\n');
    process.stderr.write('ssh: Connection reset by peer\\n');
    process.stderr.write('ssh_dispatch_run_fatal: Connection reset by peer\\n');
    process.stderr.write('Shared connection to worker closed.\\n');
    process.stderr.write('[preferred-execution] Bearer ' + process.env.TOUCHED_FAILURE_SECRET + '\\n');
    process.stderr.write('HSTACK_REFUSED: pushToken=' + ${JSON.stringify(unboundSecret)} + '\\n');
    process.stderr.write('HSTACK_REFUSED: apiKey=' + ${JSON.stringify(unboundSecret)} + '\\n');
    process.stderr.write('HSTACK_REFUSED: pairingSecret=' + ${JSON.stringify(unboundSecret)} + '\\n');
    process.stderr.write('HSTACK_REFUSED: ' + ${JSON.stringify(signedToken)} + '\\n');
    process.stderr.write('HSTACK_REFUSED: postgresql://user:' + ${JSON.stringify(unboundSecret)} + '@host/db\\n');
    process.stderr.write('fixture.ts(1,1): error TS2322: private-source-prose\\n');
    process.stderr.write('[typecheck-inputs] ' + JSON.stringify({ capturedAt: '2026-11-05T11:08:00Z',
      basis: 'selected-project-inputs', changed: Array(2000).fill('node_modules/phosphor-react-native/src/icons/Inventory.tsx') }) + '\\n');
    process.exitCode = 255;
  `);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./typecheckTouched.mjs', import.meta.url)),
    '--baseline', baseline, packagePath, `${packagePath}/touched.ts`], { cwd: repoRoot,
    // This subprocess fixture contains no compiler. Keep its fake package
    // command on the test host, as an already dispatched controller would.
    env: { ...process.env, HAPPIER_TYPECHECK_DISPATCHED: '1', TOUCHED_FAILURE_SECRET: secret },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const status = await new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', resolveResult);
  });
  assert.equal(status, 2, redactFailureDiagnostic(stderr, { TOUCHED_FAILURE_SECRET: secret }));
  assert.ok(stderr.includes('reason=no-complete-diagnostics'), 'compiler failure reason is visible');
  assert.ok(stderr.includes('ERR_PNPM_NO_SCRIPT'), 'package manager stdout failure is visible');
  assert.ok(stderr.includes('HSTACK_ADMISSION_REFUSED: worker unavailable'), 'admission reason is visible');
  assert.ok(stderr.includes('Connection reset by peer'), 'SSH transport reason is visible');
  assert.ok(stderr.includes('ssh_dispatch_run_fatal:'), 'fatal SSH transport reasons are visible');
  assert.ok(stderr.includes('Shared connection to worker closed.'), 'multiplexed SSH closure is visible');
  assert.ok(!`${stdout}${stderr}`.includes(secret), 'credentials stay private');
  assert.ok(!`${stdout}${stderr}`.includes(unboundSecret), 'unknown credential values are redacted');
  assert.ok(!`${stdout}${stderr}`.includes(signedToken), 'signed tokens are redacted');
  assert.ok(!stderr.includes('private-source-prose'), 'compiler fixture prose stays private');
  assert.ok(!stderr.includes('Inventory.tsx'), 'input observations must not displace failure reasons');
  assert.ok(!stderr.includes('discarded-start'), 'earlier stderr is omitted');
  assert.ok(stderr.length < 17000, 'failure output reuses the process diagnostic tail budget');
  assert.ok(!stdout.includes('added: 0'), 'missing evidence never becomes a zero delta');
});
