import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('OhMyPi strict plugin manifest', () => {
  it('uses a legal local id for the custom runtime and structured hook declaration', () => {
    const ingestion = ingestPluginManifestV2(PLUGIN_MANIFEST);
    expect(ingestion.ok, JSON.stringify(ingestion)).toBe(true);
    expect(PLUGIN_MANIFEST.contributes.agents).toEqual([
      expect.objectContaining({ id: 'ohmypi', runtime: { kind: 'custom' }, primary: 'sessions' }),
    ]);
    expect(PLUGIN_MANIFEST.contributes.hooks).toEqual([
      expect.objectContaining({ id: 'resolve-prerequisites', on: 'agent.resolvePrerequisites' }),
    ]);
    expect(PLUGIN_MANIFEST.hostAccess.required).toContainEqual(expect.objectContaining({
      id: 'ohmypi-process',
      capability: 'process',
      scope: {
        executables: [{ kind: 'systemTool', id: 'ohmypi-cli' }],
        envKeys: [
          'OPENAI_CODEX_OAUTH_TOKEN',
          'OPENAI_API_KEY',
          'ANTHROPIC_OAUTH_TOKEN',
          'ANTHROPIC_API_KEY',
          'GEMINI_API_KEY',
          'PI_CODING_AGENT_DIR',
        ],
      },
    }));
  });
});
