import { describe, expect, it } from 'vitest';

import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

import { activate } from './activate.js';
import { antigravityExternalSessionsContribution } from './agent/cliPrint/externalSessions.js';
import { antigravityExternalSessionObservationContribution } from './agent/cliPrint/observation.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('Antigravity plugin activation', () => {
  it('reexports the activation compiled by its canonical public plugin definition', async () => {
    expect(Object.keys(PLUGIN_MANIFEST.contributes).sort()).toEqual([
      'agents',
      'connectedAccountDescriptors',
      'resources',
      'systemTools',
    ]);
    expect(await import('./manifest.js')).toEqual(expect.objectContaining({
      ANTIGRAVITY_PLUGIN: expect.objectContaining({ manifest: PLUGIN_MANIFEST, activate }),
    }));
  });

  it('registers provider leaves with the host ACP session runtime', async () => {
    const fixture = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
    });
    try {
      expect(fixture.registrations()).toContainEqual({
        family: 'agents',
        localId: 'antigravity',
      });
      const registration = fixture.registration('agents', 'antigravity');

      // The provider factory composes host ACP over native `agy acp`; no spawn hook,
      // preflight control or CLI session command competes with it.
      expect(registration?.factory).toEqual(expect.any(Function));
      expect(registration?.daemonSpawnHooks).toBeUndefined();
      expect(registration?.preflightSessionControls).toBeUndefined();
      expect(registration?.cliSessionCommand).toBeUndefined();
      expect(fixture.registration('hooks', 'resolve-prerequisites')).toBeUndefined();

      expect(Object.keys(registration?.externalSessions ?? {}).sort()).toEqual([
        'listCandidates',
        'pageTranscript',
        'readAfterTranscript',
        'resolveLinkIdentity',
        'resolveLinkedIdentity',
        'resolveSource',
      ]);
      expect(Object.keys(
        registration?.externalSessionObservation ?? {},
      ).sort()).toEqual([
        'describeResource',
        'observeResource',
        'reconcileResource',
      ]);
      expect(registration?.externalSessionHooks).toBeUndefined();
      expect(registration?.externalSessionTakeover).toBeUndefined();

      const cancelled = new AbortController();
      cancelled.abort();
      const cancelledRequest = {
        signal: cancelled.signal,
        deadlineAtMs: Date.now() + 30_000,
        maxSerializedBytes: 64 * 1024,
        source: {},
      } as never;
      expect(registration?.externalSessions?.resolveSource(cancelledRequest)).toEqual(
        antigravityExternalSessionsContribution.resolveSource(cancelledRequest),
      );
      expect(registration?.externalSessions).not.toBe(
        antigravityExternalSessionsContribution,
      );
      expect(registration?.externalSessionObservation).not.toBe(
        antigravityExternalSessionObservationContribution,
      );
    } finally {
      await fixture.dispose();
    }
  });

  it('launches the interactive Antigravity CLI as a surface separate from ACP sessions', async () => {
    const fixture = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
    });
    try {
      const factory = fixture.registration('agents', 'antigravity')?.factory;
      const runtime = await factory?.({ plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
        agent: { id: 'antigravity' }, signal: new AbortController().signal });
      const terminal = runtime?.surfaces?.terminal;
      if (!terminal) throw new Error('Expected the Antigravity terminal surface.');

      const launch = terminal.resolveLaunch({
        metadata: {
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'antigravity',
            agent: {
              // A host ACP session id must never become an `agy --conversation` argument.
              providerSessionId: 'acp-session-1',
              agentExtra: {
                owner: 'antigravity',
                schemaId: 'antigravity.agentRuntimeDescriptorExtra',
                v: 1,
                runtimeHandle: { agyConversationId: 'agy-conversation-1' },
              },
            },
          },
        },
        modelSelection: { modelId: 'Gemini 3.5 Flash (High)' },
      } as never);

      expect(launch.argv).toEqual([
        '--conversation',
        'agy-conversation-1',
        '--model',
        'Gemini 3.5 Flash (High)',
      ]);
    } finally {
      await fixture.dispose();
    }
  });
});
