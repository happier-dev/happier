import { describe, expect, it } from 'vitest';

import {
  createRemoteDevSessionSpawnApprovalReplayNormalizer,
} from './normalizeRemoteDevSessionSpawnApprovalReplay';

const normalizer = createRemoteDevSessionSpawnApprovalReplayNormalizer({
  readAgentDefinitions: () => [
    {
      id: 'codex',
      identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
    },
    {
      id: 'voice',
      identity: { pluginId: 'happier.agent.voice', localId: 'voice' },
    },
    {
      id: 'review-bot',
      identity: { pluginId: 'happier.agent.review-bot', localId: 'review-bot' },
    },
  ],
  readLocalMachineIdentity: async () => ({
    machineId: 'machine-local',
    host: 'local-machine',
  }),
});

const artifact = {
  id: 'approval-remote-dev-1',
  serverId: 'server-1',
  request: {
    v: 1,
    status: 'open',
    createdAtMs: 42,
    updatedAtMs: 42,
    createdBy: { surface: 'cli' as const },
    actionId: 'session.spawn_new' as const,
    actionArgs: {
      tag: 'predecessor metadata label',
      agentId: 'codex',
      modelId: 'gpt-5',
      directory: '/workspace/project',
      machineId: 'machine-1',
      prompt: 'Inspect this repository.',
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 42,
        overrides: {
          reasoning_effort: { updatedAt: 42, value: 'high' },
        },
      },
      configOptions: { reasoning_effort: 'high' },
      connectedServices: { v: 1, bindingsByServiceId: {} },
      mcpSelection: {
        v: 1,
        managedServersEnabled: true,
        forceIncludeServerIds: [],
        forceExcludeServerIds: [],
      },
      transcriptStorage: 'persisted',
      terminal: { mode: 'tmux', tmux: { sessionName: 'legacy-session' } },
    },
    summary: 'Create session',
  },
} as const;

