import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import { COPILOT_EXTERNAL_SESSIONS_DECISION } from './__fixtures__/unsupportedDecision.test-support.js';

describe('Copilot current-release External Sessions decision', () => {
  it('keeps documented candidates decision-only until an installed version proves them', async () => {
    const activateSource = await readFile(
      new URL('../../activate.ts', import.meta.url),
      'utf8',
    );

    expect(COPILOT_EXTERNAL_SESSIONS_DECISION).toMatchObject({
      release: 'decision_only_unsupported',
      installedVersion: 'unavailable',
      recipe: 'none',
      observationRegistration: false,
      externalSessionsRegistration: false,
      autoLinkEligible: false,
    });
    expect(activateSource).not.toMatch(/registerExternalSession/u);
    expect(JSON.stringify(PLUGIN_MANIFEST)).not.toContain('externalSessions');
  });

  it('forbids the private session store, TUI readers, and misleading capability', () => {
    expect(COPILOT_EXTERNAL_SESSIONS_DECISION.forbiddenEvidenceSources).toEqual([
      'session_store_database',
      'interactive_tui_reader',
      'experimental_event_log_as_release_contract',
    ]);
    expect(COPILOT_EXTERNAL_SESSIONS_DECISION.exposedCapability).toBe('none');
  });
});
