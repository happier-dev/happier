import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import { parseReleaseManifestV1 } from '@happier-dev/release-runtime/releaseManifest';
import { buildManifestRecord } from './lib/manifests.mjs';

import {
  main,
  resolveCandidateVerificationTargets,
  validateActionsRun,
  validateCandidateManifest,
  validateCandidateIdentityInputs,
  validateResolvedCandidateIdentities,
  validateRunIdentityEvidence,
} from './verify-release-candidate-identity.mjs';
import { validateCandidateVersions } from './lib/rolling-version-allocation.mjs';

const SOURCE_SHA = 'a'.repeat(40);

test('pre-promotion verification checks selected bytes and deployed refs without requiring the channel branch to move early', () => {
  const targets = resolveCandidateVerificationTargets({
    channel: 'production', versions: { cli: '1.2.3' }, verifyChannelRef: false,
    verifyDeploy: { ui: true, server: false, website: false, docs: false },
    verifyRelease: { cli: true, stack: false, server: false, runner: false, 'ui-web': false },
  });
  assert.deepEqual(targets.refs, ['heads/deploy/production/ui']);
  assert.deepEqual(targets.tags, ['cli-v1.2.3']);
});

test('candidate verification derives refs, tags, and manifests from one script-owned release mapping', () => {
  assert.deepEqual(resolveCandidateVerificationTargets({
    channel: 'production',
    versions: {
      cli: '1.2.3',
      stack: '',
      server: '2.3.4',
      runner: '1.2.3',
      'ui-web': '',
    },
    verifyDeploy: {
      ui: true,
      server: true,
      website: false,
      docs: true,
    },
    verifyRelease: {
      cli: true,
      stack: false,
      server: true,
      runner: true,
      'ui-web': true,
    },
  }), {
    refs: [
      'heads/main',
      'heads/deploy/production/ui',
      'heads/deploy/production/server',
      'heads/deploy/production/docs',
    ],
    tags: ['cli-v1.2.3', 'server-v2.3.4', 'runner-v1.2.3', 'ui-web-stable'],
    manifests: [
      { product: 'happier', channel: 'stable', tag: 'cli-v1.2.3' },
      { product: 'happier-server', channel: 'stable', tag: 'server-v2.3.4' },
      { product: 'happier-runner', channel: 'stable', tag: 'runner-v1.2.3' },
    ],
  });

  assert.deepEqual(resolveCandidateVerificationTargets({
    channel: 'dev',
    versions: { cli: '', stack: '0.2.10-dev.14.2', server: '', runner: '', 'ui-web': '' },
    verifyDeploy: { ui: false, server: false, website: false, docs: false },
    verifyRelease: { cli: true, stack: true, server: false, runner: false, 'ui-web': false },
  }), {
    refs: ['heads/dev'],
    tags: ['cli-dev', 'stack-v0.2.10-dev.14.2'],
    manifests: [
      { product: 'happier', channel: 'dev', tag: 'cli-dev' },
      { product: 'hstack', channel: 'dev', tag: 'stack-v0.2.10-dev.14.2' },
    ],
  });
});

test('candidate verification accepts only canonical exact release versions', () => {
  assert.deepEqual(validateCandidateVersions({
    channel: 'dev',
    versions: {
      cli: '0.2.10-dev.57',
      stack: '0.2.10-dev.14.2',
      server: '0.2.10-dev.52',
      runner: '',
      'ui-web': '',
    },
  }), {
    channel: 'publicdev',
    versions: {
      cli: '0.2.10-dev.57',
      stack: '0.2.10-dev.14.2',
      server: '0.2.10-dev.52',
      runner: '',
      'ui-web': '',
    },
  });
  assert.equal(validateCandidateVersions({
    channel: 'preview',
    versions: { 'ui-web': '1.2.3-preview.4' },
  }).channel, 'preview');
  assert.equal(validateCandidateVersions({
    channel: 'production',
    versions: { server: '1.2.3' },
  }).channel, 'stable');

  for (const version of [
    '0.2.10-dev.57; touch /tmp/happier-release-pwned',
    '0.2.10-dev.57\nmalicious_key=$(touch /tmp/happier-release-pwned)',
    '0.2.10-dev.057',
    '0.2.10-preview.57',
  ]) {
    assert.throws(
      () => validateCandidateVersions({
        channel: 'dev',
        versions: { cli: version },
      }),
      /must match|Invalid version/,
      `candidate version must reject non-canonical or malicious input: ${JSON.stringify(version)}`,
    );
  }
});

