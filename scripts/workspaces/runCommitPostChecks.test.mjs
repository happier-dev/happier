import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const sidecar = new URL('../../.project/scripts/p03/cw-head/', import.meta.url);
const hasSidecar = existsSync(new URL('scanrev.sh', sidecar));

test('post-commit export attribution confirms apparent new rows at the exact parent', {
  skip: process.platform === 'win32' || (!hasSidecar && 'post-commit export tooling is not installed'),
}, async t => {
  const repo = await mkdtemp(join(tmpdir(), 'broad-export-parent-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'parent');
  await writeFile(join(repo, 'README.md'), 'Unrelated change.\n');
  git('add', 'README.md');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'child');
  const parent = git('rev-parse', 'HEAD^');
  const head = git('rev-parse', 'HEAD');
  const workspaceScripts = join(repo, 'scripts/workspaces');
  const tools = join(repo, '.project/scripts/p03/cw-head');
  await mkdir(workspaceScripts, { recursive: true });
  await mkdir(join(tools, 'scan'), { recursive: true });
  const runner = join(workspaceScripts, 'runCommitPostChecks.sh');
  await cp(new URL('./runCommitPostChecks.sh', import.meta.url), runner);
  await writeFile(join(workspaceScripts, 'commitGate.mjs'), '');
  await writeFile(join(tools, 'bundlegate.mjs'), 'console.log("TOTAL 0");\n');
  for (const script of ['cache.sh', 'compare.sh', 'scanrev.sh']) await cp(new URL(script, sidecar), join(tools, script));

  // The two rows reported against 56ab2558e99 also exist in fb4d0a3ce24.
  const walkthrough = 'apps/cli/src/agent/runtime/bridges/executionRun/messages/sessionStateEmission.test.ts';
  const deepsec = 'apps/cli/src/daemon/agentRuntime/runnerDaemonPluginServicesHost.connectedAccounts.test.ts';
  const inherited = [
    `${walkthrough}\t../../../../../../../ui/sources/components/sessions/files/walkthrough/walkthroughStopExchangesModel\t\tMODULE_MISSING_AT_HEAD\t[projectWalkthroughStopExchanges]`,
    `${deepsec}\t../../../../../packages/plugins/review-deepsec/src/agent/connectedAccount\t\tMODULE_MISSING_AT_HEAD\t[DEEPSEC_CLAUDE_ACCOUNT_PURPOSE]`,
  ];
  const added = `${walkthrough}\t./anotherModule\t\tMODULE_MISSING_AT_HEAD\t[anotherExport]`;
  // Keep the real scan cache reader. Simulate a cache that omitted both parent findings.
  const cache = join(repo, 'scan-cache');
  await mkdir(cache);
  const common = 'apps/cli/src/existing.ts\t./existing\t\tMODULE_MISSING_AT_HEAD\t[x]\n';
  const parentTree = git('rev-parse', `${parent}^{tree}`);
  const headTree = git('rev-parse', `${head}^{tree}`);
  await writeFile(join(cache, `scan-v2-T${parentTree}.txt`), common);
  await writeFile(join(cache, `scanidx-v2-T${parentTree}.gz`), '');
  await writeFile(join(cache, `scanidx-v2-T${headTree}.gz`), '');
  await writeFile(join(tools, 'scan/scan.cjs'), `
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
assert.equal(process.env.REV, '${parent}');
assert.equal(process.env.EXACT, '1');
assert.deepEqual(readFileSync(process.argv[3], 'utf8').trim().split('\\n').sort(), ${JSON.stringify([walkthrough, deepsec].sort())});
if (process.env.FIXTURE_UNAVAILABLE === '1') process.exit(2);
for (const row of ${JSON.stringify(inherited)}) {
  console.log(row.replace('\\t', ':27\\t'));
}
`);
  const run = async (rows, unavailable = 0) => {
    await writeFile(join(cache, `scan-v2-T${headTree}.txt`), common + rows.join('\n') + '\n');
    return spawnSync('bash', [runner, '--bundle', parent, head], {
      cwd: repo, encoding: 'utf8', env: { ...process.env, P03_GATE_CACHE: cache, FIXTURE_UNAVAILABLE: String(unavailable) },
    });
  };
  const preexisting = await run(inherited);
  assert.equal(preexisting.status, 0, preexisting.stdout + preexisting.stderr);
  assert.match(preexisting.stdout, /pre-existing/iu);
  for (const row of inherited) assert.ok(preexisting.stdout.split('\n').includes(row), row);
  assert.doesNotMatch(preexisting.stdout, /HAPPIER_POST_COMMIT_FAILURE/u);

  const introduced = await run([...inherited, added]);
  assert.equal(introduced.status, 10, introduced.stdout + introduced.stderr);
  assert.ok(introduced.stdout.includes(`HAPPIER_POST_COMMIT_FAILURE\tExport scan\t${walkthrough}\t${added}\n`));
  const incomplete = await run(inherited, 1);
  assert.equal(incomplete.status, 75, incomplete.stdout + incomplete.stderr);
  assert.doesNotMatch(incomplete.stdout, /HAPPIER_POST_COMMIT_FAILURE/u);
});
