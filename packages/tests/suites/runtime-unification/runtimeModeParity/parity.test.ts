import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  captureNormalizedOrchestratorPath,
} from './_harness';
import { diffRuntimeModeParitySnapshots } from './_normalize';
import { runtimeModeParityScenarios } from './scenarios';

describe('runtime-mode-switch parity bench', () => {
  it('keeps the A.13.7 scenario floor at eight or more rows', () => {
    expect(runtimeModeParityScenarios.length).toBeGreaterThanOrEqual(8);
  });

  it('does not contain disabled runner cases', async () => {
    const source = await readFile(fileURLToPath(import.meta.url), 'utf8');
    const forbiddenCalls = [
      ['it', 'skip'].join('.'),
      ['test', 'skip'].join('.'),
    ];
    for (const forbiddenCall of forbiddenCalls) {
      expect(source).not.toContain(forbiddenCall);
    }
  });

  it.each(runtimeModeParityScenarios)('$id matches the pinned orchestrator capture', (scenario) => {
    const actual = captureNormalizedOrchestratorPath(scenario);
    expect(diffRuntimeModeParitySnapshots({ expected: scenario.expected, actual })).toEqual([]);
  });
});