test('candidate verification main rejects a malicious version before privileged network access', async () => {
  await assert.rejects(
    () => main([
      '--channel', 'dev',
      '--candidate-cli-version', '0.2.10-dev.57; touch /tmp/happier-release-pwned',
    ]),
    /must match 0\.2\.10-dev\.<number>/,
  );
});

test('candidate verification accepts one generic immutable product/version and binds its tag to the source', async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(String(request.url));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ object: { type: 'commit', sha: SOURCE_SHA } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve(undefined)));
  }));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const originalToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token';
  t.after(() => {
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
  });

  await assert.doesNotReject(() => main([
    '--repository', 'happier-dev/happier',
    '--channel', 'dev',
    '--candidate-source-sha', SOURCE_SHA,
    '--candidate-product', 'hstack',
    '--candidate-version', '0.2.10-dev.14.2',
    '--api-base-url', `http://127.0.0.1:${port}`,
  ]));
  assert.deepEqual(requests, [
    '/repos/happier-dev/happier/git/ref/tags/stack-v0.2.10-dev.14.2',
  ]);

  await assert.doesNotReject(() => main([
    '--repository', 'happier-dev/happier',
    '--channel', 'stable',
    '--candidate-source-sha', SOURCE_SHA,
    '--candidate-product', 'cli',
    '--candidate-version', '1.2.3',
    '--api-base-url', `http://127.0.0.1:${port}`,
  ]));
  assert.equal(requests.at(-1), '/repos/happier-dev/happier/git/ref/tags/cli-v1.2.3');

  await assert.rejects(() => main([
    '--repository', 'happier-dev/happier',
    '--channel', 'dev',
    '--candidate-source-sha', SOURCE_SHA,
    '--candidate-product', 'server',
  ]), /candidate-product.*candidate-version.*together/);
});

test('candidate verification keeps build and publication run identities distinct', () => {
  assert.deepEqual(validateCandidateIdentityInputs({
    repository: 'happier-dev/happier',
    candidateSourceSha: SOURCE_SHA,
    candidateBuildRunId: '123',
    cliCandidateBuildRunId: '',
    publicationRunId: '456',
    currentRunId: '456',
    refs: ['heads/main', 'heads/deploy/production/server'],
    tags: ['cli-stable'],
    manifests: [{ product: 'happier', channel: 'stable', tag: 'cli-stable' }],
  }), {
    repository: 'happier-dev/happier',
    candidateSourceSha: SOURCE_SHA,
    candidateBuildRunId: 123,
    cliCandidateBuildRunId: 123,
    publicationRunId: 456,
    currentRunId: 456,
    refs: ['heads/main', 'heads/deploy/production/server'],
    tags: ['cli-stable'],
    manifests: [{ product: 'happier', channel: 'stable', tag: 'cli-stable' }],
  });
});

