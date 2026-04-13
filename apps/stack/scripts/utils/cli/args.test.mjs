import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from './args.mjs';

test('parseArgs keeps boolean flags when followed by positionals', () => {
  const { flags, kv } = parseArgs(['--json', 'ui']);

  assert.equal(flags.has('--json'), true);
  assert.equal(kv.has('--json'), false);
});

test('parseArgs ignores bare passthrough sentinel tokens', () => {
  const { flags, kv } = parseArgs(['--', 'vitest', '--json']);

  assert.equal(flags.has('--'), false);
  assert.equal(kv.has('--'), false);
  assert.equal(flags.has('--json'), true);
});

test('parseArgs consumes the next token only for contract-defined value flags', () => {
  const { flags, kv } = parseArgs(['--mode', 'user', '--sandbox-dir', '/tmp/hstack']);

  assert.equal(flags.has('--mode'), false);
  assert.equal(kv.get('--mode'), 'user');
  assert.equal(flags.has('--sandbox-dir'), false);
  assert.equal(kv.get('--sandbox-dir'), '/tmp/hstack');
});

test('parseArgs does not infer next-token values for equals-only flags', () => {
  const { flags, kv } = parseArgs(['--profile', 'selfhost']);

  assert.equal(flags.has('--profile'), true);
  assert.equal(kv.has('--profile'), false);
});

test('parseArgs does not let undocumented boolean-style flags swallow following positionals', () => {
  for (const flag of ['--force', '--background', '--offline-ok', '--with-infra']) {
    const { flags, kv } = parseArgs([flag, 'feature-123']);

    assert.equal(flags.has(flag), true, `${flag} should remain a flag`);
    assert.equal(kv.has(flag), false, `${flag} should not consume the following positional`);
  }
});
