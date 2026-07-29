import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { PI_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import {
  PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
  PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
  PLUGIN_MANIFEST,
} from './manifest.js';

describe('Pi plugin manifest', () => {
  it('uses the strict target families and keeps settings out of the retired agentSettings family', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('agentSettings');
    expect(PLUGIN_MANIFEST.contributes.settings).toEqual([
      PI_AGENT_SETTINGS_CONTRIBUTION,
    ]);
    expect(PLUGIN_MANIFEST.contributes.systemTools).toEqual([
      expect.objectContaining({ id: 'pi-cli', executableNames: ['pi'] }),
    ]);
    expect(PLUGIN_MANIFEST.contributes.agents).toEqual([
      expect.objectContaining({
        id: 'pi',
        connectedAccounts: [{
          purpose: PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
          service: {
            pluginId: 'happier.agent.claude',
            localId: 'claude-subscription',
          },
        }, {
          purpose: PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
          service: {
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
          },
        }],
        capabilities: expect.objectContaining({
          surfaces: ['externalSessions'],
        }),
        surfaces: {
          externalSession: {
            externalLinkedTakeover: {
              writerSafety: 'unsupported',
            },
            sources: [{
              sourceKind: 'piAgentDir',
              schema: {
                fields: [
                  { kind: 'literal', name: 'kind', value: 'piAgentDir' },
                  { kind: 'string', name: 'agentDir', min: 1, max: 10_000, nullish: true },
                ],
                passthrough: true,
              },
              key: {
                segments: [
                  { kind: 'literal', value: 'piAgentDir' },
                  { kind: 'field', field: 'agentDir' },
                ],
              },
              instances: [{ kind: 'default', constants: {} }],
            }],
          },
        },
      }),
    ]);
  });
});