test('candidate verification rejects malformed or missing run identity input', () => {
  assert.throws(() => validateCandidateIdentityInputs({
    repository: 'happier-dev/happier',
    candidateSourceSha: SOURCE_SHA,
    candidateBuildRunId: 'run-123',
    publicationRunId: '456',
    currentRunId: '456',
    refs: [],
    tags: [],
    manifests: [],
  }), /build run ID/);
  assert.throws(() => validateCandidateIdentityInputs({
    repository: 'happier-dev/happier',
    candidateSourceSha: SOURCE_SHA,
    candidateBuildRunId: '123',
    publicationRunId: '',
    currentRunId: '456',
    refs: [],
    tags: [],
    manifests: [],
  }), /publication run ID/);
  const mismatched = validateCandidateIdentityInputs({
    repository: 'happier-dev/happier',
    candidateSourceSha: SOURCE_SHA,
    candidateBuildRunId: '123',
    publicationRunId: '999',
    currentRunId: '456',
    refs: [],
    tags: [],
    manifests: [],
  });
  assert.throws(
    () => validateRunIdentityEvidence(mismatched),
    /external build or publication run IDs require a published manifest relation/,
  );

  const unrelatedCliBuild = validateCandidateIdentityInputs({
    repository: 'happier-dev/happier',
    candidateSourceSha: SOURCE_SHA,
    candidateBuildRunId: '456',
    cliCandidateBuildRunId: '123',
    publicationRunId: '456',
    currentRunId: '456',
    refs: [],
    tags: [],
    manifests: [{ product: 'hstack', channel: 'preview', tag: 'stack-preview' }],
  });
  assert.throws(
    () => validateRunIdentityEvidence(unrelatedCliBuild),
    /external CLI build run ID requires a published CLI manifest relation/,
  );
});

test('candidate verification rejects arbitrary or unsuccessful Actions run identities', () => {
  const trusted = {
    id: 123,
    status: 'completed',
    conclusion: 'success',
    path: '.github/workflows/publish-cli-binaries.yml@main',
    repository: { full_name: 'happier-dev/happier' },
  };
  assert.doesNotThrow(() => validateActionsRun(trusted, {
    repository: 'happier-dev/happier',
    runId: 123,
    currentRunId: 456,
    label: 'build',
    expectedWorkflowPaths: ['.github/workflows/publish-cli-binaries.yml'],
  }));
  assert.throws(() => validateActionsRun({ ...trusted, id: 999 }, {
    repository: 'happier-dev/happier',
    runId: 123,
    currentRunId: 456,
    label: 'build',
    expectedWorkflowPaths: ['.github/workflows/publish-cli-binaries.yml'],
  }), /build workflow run ID/);
  assert.throws(() => validateActionsRun({ ...trusted, conclusion: 'failure' }, {
    repository: 'happier-dev/happier',
    runId: 123,
    currentRunId: 456,
    label: 'build',
    expectedWorkflowPaths: ['.github/workflows/publish-cli-binaries.yml'],
  }), /successful completed run/);

  assert.doesNotThrow(() => validateActionsRun({
    ...trusted,
    id: 456,
    status: 'in_progress',
    conclusion: null,
    path: '.github/workflows/release.yml@main',
  }, {
    repository: 'happier-dev/happier',
    runId: 456,
    currentRunId: 456,
    label: 'publication',
    expectedWorkflowPaths: ['.github/workflows/release.yml'],
  }));
  assert.throws(() => validateActionsRun({
    ...trusted,
    id: 456,
    status: 'in_progress',
    conclusion: null,
    path: '.github/workflows/release-verify.yml@main',
  }, {
    repository: 'happier-dev/happier',
    runId: 456,
    currentRunId: 456,
    label: 'publication',
    expectedWorkflowPaths: ['.github/workflows/release.yml', '.github/workflows/nightly-dev.yml'],
  }), /unexpected workflow path/);
});

test('published manifest must bind source, build run, and publication run identities', () => {
  const expected = {
    product: 'happier',
    channel: 'stable',
    candidateSourceSha: SOURCE_SHA,
    candidateBuildRunId: 123,
    publicationRunId: 456,
  };
  const record = {
    product: 'happier',
    channel: 'stable',
    build: { commitSha: SOURCE_SHA, workflowRunId: '123' },
    publication: { workflowRunId: '456' },
  };
  const manifest = { product: 'happier', channel: 'stable', records: [record] };
  assert.doesNotThrow(() => validateCandidateManifest(manifest, expected));
  assert.throws(
    () => validateCandidateManifest({
      ...manifest,
      records: [{ ...record, build: { ...record.build, commitSha: 'b'.repeat(40) } }],
    }, expected),
    /source SHA/,
  );
  assert.throws(
    () => validateCandidateManifest({
      ...manifest,
      records: [{ ...record, build: { ...record.build, workflowRunId: '999' } }],
    }, expected),
    /build workflow run ID/,
  );
  assert.throws(
    () => validateCandidateManifest({
      ...manifest,
      records: [{ ...record, publication: { workflowRunId: '999' } }],
    }, expected),
    /publication workflow run ID/,
  );
});

