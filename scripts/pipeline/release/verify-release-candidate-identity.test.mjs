import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  main,
  validateCandidateVersions,
} from './verify-release-candidate-identity.mjs';

const SOURCE_SHA = 'a'.repeat(40);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

test('candidate identity accepts only canonical exact versions for the requested lane', () => {
  assert.deepEqual(validateCandidateVersions({
    channel: 'dev',
    versions: {
      cli: '0.2.10-dev.57',
      stack: '0.2.10-dev.14.2',
      server: '',
      'ui-web': '0.2.10-dev.52',
    },
  }), {
    channel: 'publicdev',
    versions: {
      cli: '0.2.10-dev.57',
      stack: '0.2.10-dev.14.2',
      server: '',
      'ui-web': '0.2.10-dev.52',
    },
  });

  for (const version of [
    '0.2.10-dev.57; touch /tmp/happier-release-pwned',
    '0.2.10-dev.57\nmalicious_key=value',
    '0.2.10-dev.057',
    '0.2.10-preview.57',
  ]) {
    assert.throws(
      () => validateCandidateVersions({ channel: 'dev', versions: { cli: version } }),
      /must match|Invalid version/,
    );
  }
});

test('candidate identity validates versions before token or network requirements', async () => {
  await assert.rejects(
    () => main([
      '--repository', 'happier-dev/happier',
      '--channel', 'dev',
      '--candidate-source-sha', SOURCE_SHA,
      '--candidate-cli-version', '0.2.10-dev.57; touch /tmp/happier-release-pwned',
    ], {}),
    /must match 0\.2\.10-dev\.<number>/,
  );
});

test('candidate identity accepts one canonical product/version pair for reusable candidate admission', async () => {
  await assert.rejects(
    () => main([
      '--repository', 'happier-dev/happier',
      '--channel', 'dev',
      '--candidate-source-sha', SOURCE_SHA,
      '--candidate-product', 'hstack',
      '--candidate-version', '0.2.10-dev.14.2',
    ], {}),
    /GITHUB_TOKEN is required/,
  );

  await assert.rejects(
    () => main([
      '--repository', 'happier-dev/happier',
      '--channel', 'dev',
      '--candidate-source-sha', SOURCE_SHA,
      '--candidate-product', 'cli',
      '--candidate-version', '0.2.10-preview.7',
    ], {}),
    /must match/,
  );
});

test('candidate identity accepts the stable leaf-workflow channel for production resume admission', async () => {
  await assert.rejects(
    () => main([
      '--repository', 'happier-dev/happier',
      '--channel', 'stable',
      '--candidate-source-sha', SOURCE_SHA,
      '--candidate-product', 'server',
      '--candidate-version', '0.2.10',
    ], {}),
    /GITHUB_TOKEN is required/,
  );
});

test('candidate identity resolves annotated and lightweight immutable tags to the expected commit', async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(String(request.url));
    response.setHeader('content-type', 'application/json');
    if (request.url?.endsWith('/git/ref/tags/cli-v0.2.10-dev.57')) {
      response.end(JSON.stringify({ object: { type: 'tag', sha: 'b'.repeat(40) } }));
      return;
    }
    if (request.url?.endsWith(`/git/tags/${'b'.repeat(40)}`)) {
      response.end(JSON.stringify({ object: { type: 'commit', sha: SOURCE_SHA } }));
      return;
    }
    if (request.url?.endsWith('/git/ref/tags/server-v0.2.10-dev.52')) {
      response.end(JSON.stringify({ object: { type: 'commit', sha: SOURCE_SHA } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'not found' }));
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const result = await main([
    '--repository', 'happier-dev/happier',
    '--channel', 'dev',
    '--candidate-source-sha', SOURCE_SHA,
    '--candidate-cli-version', '0.2.10-dev.57',
    '--candidate-server-version', '0.2.10-dev.52',
    '--api-base-url', `http://127.0.0.1:${address.port}`,
  ], { GITHUB_TOKEN: 'test-token' });

  assert.deepEqual(result.resolved.map(({ tag, sha }) => ({ tag, sha })), [
    { tag: 'cli-v0.2.10-dev.57', sha: SOURCE_SHA },
    { tag: 'server-v0.2.10-dev.52', sha: SOURCE_SHA },
  ]);
  assert.equal(requests.length, 3);

  await assert.rejects(
    () => main([
      '--repository', 'happier-dev/happier',
      '--channel', 'dev',
      '--candidate-source-sha', 'c'.repeat(40),
      '--candidate-cli-version', '0.2.10-dev.57',
      '--api-base-url', `http://127.0.0.1:${address.port}`,
    ], { GITHUB_TOKEN: 'test-token' }),
    /does not identify the candidate source SHA/,
  );
});

test('immutable candidate verification rejects a tag retargeted while assets are downloaded', async (t) => {
  const actionSource = await readFile(
    join(repoRoot, '.github', 'actions', 'verify-immutable-release-candidate', 'action.yml'),
    'utf8',
  );
  const identityObservations = actionSource.match(/^\s*verify_candidate_tag_identity\s*$/gm)?.length ?? 0;
  let tagReads = 0;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url?.endsWith('/git/ref/tags/cli-v0.2.10-dev.57')) {
      tagReads += 1;
      response.end(JSON.stringify({
        object: {
          type: 'commit',
          sha: tagReads === 1 ? SOURCE_SHA : 'c'.repeat(40),
        },
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'not found' }));
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  await assert.rejects(
    async () => {
      for (let observation = 0; observation < identityObservations; observation += 1) {
        await main([
          '--repository', 'happier-dev/happier',
          '--channel', 'dev',
          '--candidate-source-sha', SOURCE_SHA,
          '--candidate-product', 'cli',
          '--candidate-version', '0.2.10-dev.57',
          '--api-base-url', `http://127.0.0.1:${address.port}`,
        ], { GITHUB_TOKEN: 'test-token' });
      }
    },
    /does not identify the candidate source SHA/,
  );
  assert.equal(tagReads, 2, 'the immutable tag must be observed before and after artifact download');
});
