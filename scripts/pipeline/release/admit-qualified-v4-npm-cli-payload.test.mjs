import assert from 'node:assert/strict';
import test from 'node:test';

import {
  admitQualifiedV4NpmCliPayload,
  resolveQualifiedV4NpmCliPayloadAdmission,
} from './admit-qualified-v4-npm-cli-payload.mjs';

const sourceSha = 'a'.repeat(40);

test('npm Qualified V4 admission maps only the supported npm release rings', () => {
  assert.deepEqual(resolveQualifiedV4NpmCliPayloadAdmission({
    channel: 'preview',
    sourceRef: 'HEAD',
    sourceSha,
  }), {
    channel: 'preview',
    deployEnvironment: 'preview',
    deployBranch: 'deploy/preview/server',
    sourceRef: 'HEAD',
    sourceSha,
  });
  assert.throws(() => resolveQualifiedV4NpmCliPayloadAdmission({
    channel: 'dev',
    sourceRef: 'HEAD',
    sourceSha,
  }), /--channel/);
});

test('source admission verifies the checked-out release source before resolving its deployed baseline', async () => {
  const calls = [];
  let admissionArgs = null;
  const result = await admitQualifiedV4NpmCliPayload({
    channel: 'production',
    sourceRef: 'HEAD',
    sourceSha,
    summaryFile: '/tmp/summary',
  }, {
    repoRoot: '/repo',
    runGit(args, options) {
      calls.push({ args, options });
      if (args[0] === 'rev-parse') return { status: 0, stdout: `${sourceSha}\n` };
      if (args[0] === 'ls-remote') return { status: 0, stdout: '' };
      return { status: 0, stdout: '' };
    },
    async runAdmission(argv) {
      admissionArgs = argv;
      return { status: 'post-activation-compatible' };
    },
  });

  assert.deepEqual(calls.map(({ args }) => args), [
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    ['ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/deploy/production/server'],
    ['fetch', '--no-tags', 'origin', 'refs/heads/deploy/production/server:refs/qualified-v4-payload-baseline'],
  ]);
  assert.deepEqual(admissionArgs, [
    '--repo-root', '/repo',
    '--admission-kind', 'payload-publication',
    '--baseline-ref', 'refs/qualified-v4-payload-baseline',
    '--candidate-ref', 'HEAD',
    '--summary-file', '/tmp/summary',
  ]);
  assert.equal(result.result.status, 'post-activation-compatible');
});

test('admission rejects a checkout that is not the release source before reading the baseline', async () => {
  const calls = [];
  await assert.rejects(
    admitQualifiedV4NpmCliPayload({
      channel: 'preview',
      sourceRef: 'HEAD',
      sourceSha,
    }, {
      repoRoot: '/repo',
      runGit(args) {
        calls.push(args);
        return { status: 0, stdout: `${'b'.repeat(40)}\n` };
      },
      async runAdmission() {
        throw new Error('must not reach domain admission');
      },
    }),
    /expected release source SHA/,
  );
  assert.deepEqual(calls, [['rev-parse', '--verify', 'HEAD^{commit}']]);
});
