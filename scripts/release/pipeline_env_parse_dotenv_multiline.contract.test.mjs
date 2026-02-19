import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDotenv } from '../pipeline/env/parse-dotenv.mjs';

test('parseDotenv supports multiline quoted values (pipeline env files)', () => {
  const parsed = parseDotenv(
    [
      '# comment',
      'SINGLE=ok',
      'MINISIGN_SECRET_KEY="untrusted comment: minisign encrypted secret key',
      'RWQaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
      'AFTER=yes',
      "SINGLE_QUOTED='one\\ntwo'",
      'PRIVATE_KEY="-----BEGIN PRIVATE KEY-----',
      'line1',
      'line2',
      '-----END PRIVATE KEY-----"',
      '',
    ].join('\n'),
  );

  assert.equal(parsed.SINGLE, 'ok');
  assert.equal(parsed.AFTER, 'yes');
  assert.equal(parsed.SINGLE_QUOTED, 'one\\ntwo');
  assert.equal(
    parsed.MINISIGN_SECRET_KEY,
    [
      'untrusted comment: minisign encrypted secret key',
      'RWQaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ].join('\n'),
  );
  assert.equal(
    parsed.PRIVATE_KEY,
    ['-----BEGIN PRIVATE KEY-----', 'line1', 'line2', '-----END PRIVATE KEY-----'].join('\n'),
  );
});

