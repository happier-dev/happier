#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DEFAULT_SPEC_WEIGHT_SECONDS = 120;

// Measured from slow-file summaries in successful canonical 0.2 CI run
// 34480153195. New and ordinary specs use the conservative default above.
// These weights affect scheduling only; every discovered spec is assigned once.
export const UI_E2E_DURATION_WEIGHTS_SECONDS = new Map([
  ['packages/tests/suites/ui-e2e/session.codex.appServer.dynamicControls.spec.ts', 14.7 * 60],
  ['packages/tests/suites/ui-e2e/session.handoff.fromHeaderAction.feat.sessions.handoff.spec.ts', 11.1 * 60],
  ['packages/tests/suites/ui-e2e/auth.terminalConnect.daemon.spec.ts', 9.6 * 60],
  ['packages/tests/suites/ui-e2e/session.sourceControl.reviewScroll.spec.ts', 8.7 * 60],
  ['packages/tests/suites/ui-e2e/session.composerDraftContinuity.spec.ts', 7.5 * 60],
  ['packages/tests/suites/ui-e2e/connectedServices.quotaSwitchRecovery.feat.connectedServices.quotas.feat.connectedServices.accountFallback.spec.ts', 5.8 * 60],
  ['packages/tests/suites/ui-e2e/encryptionOptOut.modeSwitch.readBoth.spec.ts', 5.8 * 60],
  ['packages/tests/suites/ui-e2e/session.transcript.catchup.reconnect.spec.ts', 5.6 * 60],
  ['packages/tests/suites/ui-e2e/session.subroutes.spec.ts', 5.3 * 60],
]);

export function parseUiE2eShard(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
  if (!match) throw new Error('UI E2E shard must use current/total syntax');
  const current = Number.parseInt(match[1], 10);
  const total = Number.parseInt(match[2], 10);
  if (total < 1 || current < 1 || current > total) {
    throw new Error(`UI E2E shard current must be between 1 and ${total}`);
  }
  return { current, total };
}

export function partitionUiE2eSpecs({
  specs,
  shardTotal,
  weights = UI_E2E_DURATION_WEIGHTS_SECONDS,
  defaultWeight = DEFAULT_SPEC_WEIGHT_SECONDS,
}) {
  if (!Number.isInteger(shardTotal) || shardTotal < 1) {
    throw new Error('UI E2E shard total must be a positive integer');
  }
  const uniqueSpecs = [...new Set(specs)].sort();
  if (uniqueSpecs.length < shardTotal) {
    throw new Error(`UI E2E has ${uniqueSpecs.length} specs for ${shardTotal} shards`);
  }

  const ranked = uniqueSpecs
    .map((spec) => ({ spec, weight: weights.get(spec) ?? defaultWeight }))
    .sort((left, right) => right.weight - left.weight || left.spec.localeCompare(right.spec));
  const partitions = Array.from({ length: shardTotal }, () => ({ specs: [], weight: 0 }));

  for (const entry of ranked) {
    let target = 0;
    for (let index = 1; index < partitions.length; index += 1) {
      const candidate = partitions[index];
      const selected = partitions[target];
      if (
        candidate.weight < selected.weight
        || (candidate.weight === selected.weight && candidate.specs.length < selected.specs.length)
      ) {
        target = index;
      }
    }
    partitions[target].specs.push(entry.spec);
    partitions[target].weight += entry.weight;
  }

  return partitions.map((partition) => partition.specs.sort());
}

function listUiE2eSpecs(repoRoot) {
  const specDir = path.join(repoRoot, 'packages', 'tests', 'suites', 'ui-e2e');
  return fs.readdirSync(specDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.ts'))
    .map((entry) => path.posix.join('packages/tests/suites/ui-e2e', entry.name));
}

function main() {
  const shardIndex = process.argv.indexOf('--shard');
  const { current, total } = parseUiE2eShard(shardIndex >= 0 ? process.argv[shardIndex + 1] : undefined);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const partitions = partitionUiE2eSpecs({ specs: listUiE2eSpecs(repoRoot), shardTotal: total });
  process.stdout.write(`${partitions[current - 1].join('\n')}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
