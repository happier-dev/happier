import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('./perf.mjs', import.meta.url));
const bed = 'agent-qa-perf-bed';
const host = 'nl1';
const rev = 'a'.repeat(40);
const at = '2026-11-28T04:00:00.000Z';

async function replay(t, metric, samples, expectedN = 3) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-ademark-' });
  const input = fixture.path('samples.json');
  await writeFile(input, JSON.stringify({ bed, host, rev, at, metric, samples }));
  return exec(process.execPath, [
    cli, 'ademark', '--bed', bed, '--host', host, '--n', String(expectedN), '--samples', input,
  ]);
}

test('ADEMark summarizes the named A1 and A4 intervals on the selected bed and host', async t => {
  const fixtures = [
    ['A1-web-cold', [300, 70, 150].map(duration => ({
      navigationStartMs: 1000, firstSessionRowPaintMs: 1000 + duration, homeShellMs: 1020,
    })), 150, 300],
    ['A4-first-request', [110, 60, 90].map(duration => ({
      startTapMs: 2000, firstProviderRequestMs: 2000 + duration, firstAssistantTextMs: 2500,
    })), 90, 110],
  ];
  for (const [metric, samples, p50, p90] of fixtures) {
    const { stdout, stderr } = await replay(t, metric, samples);
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), { metric, unit: 'ms', n: 3, p50, p90, host, rev, at });
  }
});

test('ADEMark refuses missing endpoints, non-finite durations and partial repeat counts', async t => {
  const partial = [{ startTapMs: 2000, firstAssistantTextMs: 2150 }];
  const overflowing = [{ startTapMs: -Number.MAX_VALUE, firstProviderRequestMs: Number.MAX_VALUE }];
  const oneSample = [{ startTapMs: 2000, firstProviderRequestMs: 2110 }];
  for (const [samples, n] of [[partial, 1], [overflowing, 1], [oneSample, 2]]) {
    await assert.rejects(replay(t, 'A4-first-request', samples, n), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /sample count|firstProviderRequestMs/);
      return true;
    });
  }
});
