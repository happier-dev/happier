import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import {
  VOICE_PROVIDER_PRESENTATIONS,
} from './index.js';

describe('Codex bundled Voice projection', () => {
  it('keeps the strict manifest declaration authoritative and adds presentation only', () => {
    const entry = VOICE_PROVIDER_PRESENTATIONS[0];

    expect(PLUGIN_MANIFEST.contributes.voiceProviders[0]?.execution).toEqual({
      kind: 'experimental_agent_session_realtime',
      agent: 'codex',
    });
    expect(PLUGIN_MANIFEST.contributes.voiceProviders[0]?.settings?.connectedServicesBinding).toMatchObject({
      agent: 'codex',
      serviceIds: ['openai-codex'],
    });
    expect(entry?.selectionOptions).toEqual([
      expect.objectContaining({
        id: 'experimental',
        modeId: 'experimental',
      }),
    ]);
    expect(entry?.providerId).toBe('happier.agent.codex/realtime-codex');
    expect(entry).not.toHaveProperty('passiveSetup');
    expect(entry).not.toHaveProperty('declaration');
    expect(entry).not.toHaveProperty('roles');
    expect(entry).not.toHaveProperty('requirements');
    expect(entry).not.toHaveProperty('supportedPlatforms');
  });
});
