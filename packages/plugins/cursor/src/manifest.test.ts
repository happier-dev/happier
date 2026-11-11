import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { resolveConnectedAccountAuthenticationModeMachineRequirement } from '@happier-dev/protocol/connect/pluginConnectedAccountAuthenticationV2';
import { projectConnectedAccountDescriptorV1 } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('Cursor plugin manifest', () => {
  it('routes Cursor browser sign-in through Machine only in browsers', () => {
    const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors?.find(entry => entry.id === 'cursor-account');
    if (!descriptor) throw new Error('Account descriptor missing');
    const projection = projectConnectedAccountDescriptorV1({
      descriptor, serviceId: descriptor.id, pluginId: PLUGIN_MANIFEST.id,
      provenance: 'first_party', sourceKind: 'builtin',
      availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
    });
    const mode = projection.authentication.modes.find(entry => entry.id === 'subscription');
    expect(resolveConnectedAccountAuthenticationModeMachineRequirement(mode, true)).toBe('browser_unreachable');
    expect(resolveConnectedAccountAuthenticationModeMachineRequirement(mode, false)).toBeNull();
    const apiKey = projection.authentication.modes.find(entry => entry.id === 'api-key');
    expect(resolveConnectedAccountAuthenticationModeMachineRequirement(apiKey, true)).toBeNull();
  });

  it('declares the custom session runtime and finite Cursor access', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST.contributes.agents[0]).toMatchObject({
      id: 'cursor', runtime: { kind: 'custom' }, primary: 'sessions',
      capabilities: {
        skills: {
          delivery: 'session_dir', nativeDisable: 'unsupported', liveReload: 'unsupported',
          nativeRoots: {
            user: [['.agents', 'skills'], ['.cursor', 'skills'], ['.claude', 'skills'], ['.codex', 'skills']],
            project: [['.agents', 'skills'], ['.cursor', 'skills'], ['.claude', 'skills'], ['.codex', 'skills']],
          },
        },
        sessions: {
          open: ['create', 'resume'],
          delivery: ['newTurn', 'followUp'],
          cancel: true,
        },
      },
    });
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.cli.auth.nonInteractiveStatusProbe).toBe(true);
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.connectedAccounts).toEqual([{
      purpose: 'cursor-native', service: 'cursor-account', required: false,
      credentialKinds: ['token', 'oauth'], materializationKinds: ['environment'],
    }]);
    expect(PLUGIN_MANIFEST.hostAccess.required).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cursor-api-key', capability: 'environment', scope: { keys: ['CURSOR_API_KEY'] } }),
      expect.objectContaining({
        id: 'cursor-process',
        capability: 'process',
        scope: expect.objectContaining({
          executables: [
            { kind: 'systemTool', id: 'cursor-agent' },
            { kind: 'systemTool', id: 'cursor-agent-no-fallback' },
          ],
        }),
      }),
    ]));
    expect(PLUGIN_MANIFEST.contributes.systemTools).toEqual([
      expect.objectContaining({
        id: 'cursor-agent',
        executableNames: ['cursor-agent', 'agent'],
      }),
      expect.objectContaining({
        id: 'cursor-agent-no-fallback',
        executableNames: ['cursor-agent'],
      }),
    ]);
    expect(PLUGIN_MANIFEST.contributes.settings).toEqual([
      expect.objectContaining({
        target: { kind: 'agent', agent: 'cursor' },
        scope: 'daemon',
        fields: expect.arrayContaining([
          expect.objectContaining({ id: 'cursorBinaryPath' }),
          expect.objectContaining({ id: 'cursorAgentFallbackEnabled' }),
          expect.objectContaining({ id: 'cursorApiEndpoint' }),
        ]),
      }),
    ]);
  });
});
