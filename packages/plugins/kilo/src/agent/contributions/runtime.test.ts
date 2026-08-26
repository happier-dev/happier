import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { KILO_AGENT_RUNTIME_CONTRIBUTION as catalogContribution } from './catalog.js';
import { KILO_AGENT_RUNTIME_CONTRIBUTION as legacyRuntimeContribution } from './runtime.js';

describe('Kilo agent catalog contribution', () => {
  it('keeps the static catalog leaf independent from the legacy runtime entrypoint', () => {
    const catalogSource = readFileSync(new URL('./catalog.ts', import.meta.url), 'utf8');

    expect(catalogSource).not.toContain("from './runtime");
  });

  it('preserves the legacy runtime contribution identity after public preflight migration', () => {
    expect(catalogContribution).toBe(legacyRuntimeContribution);
    expect(catalogContribution).toEqual({ agentId: 'kilo' });
  });
});