test('resolved deploy refs and artifact tags must all identify the exact candidate SHA', () => {
  assert.doesNotThrow(() => validateResolvedCandidateIdentities({
    candidateSourceSha: SOURCE_SHA,
    resolved: [
      { kind: 'ref', name: 'heads/main', sha: SOURCE_SHA },
      { kind: 'tag', name: 'cli-stable', sha: SOURCE_SHA },
    ],
  }));
  assert.throws(() => validateResolvedCandidateIdentities({
    candidateSourceSha: SOURCE_SHA,
    resolved: [
      { kind: 'ref', name: 'heads/main', sha: SOURCE_SHA },
      { kind: 'tag', name: 'cli-stable', sha: 'b'.repeat(40) },
    ],
  }), /cli-stable.*candidate source SHA/);
});

test('candidate verification main rejects published manifest run substitution', async (t) => {
  const manifest = {
    product: 'happier',
    channel: 'stable',
    records: [{
      product: 'happier',
      channel: 'stable',
      build: { commitSha: SOURCE_SHA, workflowRunId: '999' },
      publication: { workflowRunId: '456' },
    }],
  };
  /** @type {import('node:http').Server} */
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
    const payload = request.url === '/repos/happier-dev/happier/actions/runs/456'
      ? {
          id: 456,
          status: 'in_progress',
          conclusion: null,
          path: '.github/workflows/release.yml@main',
          repository: { full_name: 'happier-dev/happier' },
        }
      : request.url === '/repos/happier-dev/happier/git/ref/heads/main'
        ? { object: { type: 'commit', sha: SOURCE_SHA } }
        : request.url === '/repos/happier-dev/happier/releases/tags/cli-stable'
          ? { assets: [{ name: 'latest.json', browser_download_url: `${origin}/assets/latest.json` }] }
          : request.url === '/assets/latest.json'
            ? manifest
            : null;
    response.statusCode = payload ? 200 : 404;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(payload ?? { message: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve(undefined)));
  }));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const originalToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token';
  t.after(() => {
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
  });

  await assert.rejects(() => main([
    '--repository', 'happier-dev/happier',
    '--channel', 'production',
    '--candidate-source-sha', SOURCE_SHA,
    '--candidate-build-run-id', '456',
    '--publication-run-id', '456',
    '--current-run-id', '456',
    '--refs', 'heads/main',
    '--tags', '',
    '--manifests', 'happier:stable:cli-stable',
    '--api-base-url', `http://127.0.0.1:${port}`,
  ]), /build workflow run ID/);
});