describe('remote-dev Session-spawn approval replay normalizer', () => {
  it('maps the full provenance-pinned predecessor artifact to V2 with its durable approval identity', async () => {
    await expect(normalizer({
      artifactId: artifact.id,
      serverId: artifact.serverId,
      request: artifact.request,
    })).resolves.toEqual({
      legacyMetadataLabel: 'predecessor metadata label',
      input: {
        creationKey: 'approval-artifact:approval-remote-dev-1',
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
        directory: '/workspace/project',
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
        modelSelection: {
          v: 1,
          updatedAt: 42,
          ref: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: null,
            modelId: 'gpt-5',
          },
        },
        initialMessage: 'Inspect this repository.',
        configuration: {
          mode: { value: null, updatedAtMs: 42 },
          model: { value: null, updatedAtMs: 42 },
          permissionIntent: { value: null, updatedAtMs: 42 },
          options: {
            reasoning_effort: { value: 'high', updatedAtMs: 42 },
          },
        },
        connectedServices: { v: 1, bindingsByServiceId: {} },
        mcpSelection: {
          v: 1,
          managedServersEnabled: true,
          forceIncludeServerIds: [],
          forceExcludeServerIds: [],
        },
        transcriptStorage: 'persisted',
        terminal: { mode: 'tmux', tmux: { sessionName: 'legacy-session' } },
      },
    });
  });

  it('normalizes the flat Windows facts from remote-dev@fbb5cebec0e8f026af1b94bf3974105f98b26b0c', async () => {
    // Provenance: remote-dev packages/protocol/src/actions/actionSpecs.ts
    // `SessionSpawnNewInputSchema` emits these three flat artifact fields.
    await expect(normalizer({
      artifactId: artifact.id,
      serverId: artifact.serverId,
      request: {
        ...artifact.request,
        actionArgs: {
          ...artifact.request.actionArgs,
          windowsRemoteSessionLaunchMode: 'windows_terminal',
          windowsRemoteSessionConsole: 'visible',
          windowsTerminalWindowName: 'Happier predecessor',
        },
      },
    })).resolves.toEqual(expect.objectContaining({
      input: expect.objectContaining({
        terminal: {
          mode: 'tmux',
          tmux: { sessionName: 'legacy-session' },
          windows: {
            launchMode: 'windows_terminal',
            console: 'visible',
            windowName: 'Happier predecessor',
          },
        },
      }),
    }));
  });

  it('synthesizes the canonical Windows terminal when the predecessor omitted terminal', async () => {
    const { terminal: _terminal, ...artifactWithoutTerminal } = artifact.request.actionArgs;

    await expect(normalizer({
      artifactId: artifact.id,
      serverId: artifact.serverId,
      request: {
        ...artifact.request,
        actionArgs: {
          ...artifactWithoutTerminal,
          windowsRemoteSessionLaunchMode: 'console',
          windowsRemoteSessionConsole: 'hidden',
          windowsTerminalWindowName: 'Happier predecessor console',
        },
      },
    })).resolves.toEqual(expect.objectContaining({
      input: expect.objectContaining({
        terminal: {
          windows: {
            launchMode: 'console',
            console: 'hidden',
            windowName: 'Happier predecessor console',
          },
        },
      }),
    }));
  });

  it.each([
    ['raw environment variables', { environmentVariables: { TOKEN: 'must-not-cross' } }],
    ['legacy tags', { tags: ['not-a-v2-placement'] }],
    ['runtime selection', { codexBackendMode: 'appServer' }],
    ['old/new hybrid', { executionTarget: { serverId: 'server-1', machineId: 'machine-1' } }],
    ['raw server scope', { serverId: 'server-1' }],
  ])('fails closed for %s', async (_name, extra) => {
    await expect(normalizer({
      artifactId: artifact.id,
      serverId: artifact.serverId,
      request: {
        ...artifact.request,
        actionArgs: { ...artifact.request.actionArgs, ...extra },
      },
    })).resolves.toBeNull();
  });

  it.each([
    ['conflicting prompt aliases', { prompt: 'first prompt', initialMessage: 'second prompt' }],
    ['conflicting directory aliases', { path: '/workspace/other' }],
    ['a whitespace-only metadata label', { tag: ' ' }],
  ])('rejects %s before any V2 Session spawn can be built', async (_name, extra) => {
    await expect(normalizer({
      artifactId: artifact.id,
      serverId: artifact.serverId,
      request: {
        ...artifact.request,
        actionArgs: { ...artifact.request.actionArgs, ...extra },
      },
    })).resolves.toBeNull();
  });

  it('does not reconstruct missing Voice defaults from an incomplete predecessor artifact', async () => {
    await expect(normalizer({
      artifactId: artifact.id,
      serverId: artifact.serverId,
      request: {
        ...artifact.request,
        actionArgs: {
          tag: 'voice artifact',
          agentId: 'voice',
          initialMessage: 'Continue the conversation.',
        },
      },
    })).resolves.toBeNull();
  });

  it('accepts a host assertion only when it can verify the exact local target', async () => {
    await expect(normalizer({
      artifactId: artifact.id,
      serverId: artifact.serverId,
      request: {
        ...artifact.request,
        actionArgs: {
          ...artifact.request.actionArgs,
          machineId: 'machine-local',
          host: 'local-machine',
        },
      },
    })).resolves.toEqual(expect.objectContaining({
      input: expect.objectContaining({
        executionTarget: { serverId: 'server-1', machineId: 'machine-local' },
      }),
    }));
  });

  it('fails closed when a predecessor host assertion does not match the local target', async () => {
    await expect(normalizer({
      artifactId: artifact.id,
      serverId: artifact.serverId,
      request: {
        ...artifact.request,
        actionArgs: {
          ...artifact.request.actionArgs,
          machineId: 'machine-local',
          host: 'different-machine',
        },
      },
    })).resolves.toBeNull();
  });

  it('maps the predecessor customAcp alias only alongside its concrete ACP target', async () => {
    await expect(normalizer({
      artifactId: artifact.id,
      serverId: artifact.serverId,
      request: {
        ...artifact.request,
        actionArgs: {
          ...artifact.request.actionArgs,
          agentId: 'customAcp',
          backendTargetKey: 'acpBackend:review-bot',
        },
      },
    })).resolves.toEqual(expect.objectContaining({
      input: expect.objectContaining({
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.review-bot', localId: 'review-bot' },
        },
      }),
    }));
  });
});
