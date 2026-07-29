import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import { CURSOR_EXTERNAL_SESSIONS_DECISION } from './__fixtures__/unsupportedDecision.test-support.js';

describe('Cursor current-release External Sessions decision', () => {
  it('keeps official/local feasibility evidence decision-only', async () => {
    const activateSource = await readFile(
      new URL('../../activate.ts', import.meta.url),
      'utf8',
    );

    expect(CURSOR_EXTERNAL_SESSIONS_DECISION).toMatchObject({
      release: 'decision_only_unsupported',
      recipe: 'none',
      observationRegistration: false,
      externalSessionsRegistration: false,
      autoLinkEligible: false,
    });
    expect(activateSource).not.toMatch(/registerExternalSession/u);
    expect(JSON.stringify(PLUGIN_MANIFEST)).not.toContain('externalSessions');
  });

  it('forbids private databases, TUI readers, and misleading capability', () => {
    expect(CURSOR_EXTERNAL_SESSIONS_DECISION.forbiddenEvidenceSources).toEqual([
      'private_opaque_database',
      'interactive_tui_reader',
      'happier_owned_acp_files_as_arbitrary_cursor_history',
    ]);
    expect(CURSOR_EXTERNAL_SESSIONS_DECISION.exposedCapability).toBe('none');
  });
});
