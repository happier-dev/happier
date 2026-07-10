import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('Antigravity plugin manifest', () => {
  it('declares agent settings as plugin-authored contribution data', () => {
    const contribution = PLUGIN_MANIFEST.contributes.agentSettings?.find((entry) => entry.agentId === 'antigravity');

    expect(contribution).toEqual(expect.objectContaining({
      id: 'antigravity.agentSettings.v1',
      kind: 'agentSettings.v1',
      storageScope: 'agentAccount',
    }));
    expect(contribution?.fields.map((field) => field.id)).toEqual(['antigravityRuntimeMode']);
    expect(contribution?.fields[0]).toMatchObject({
      default: 'auto',
      schema: {
        kind: 'enum',
        values: ['auto', 'cliPrint', 'sdk'],
      },
    });
    expect(contribution?.ui.sections).toEqual([
      expect.objectContaining({
        id: 'antigravityRuntime',
        fields: ['antigravityRuntimeMode'],
      }),
    ]);
  });

  it('declares Antigravity as one canonical agent with plugin runtime-core ownership', () => {
    const agent = PLUGIN_MANIFEST.contributes.agents?.find((entry) => entry.id === 'antigravity');
    const agentRuntime = PLUGIN_MANIFEST.contributes.agents?.find((entry) => entry.id === 'antigravity');
    const agentIds = PLUGIN_MANIFEST.contributes.agents?.map((entry) => entry.id) ?? [];

    expect(PLUGIN_MANIFEST.id).toBe('happier.agent.antigravity');
    expect(PLUGIN_MANIFEST.uses).toEqual(expect.arrayContaining(['agents']));
    expect(agent).toMatchObject({
      kindVersion: 1,
      id: 'antigravity',
      settingsBackendId: 'antigravity',
      ownedBackendIds: ['antigravity'],
      display: {
        name: 'Antigravity',
      },
      ui: {
        modelSelection: 'supported',
      },
    });
    expect(agentIds).toEqual(['antigravity']);
    expect(agentIds).not.toEqual(expect.arrayContaining([
      'antigravity-localharness',
      'antigravity-terminal',
    ]));
    expect(agentRuntime).toMatchObject({
      kindVersion: 1,
      id: 'antigravity',
      runtime: { kind: 'custom' },
      runtimeOwner: {
        selectedOwner: 'plugin_engine',
        acceptedBy: '2026-06-19-antigravity-runtime-unification',
      },
      launch: {
        binaryName: 'localharness',
        args: [],
        resolutionPolicy: 'managed-installable',
      },
      install: {
        managedInstall: {
          installableKey: 'dep.antigravity.localharness',
          command: 'localharness',
        },
        sourcePreference: 'managed-first',
      },
      capabilities: {
        executionRun: { supported: true },
        session: {
          media: {
            acceptsImageInput: { supported: false },
            emitsSessionMedia: { supported: false },
            nativeImageGeneration: { supported: false },
          },
        },
      },
    });
    expect(agentRuntime).not.toHaveProperty('providerId');
  });

  it('declares managed localharness installable and terminal runtime host launch surface on the canonical agent', () => {
    const agentRuntime = PLUGIN_MANIFEST.contributes.agents?.find((entry) => entry.id === 'antigravity');
    const launchSurface = agentRuntime?.surfaceHandlers?.find((entry) => (
      entry.kind === 'terminalRuntime' && entry.operation === 'launch'
    ));

    expect(PLUGIN_MANIFEST.contributes.managedDependencies?.map((entry) => entry.key) ?? []).toEqual([
      'dep.antigravity.localharness',
    ]);
    expect(agentRuntime).toMatchObject({
      id: 'antigravity',
    });
    expect(launchSurface).toMatchObject({
      id: 'antigravity.terminalRuntime.launch',
      kind: 'terminalRuntime',
      operation: 'launch',
      support: 'supported',
      handler: {
        target: 'daemon',
        exportName: 'resolveAntigravityTerminalRuntimeLaunch',
      },
      staticMetadata: {
        topology: 'exclusive',
        attachStrategy: 'terminal_host',
        transcript: 'terminal_mirror',
        structuredTranscript: false,
        providerNativeStatusLine: false,
        printMode: false,
        runtimeCore: 'localharness',
        runtimeSurface: 'terminalRuntime',
        backendMode: 'terminal',
      },
    });
  });

  it('declares a localharness daemon spawn prerequisite hook', () => {
    expect(PLUGIN_MANIFEST.contributes.hooks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'agent.resolvePrerequisites',
        hookApiVersion: 1,
        category: 'decision',
        scope: 'agent',
        filters: { agentId: 'antigravity' },
        executionKind: 'decide',
        handler: {
          target: 'plugin',
          exportName: 'resolveAntigravityDaemonSpawnPrerequisites',
        },
      }),
    ]));
  });
});
