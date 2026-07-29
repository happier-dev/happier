import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../../../../manifest.js';
import { AUGGIE_EXTERNAL_SESSIONS_DECISION } from './__fixtures__/unsupportedDecision.test-support.js';

describe('Auggie current-release External Sessions decision', () => {
  it('retains public evidence only and exposes no recipe or External Sessions registration', async () => {
    const activateSource = await readFile(
      new URL('../../../../activate.ts', import.meta.url),
      'utf8',
    );

    expect(AUGGIE_EXTERNAL_SESSIONS_DECISION).toMatchObject({
      release: 'unsupported',
      publicEvidenceInputs: ['session_list_json', 'documented_lifecycle_hooks'],
      recipe: 'none',
      observationRegistration: false,
      externalSessionsRegistration: false,
      autoLinkEligible: false,
    });
    expect(activateSource).not.toMatch(/registerExternalSession/u);
    expect(JSON.stringify(PLUGIN_MANIFEST)).not.toContain('externalSessions');
  });

  it('forbids private stores, TUI readers, and misleading partial capability', () => {
    expect(AUGGIE_EXTERNAL_SESSIONS_DECISION.forbiddenEvidenceSources).toEqual([
      'private_database',
      'private_transcript_schema',
      'interactive_tui_reader',
    ]);
    expect(AUGGIE_EXTERNAL_SESSIONS_DECISION.exposedCapability).toBe('none');
  });
});