test('candidate verification rechecks an admitted retained product without assigning the new run to its manifest', async (t) => {
  // This is the same buildManifestRecord -> parseReleaseManifestV1 shape emitted by publish-manifests.
  const manifest = parseReleaseManifestV1({
    schemaVersion: 'v1', product: 'hstack', channel: 'preview', version: '0.3.0-preview.73',
    publishedAt: '2026-10-02T00:00:00.000Z',
    records: [buildManifestRecord({
      product: 'hstack', channel: 'preview', version: '0.3.0-preview.73',
      os: 'linux', arch: 'x64', url: 'https://example.test/hstack-v0.3.0-preview.73-linux-x64.tar.gz',
      sha256: 'c'.repeat(64), signature: 'https://example.test/checksums-hstack-v0.3.0-preview.73.txt.minisig',
      publishedAt: '2026-10-02T00:00:00.000Z', commitSha: SOURCE_SHA,
      buildWorkflowRunId: '123', publicationWorkflowRunId: '123',
    })],
  });
  // GitHub is the boundary; real Ed25519 signatures exercise the canonical trust owner.
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = Buffer.alloc(8, 3);
  const comment = Buffer.from('retained release fixture');
  const directory = await mkdtemp(join(tmpdir(), 'happier-retained-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const publicKeyPath = join(directory, 'release.pub');
  await writeFile(publicKeyPath, `untrusted comment: fixture\n${Buffer.concat([
    Buffer.from('Ed'), keyId, publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
  ]).toString('base64')}`);
  let mutation = '';
  let retainedConclusion = 'failure';
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.url?.startsWith('/assets/')) {
      const payload = JSON.stringify({ ...manifest, ...(mutation === 'product' ? { product: 'happier' } : {}),
            ...(mutation === 'channel' ? { channel: 'stable' } : {}),
            ...(mutation === 'version' ? { version: '0.3.0-preview.74' } : {}),
            ...(mutation === 'top-version' ? { version: '0.3.0-preview.74' } : {}),
            ...(mutation === 'schema' ? { schemaVersion: 'v2' } : {}),
            records: manifest.records.map((record) => ({ ...record,
              ...(mutation === 'product' ? { product: 'happier' } : {}),
              ...(mutation === 'channel' ? { channel: 'stable' } : {}),
              ...(mutation === 'version' ? { version: '0.3.0-preview.74' } : {}),
              ...(mutation === 'source' ? { build: { ...record.build, commitSha: 'b'.repeat(40) } } : {}),
              ...(mutation === 'rolling' && request.url.includes('rolling') ? { publication: { workflowRunId: '999' } } : {}),
            })) });
      const envelope = `${createHash('sha256').update(payload).digest('hex')}  latest.json\n`;
      const signed = sign(null, Buffer.from(envelope), privateKey);
      const signedEnvelope = ['untrusted comment: fixture',
        Buffer.concat([Buffer.from('Ed'), keyId, signed]).toString('base64'),
        `trusted comment: ${comment}`, sign(null, Buffer.concat([signed, comment]), privateKey).toString('base64')].join('\n');
      response.end(request.url.endsWith('.minisig') ? (mutation === 'signature' ? 'invalid signature' : signedEnvelope)
        : request.url.endsWith('.txt') ? envelope : payload);
      return;
    }
    const payload = request.url === '/repos/happier-dev/happier/actions/runs/456'
      ? { id: 456, status: mutation === 'current-failed' ? 'completed' : 'in_progress',
          conclusion: mutation === 'current-failed' ? 'failure' : null,
          path: '.github/workflows/release.yml@preview', repository: { full_name: 'happier-dev/happier' } }
      : request.url === '/repos/happier-dev/happier/git/ref/heads/preview'
        || request.url === '/repos/happier-dev/happier/git/ref/tags/stack-preview'
        || request.url === '/repos/happier-dev/happier/git/ref/tags/stack-v0.3.0-preview.73'
        ? { object: { type: 'commit', sha: SOURCE_SHA } }
        : request.url === '/repos/happier-dev/happier/actions/runs/123'
          ? { id: 123, status: mutation === 'prior-active' ? 'in_progress' : 'completed', conclusion: retainedConclusion,
              path: mutation === 'workflow' ? '.github/workflows/tests.yml'
                : mutation === 'dedicated' ? '.github/workflows/publish-hstack-binaries.yml' : '.github/workflows/release.yml@preview',
              repository: { full_name: mutation === 'repository' ? 'attacker/happier' : 'happier-dev/happier' } }
          : request.url?.startsWith('/repos/happier-dev/happier/releases/tags/stack-')
            ? { assets: ['latest.json', 'checksums-hstack-v0.3.0-preview.73.txt', 'checksums-hstack-v0.3.0-preview.73.txt.minisig']
                .map((name) => ({ name, browser_download_url: `${origin}/assets/${request.url.endsWith('stack-preview') ? 'rolling' : 'immutable'}/${name}` })) }
            : null;
    response.statusCode = payload ? 200 : 404;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const originalToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token';
  t.after(() => {
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
  });
  const args = [
    '--repository', 'happier-dev/happier', '--channel', 'preview',
    '--candidate-source-sha', SOURCE_SHA,
    '--candidate-build-run-id', '456', '--publication-run-id', '456', '--current-run-id', '456',
    '--refs', 'heads/preview', '--tags', 'stack-preview', '--manifests', 'hstack:preview:stack-preview',
    '--api-base-url', `http://127.0.0.1:${server.address().port}`,
    '--retained-stack-version', '0.3.0-preview.73', '--public-key', publicKeyPath,
  ];
  await assert.doesNotReject(() => main(args));
  retainedConclusion = 'cancelled';
  await assert.doesNotReject(() => main(args),
    'the existing v1 resume reader admits completed cancelled aggregates with a successful exact signed product');
  retainedConclusion = 'failure';
  for (const [failure, expected] of [
    ['product', /manifest identity/], ['channel', /manifest identity/], ['source', /source SHA/],
    ['version', /manifest version/], ['signature', /checksums_signature_invalid/],
    ['workflow', /unexpected workflow path/], ['repository', /repository does not match/],
    ['dedicated', /successful completed run/],
    ['prior-active', /retained workflow run must be completed/],
    ['rolling', /rolling manifest does not match/],
  ]) {
    mutation = failure;
    await assert.rejects(() => main(args), expected, failure);
  }
  mutation = '';
  await assert.rejects(() => main(args.slice(0, -4)), /build workflow run ID/,
    'without an admitted retained version a fresh product must still identify the current run');
  mutation = 'current-failed';
  await assert.rejects(() => main(args), /current build workflow run is not active or successful/,
    'retained product evidence must not admit a failed current orchestrator');
  for (const [failure, expected] of [
    ['top-version', /release manifest.*record identity mismatch/],
    ['schema', /release manifest.*unsupported identity/],
  ]) {
    mutation = failure;
    await assert.rejects(() => main(args), expected,
      `a correctly signed ${failure} violation must be rejected by the canonical published-manifest parser`);
  }
});

test('candidate verification uses an explicit prior build run only for the CLI manifest', async (t) => {
  const manifests = {
    '/assets/cli-latest.json': {
      product: 'happier',
      channel: 'preview',
      records: [{
        product: 'happier',
        channel: 'preview',
        build: { commitSha: SOURCE_SHA, workflowRunId: '123' },
        publication: { workflowRunId: '456' },
      }],
    },
    '/assets/stack-latest.json': {
      product: 'hstack',
      channel: 'preview',
      records: [{
        product: 'hstack',
        channel: 'preview',
        build: { commitSha: SOURCE_SHA, workflowRunId: '456' },
        publication: { workflowRunId: '456' },
      }],
    },
  };
  const trustedCliRun = {
    id: 123,
    status: 'completed',
    conclusion: 'success',
    event: 'workflow_dispatch',
    path: '.github/workflows/publish-cli-binaries.yml',
    head_branch: 'preview',
    head_sha: SOURCE_SHA,
    repository: { full_name: 'happier-dev/happier' },
    head_repository: { full_name: 'happier-dev/happier' },
  };
  let cliRun = trustedCliRun;
  let releaseRun = {
    id: 456,
    status: 'in_progress',
    conclusion: null,
    path: '.github/workflows/release.yml@preview',
    repository: { full_name: 'happier-dev/happier' },
  };
  /** @type {import('node:http').Server} */
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
    const payload = request.url === '/repos/happier-dev/happier/actions/runs/123'
      ? cliRun
      : request.url === '/repos/happier-dev/happier/actions/runs/456'
        ? releaseRun
        : request.url === '/repos/happier-dev/happier/git/ref/heads/preview'
          ? { object: { type: 'commit', sha: SOURCE_SHA } }
          : request.url === '/repos/happier-dev/happier/releases/tags/cli-preview'
            ? { assets: [{ name: 'latest.json', browser_download_url: `${origin}/assets/cli-latest.json` }] }
            : request.url === '/repos/happier-dev/happier/releases/tags/stack-preview'
              ? { assets: [{ name: 'latest.json', browser_download_url: `${origin}/assets/stack-latest.json` }] }
              : manifests[/** @type {keyof typeof manifests} */ (request.url ?? '')] ?? null;
    response.statusCode = payload ? 200 : 404;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(payload ?? { message: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve(undefined)));
  }));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const originalToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token';
  t.after(() => {
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
  });

  const verificationArgs = [
    '--repository', 'happier-dev/happier',
    '--channel', 'preview',
    '--candidate-source-sha', SOURCE_SHA,
    '--candidate-build-run-id', '456',
    '--cli-candidate-build-run-id', '123',
    '--publication-run-id', '456',
    '--current-run-id', '456',
    '--refs', 'heads/preview',
    '--tags', '',
    '--manifests', 'happier:preview:cli-preview,hstack:preview:stack-preview',
    '--api-base-url', `http://127.0.0.1:${port}`,
  ];
  await assert.doesNotReject(() => main(verificationArgs));

  for (const [label, overrides, expected] of [
    ['fork repository', { head_repository: { full_name: 'attacker/happier' } }, /head repository/],
    ['workflow context ref suffix', { path: '.github/workflows/publish-cli-binaries.yml@other' }, /workflow path/],
    ['cross-channel head branch', { head_branch: 'other' }, /head branch/],
    ['non-dispatch event', { event: 'pull_request' }, /workflow_dispatch/],
    ['different source SHA', { head_sha: 'b'.repeat(40) }, /head SHA/],
    ['failed dedicated CLI build', { status: 'completed', conclusion: 'failure' }, /successful completed run/],
  ]) {
    cliRun = { ...trustedCliRun, ...overrides };
    await assert.rejects(
      () => main(verificationArgs),
      expected,
      `release verification must reject prior CLI provenance from a ${label}`,
    );
  }

  const inheritedCliBuildArgs = [
    '--repository', 'happier-dev/happier',
    '--channel', 'preview',
    '--candidate-source-sha', SOURCE_SHA,
    '--candidate-build-run-id', '123',
    '--cli-candidate-build-run-id', '',
    '--publication-run-id', '456',
    '--current-run-id', '456',
    '--refs', 'heads/preview',
    '--tags', '',
    '--manifests', 'happier:preview:cli-preview',
    '--api-base-url', `http://127.0.0.1:${port}`,
  ];
  cliRun = trustedCliRun;
  await assert.doesNotReject(() => main(inheritedCliBuildArgs));
  cliRun = { ...trustedCliRun, event: 'pull_request' };
  await assert.rejects(
    () => main(inheritedCliBuildArgs),
    /workflow_dispatch/,
    'the defaulted CLI build identity must not bypass strict provenance admission',
  );

  for (const workflowPath of [
    '.github/workflows/publish-hstack-binaries.yml',
    '.github/workflows/publish-server-runtime.yml',
  ]) {
    cliRun = {
      ...trustedCliRun,
      path: `${workflowPath}@preview`,
    };
    await assert.rejects(
      () => main(inheritedCliBuildArgs),
      /candidate build workflow is not valid for a CLI manifest/,
      `a same-ID ${workflowPath} run must not attest CLI provenance`,
    );
  }

  manifests['/assets/cli-latest.json'].records[0].build.workflowRunId = '456';
  releaseRun = {
    ...releaseRun,
    status: 'completed',
    conclusion: 'success',
  };
  await assert.doesNotReject(() => main([
    '--repository', 'happier-dev/happier',
    '--channel', 'preview',
    '--candidate-source-sha', SOURCE_SHA,
    '--candidate-build-run-id', '456',
    '--cli-candidate-build-run-id', '',
    '--publication-run-id', '456',
    '--current-run-id', '789',
    '--refs', 'heads/preview',
    '--tags', '',
    '--manifests', 'happier:preview:cli-preview',
    '--api-base-url', `http://127.0.0.1:${port}`,
  ]));
});
