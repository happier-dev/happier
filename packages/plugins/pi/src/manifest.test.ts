import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { PI_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES } from './agent/auth/services/qualifiedPurposes.js';
import { PLUGIN_MANIFEST } from './manifest.js';

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
        connectedAccounts: PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES.map(
          ({ purpose, service, materializationKinds, credentialKinds }) => ({
            purpose, service, materializationKinds, credentialKinds,
          }),
        ),
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
              contentSearch: true,
              schema: {
                fields: [
                  { kind: 'literal', name: 'kind', value: 'piAgentDir' },
                  { kind: 'string', name: 'agentDir', min: 1, max: 10_000, nullish: true },
                  { kind: 'string', name: 'sessionsRoot', min: 1, max: 10_000, nullish: true },
                  // Resolved carrier, deliberately absent from `key.segments`.
                  { kind: 'string', name: 'sessionFile', min: 1, max: 10_000, nullish: true },
                ],
              },
              key: {
                segments: [
                  { kind: 'literal', value: 'piAgentDir' },
                  { kind: 'field', field: 'agentDir' },
                  { kind: 'field', field: 'sessionsRoot' },
                ],
              },
              instances: [{ kind: 'default', constants: {} }, {
                kind: 'agentSettingOverride',
                settingId: 'piAgentDir',
                field: 'agentDir',
                normalization: 'configuredPath',
                constants: {},
              }],
            }],
          },
        },
      }),
    ]);
  });
});
