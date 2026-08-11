import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLocalCandidateCommands,
  parseCandidateVersions,
} from './execute-local-candidates.mjs';

const SHA = 'a'.repeat(40);

test('local candidate execution uses the same immutable, verification, and rolling phase owners as hosted workflows', () => {
  assert.deepEqual(parseCandidateVersions('cli=1.2.3-preview.4,server=2.3.4-preview.5'), {
    cli: '1.2.3-preview.4',
    server: '2.3.4-preview.5',
  });

  const commands = buildLocalCandidateCommands({
    channel: 'preview',
    sourceSha: SHA,
    repository: 'happier-dev/happier',
    candidates: {
      cli: '1.2.3-preview.4',
      server: '2.3.4-preview.5',
    },
    phase: 'all',
    releaseMessage: 'Preview candidate',
  });

  assert.deepEqual(commands.map((command) => command.stage), [
    'publish-immutable:cli',
    'publish-immutable:server',
    'verify:cli',
    'verify:server',
    'promote-rolling:cli',
    'promote-rolling:server',
  ]);
  assert.match(commands[0].args.join(' '), /publish-cli-binaries\.mjs .*--phase publish-immutable/);
  assert.match(commands[1].args.join(' '), /publish-server-runtime\.mjs .*--phase publish-immutable/);
  assert.match(commands[2].args.join(' '), /verify-release-candidate-identity\.mjs .*--candidate-product cli/);
  assert.match(commands[4].args.join(' '), /publish-cli-binaries\.mjs .*--phase promote-rolling/);
  assert.ok(commands.every((command) => command.args.includes(SHA)));
  assert.deepEqual(
    commands.slice(0, 2).map((command) => command.args.slice(command.args.indexOf('--run-contracts') + 1)[0]),
    ['true', 'false'],
    'shared release contracts should run once per local batch rather than once per product',
  );
});

test('local candidate execution supports isolated reruns without rebuilding successful phases', () => {
  const verifyOnly = buildLocalCandidateCommands({
    channel: 'stable',
    sourceSha: SHA,
    repository: 'happier-dev/happier',
    candidates: { 'ui-web': '1.2.3' },
    phase: 'verify',
    releaseMessage: '',
  });
  assert.deepEqual(verifyOnly.map((command) => command.stage), ['verify:ui-web']);

  const promoteOnly = buildLocalCandidateCommands({
    channel: 'stable',
    sourceSha: SHA,
    repository: 'happier-dev/happier',
    candidates: { stack: '1.2.3' },
    phase: 'promote-rolling',
    releaseMessage: '',
  });
  assert.deepEqual(promoteOnly.map((command) => command.stage), ['promote-rolling:stack']);
  assert.ok(promoteOnly[0].args.includes('true'), 'stable promotion must carry explicit stable admission');
});

test('local candidate execution rejects ambiguous or unsupported candidate input', () => {
  assert.throws(() => parseCandidateVersions('cli=1.2.3,cli=1.2.4'), /duplicate candidate product/);
  assert.throws(() => parseCandidateVersions('website=1.2.3'), /unsupported candidate product/);
  assert.throws(() => parseCandidateVersions('cli'), /product=version/);
  assert.throws(() => buildLocalCandidateCommands({
    channel: 'preview',
    sourceSha: 'short',
    repository: 'happier-dev/happier',
    candidates: { cli: '1.2.3-preview.1' },
    phase: 'all',
    releaseMessage: '',
  }), /full lowercase commit/);
});
