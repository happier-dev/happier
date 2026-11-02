import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
for (const [script, product] of [
  ['scripts/pipeline/release/publish-ui-web.mjs', []],
  ['scripts/pipeline/release/publishing/publish-binary-release.mjs', ['--product', 'cli']],
]) {
  test(`${script}: standalone false cannot bypass source contracts; admitted proof skips the duplicate`, () => {
    const args = [script, ...product, '--channel', 'preview', '--run-contracts', 'false', '--check-installers', 'false', '--dry-run'];
    const execute = (proof) => execFileSync(process.execPath, args, {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, GH_REPO: 'happier-dev/happier', GH_TOKEN: '',
        HAPPIER_RELEASE_SOURCE_CONTRACTS_RESULT: proof,
        HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({ github: {}, npm: {} }) },
    });
    assert.match(execute(''), /test:release:contracts/);
    assert.match(execute('skipped'), /test:release:contracts/);
    assert.doesNotMatch(execute('success'), /test:release:contracts/);
  });
}


test('shared source contracts consume matching proof and run each missing selected policy once', async (t) => {
  const { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { parse } = await import('yaml');
  const workflow = parse(readFileSync(join(root, '.github/workflows/release-source-validation.yml'), 'utf8'));
  const step = workflow.jobs.source_contracts.steps.find((step) => step.id === 'contracts');
  const scratch = mkdtempSync(join(tmpdir(), 'happier-source-contract-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const command = join(scratch, 'pnpm');
  writeFileSync(command, '#!/bin/sh\nprintf "%s\\n" "$HAPPIER_EMBEDDED_POLICY_ENV" >> "$CALL_LOG"\n');
  chmodSync(command, 0o755);
  writeFileSync(join(scratch, 'yarn'), readFileSync(command)); chmodSync(join(scratch, 'yarn'), 0o755);
  for (const [preview, production, calls] of [['success', 'success', ''], ['success', '', 'production\n'], ['', '', 'preview\nproduction\n']]) {
    const log = join(scratch, 'calls'); const output = join(scratch, 'output');
    writeFileSync(log, ''); writeFileSync(output, '');
    execFileSync('bash', ['-c', step.run], { cwd: root, env: { ...process.env,
      PATH: `${scratch}:${process.env.PATH}`, CALL_LOG: log, GITHUB_OUTPUT: output,
      BASE_REFS: 'preview,main,preview', SOURCE_PROFILE: 'stable',
      PREVIEW_RESULT: preview, PRODUCTION_RESULT: production } });
    assert.equal(readFileSync(log, 'utf8'), calls);
    assert.equal(readFileSync(output, 'utf8'), 'source_contracts_preview=success\nsource_contracts_production=success\n');
  }
});

test('publisher proof is available only to reusable calls and is projected by channel without cross-policy fallback', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { parse } = await import('yaml');
  const workflows = join(root, '.github/workflows');
  const channel = parse(readFileSync(join(workflows, 'release-channel.yml'), 'utf8'));
  for (const job of Object.values(channel.jobs)) {
    if (/workflows\/(publish-(cli-binaries|hstack-binaries|server-runtime|runner-binaries|ui-web)|release-npm)\.yml$/.test(job.uses ?? '')) {
      assert.equal(job.with.source_contracts_result, "${{ inputs[format('shared_source_contracts_{0}', inputs.environment == 'production' && 'production' || 'preview')] }}");
    }
  }
  for (const name of readdirSync(workflows).filter((name) => /^publish-(cli-binaries|hstack-binaries|server-runtime|runner-binaries|ui-web)\.yml$/.test(name))) {
    const workflow = parse(readFileSync(join(workflows, name), 'utf8'));
    assert.equal(workflow.on.workflow_dispatch.inputs.source_contracts_result, undefined);
    assert.equal(workflow.on.workflow_call.inputs.source_contracts_result.default, '');
  }
});
