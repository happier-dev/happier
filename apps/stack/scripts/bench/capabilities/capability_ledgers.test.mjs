import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const REQUIRED_LIMA_TOPICS = [
  'backend', 'architecture', 'mounts', 'rosetta', 'networking', 'memoryReclamation',
  'diskFormats', 'diskResize', 'lifecycle', 'ssh', 'processModel', 'macos26', 'm5',
];
const REQUIRED_ORBSTACK_TOPICS = [
  'backend', 'machineIsolation', 'filesystem', 'memoryReclamation', 'disk', 'networking',
  'rosetta', 'scheduling', 'limitations', 'macos26', 'm5',
];

async function load(name) {
  return JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'));
}

function assertLedger(ledger, topics) {
  assert.equal(ledger.schemaVersion, 1);
  assert.match(ledger.capturedAt, /^\d{4}-\d{2}-\d{2}/);
  for (const topic of topics) {
    const claim = ledger.capabilities[topic];
    assert.ok(claim, `missing ${topic}`);
    assert.ok(['verified', 'observed', 'claimed', 'unknown'].includes(claim.status));
    assert.equal(Array.isArray(claim.sources), true);
    assert.equal(claim.sources.length > 0 || claim.status === 'unknown', true);
  }
}

test('Lima capability ledger covers every decision-material VM contract', async () => {
  assertLedger(await load('lima-2.1.0.json'), REQUIRED_LIMA_TOPICS);
});

test('OrbStack capability ledger separates vendor claims, observations, and unknown internals', async () => {
  assertLedger(await load('orbstack-current.json'), REQUIRED_ORBSTACK_TOPICS);
});
