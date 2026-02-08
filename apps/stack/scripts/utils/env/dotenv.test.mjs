import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';

import { parseDotenv, parseEnvToObject } from './dotenv.mjs';

test('parseDotenv expands ~/ paths', () => {
  const env = parseDotenv('FOO=~/x\n');
  assert.equal(env.get('FOO'), `${homedir()}/x`);
});

test('parseDotenv expands ~\\ paths (Windows)', () => {
  const env = parseDotenv('FOO=~\\x\n');
  assert.equal(env.get('FOO'), `${homedir()}\\x`);
});

test('parseDotenv expands quoted ~/ paths and trims keys/values', () => {
  const env = parseDotenv("  FOO = '~/x'  \n");
  assert.equal(env.get('FOO'), `${homedir()}/x`);
});

test('parseDotenv ignores comments and malformed assignments', () => {
  const env = parseDotenv('# comment\nNO_EQ\n=BAD\nOK=value\n');
  assert.equal(env.get('OK'), 'value');
  assert.equal(env.has('NO_EQ'), false);
  assert.equal(env.has(''), false);
});

test('parseEnvToObject returns the final value for duplicate keys', () => {
  const env = parseEnvToObject('FOO=first\nFOO=second\n');
  assert.deepEqual(env, { FOO: 'second' });
});
