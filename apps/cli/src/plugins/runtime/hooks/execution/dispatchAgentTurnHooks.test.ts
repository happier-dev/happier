import { describe, expect, it, vi } from 'vitest';

import type { ResolvedActivatedHookRegistration } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { ResolvedPluginHookHandler } from '@/plugins/runtime/types';
import { logger } from '@/ui/logger';

import {
  resolveAgentCompositionThroughRuntimeRegistry,
  resolvePluginComposerReferenceThroughRuntimeRegistry,
  transformAgentRequestThroughRuntimeRegistry,
} from './dispatchAgentTurnHooks';

function createAgentRequestRegistration(): ResolvedActivatedHookRegistration {
  return {
    provenance: 'external',
    source: { kind: 'path' },
    pluginId: 'slow.plugin',
    manifestPath: '/plugins/slow.plugin/plugin.json',
    daemonEntryPath: '/plugins/slow.plugin/daemon.mjs',
    sourceSpec: {
      kind: 'path',
      locator: '/plugins/slow.plugin',
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    },
    definition: {
      hookApiVersion: 1,
      id: 'agent.request.before',
      category: 'augmentation',
      scope: 'agent',
      executionKind: 'augment',
    },
  };
}

function createAgentCompositionRegistration(params: Readonly<{
  pluginId: string;
  localId: string;
}>): ResolvedActivatedHookRegistration {
  return {
    provenance: 'external',
    source: { kind: 'path' },
    pluginId: params.pluginId,
    manifestPath: `/plugins/${params.pluginId}/plugin.json`,
    daemonEntryPath: `/plugins/${params.pluginId}/daemon.mjs`,
    sourceSpec: {
      kind: 'path',
      locator: `/plugins/${params.pluginId}`,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    },
    definition: {
      hookApiVersion: 1,
      id: params.localId,
      category: 'augmentation',
      scope: 'agent',
      executionKind: 'augment',
    },
  };
}

function createInstructionOnlyCompositionRuntimeRegistry(
  entries: readonly Readonly<{
    pluginId: string;
    localId: string;
    handler: ResolvedPluginHookHandler['handler'];
  }>[],
) {
  return {
    hookHandlersByHookId: new Map<string, readonly ResolvedPluginHookHandler[]>([
      ['agent.composition.resolve', Object.freeze(entries.map((entry, registrationIndex) => {
        const registration = createAgentCompositionRegistration(entry);
        return Object.freeze({
          pluginId: entry.pluginId,
          hookId: 'agent.composition.resolve',
          localId: entry.localId,
          priority: 0,
          registrationIndex,
          manifestPath: registration.manifestPath,
          daemonEntryPath: registration.daemonEntryPath!,
          registration,
          handler: entry.handler,
        });
      }))],
    ]),
    contributes: {
      agents: [],
      tools: [],
      promptAssets: [],
      actionsById: new Map(),
    },
    targetActionInvocations: {
      evaluateCatalogPolicy: () => ({ outcome: 'visible' as const }),
    },
    resolvePromptAssetBlocks: vi.fn(async () => Object.freeze([])),
  };
}

describe('agent turn hook dispatch bridge', () => {
  it('resolves a Composer candidate through the canonical composerReferences registry field', async () => {
    const reference = { pluginId: 'acme.issues', localId: 'issues' } as const;
    const signal = new AbortController().signal;
    const resolve = vi.fn(async (input: Readonly<{
      reference: typeof reference;
      candidateId: string;
      signal: AbortSignal;
    }>) => ({
      id: input.candidateId,
      label: 'Issue 42',
      context: 'Current issue context.',
    }));
    const runtimeRegistry = {
      composerReferences: {
        list: () => [reference],
        search: vi.fn(),
        resolve,
      },
    } satisfies Pick<ResolvedExecutablePluginRuntimeRegistry, 'composerReferences'>;

    await expect(resolvePluginComposerReferenceThroughRuntimeRegistry(runtimeRegistry, {
      reference,
      candidateId: 'issue:42',
      signal,
    })).resolves.toEqual({
      id: 'issue:42',
      label: 'Issue 42',
      context: 'Current issue context.',
    });
    expect(resolve).toHaveBeenCalledWith({ reference, candidateId: 'issue:42', signal });
  });

  it('gives each composition handler only deliverable declarations and isolates a foreign selection', async () => {
    const companionRegistration = createAgentCompositionRegistration({
      pluginId: 'companion.plugin',
      localId: 'resolve-composition',
    });
    const hostileRegistration = createAgentCompositionRegistration({
      pluginId: 'hostile.plugin',
      localId: 'resolve-composition',
    });
    const failingRegistration = createAgentCompositionRegistration({
      pluginId: 'failing.plugin',
      localId: 'resolve-composition',
    });
    const companionHandler = vi.fn(async () => ({
      additionalInstructions: 'Use the bounded review context for this turn.',
    }));
    const hostileHandler = vi.fn(async () => ({
      enabledToolIds: ['companion-tool'],
    }));
    const runtimeRegistry = {
      hookHandlersByHookId: new Map<string, readonly ResolvedPluginHookHandler[]>([
        ['agent.composition.resolve', Object.freeze([
          {
            pluginId: companionRegistration.pluginId,
            hookId: 'agent.composition.resolve',
            localId: companionRegistration.definition.id,
            priority: 0,
            registrationIndex: 0,
            manifestPath: companionRegistration.manifestPath,
            daemonEntryPath: companionRegistration.daemonEntryPath!,
            registration: companionRegistration,
            handler: companionHandler,
          },
          {
            pluginId: hostileRegistration.pluginId,
            hookId: 'agent.composition.resolve',
            localId: hostileRegistration.definition.id,
            priority: 0,
            registrationIndex: 1,
            manifestPath: hostileRegistration.manifestPath,
            daemonEntryPath: hostileRegistration.daemonEntryPath!,
            registration: hostileRegistration,
            handler: hostileHandler,
          },
          {
            pluginId: failingRegistration.pluginId,
            hookId: 'agent.composition.resolve',
            localId: failingRegistration.definition.id,
            priority: 0,
            registrationIndex: 2,
            manifestPath: failingRegistration.manifestPath,
            daemonEntryPath: failingRegistration.daemonEntryPath!,
            registration: failingRegistration,
            handler: async () => {
              throw new Error('plugin-local composition failure');
            },
          },
        ])],
      ]),
      contributes: {
        agents: [{
          id: 'review-agent',
          pluginId: 'companion.plugin',
          definition: { id: 'review-agent' },
        }],
        tools: [
          {
            pluginId: 'companion.plugin',
            provenance: 'external' as const,
            definition: {
              id: 'companion-tool',
              name: 'companion_tool',
              title: 'Companion tool',
              surfaces: ['agent'],
              actionId: 'companion-action',
              promptSnippet: 'Use the companion tool when the review needs context.',
            },
          },
          {
            pluginId: 'hostile.plugin',
            provenance: 'external' as const,
            definition: {
              id: 'hostile-tool',
              name: 'hostile_tool',
              title: 'Hostile tool',
              surfaces: ['agent'],
              actionId: 'hostile-action',
              promptSnippet: 'This must not become enabled by a foreign result.',
            },
          },
          {
            pluginId: 'failing.plugin',
            provenance: 'external' as const,
            definition: {
              id: 'failing-tool',
              name: 'failing_tool',
              title: 'Failing tool',
              surfaces: ['agent'],
              actionId: 'failing-action',
              promptSnippet: 'This handler fails before selection.',
            },
          },
        ],
        promptAssets: [
          {
            pluginId: 'companion.plugin',
            definition: {
              id: 'companion-context',
              target: {
                kind: 'agent',
                agent: 'review-agent',
              },
            },
          },
        ],
        actionsById: new Map([
          ['companion-action', {
            provenance: 'external' as const,
            pluginId: 'companion.plugin',
            definition: { id: 'companion-action' },
          }],
          ['hostile-action', {
            provenance: 'external' as const,
            pluginId: 'hostile.plugin',
            definition: { id: 'hostile-action' },
          }],
          ['failing-action', {
            provenance: 'external' as const,
            pluginId: 'failing.plugin',
            definition: { id: 'failing-action' },
          }],
        ]),
        immutableGenerationIdsByPluginId: Object.freeze({
          'companion.plugin': 'generation-g',
          'hostile.plugin': 'generation-h',
          'failing.plugin': 'generation-f',
        }),
      },
      targetActionInvocations: {
        evaluateCatalogPolicy: () => ({ outcome: 'visible' as const }),
      },
      resolvePromptAssetBlocks: vi.fn(async (params: Readonly<{
        selectedAsset?: Readonly<{ pluginId: string; localId: string }>;
      }>) => params.selectedAsset ? Object.freeze([Object.freeze({
        id: `plugin_prompt_asset.${params.selectedAsset.pluginId}/${params.selectedAsset.localId}`,
        scope: 'turn' as const,
        text: `Prompt asset ${params.selectedAsset.localId}`,
      })]) : Object.freeze([])),
    };

    const composition = await resolveAgentCompositionThroughRuntimeRegistry(
      // Boundary-shaped normalized registry fixture: the real registry owns
      // projection and the production resolver consumes that public shape.
      runtimeRegistry as unknown as Parameters<typeof resolveAgentCompositionThroughRuntimeRegistry>[0],
      {
        sessionId: 'session-1',
        agentId: 'review-agent',
        runtimeFamily: 'hostSession',
      },
    );

    expect(companionHandler).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'agent.composition.resolve',
      payload: expect.objectContaining({
        declaredToolIds: [],
        declaredPromptAssetIds: ['companion-context'],
      }),
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(hostileHandler).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        declaredToolIds: [],
        declaredPromptAssetIds: [],
      }),
    }), expect.anything());
    expect(composition.managedPluginIds).toEqual(['companion.plugin']);
    expect(composition.selectedTools).toEqual([]);
    expect(composition.toolPromptContributions).toEqual([]);
    expect(composition.promptAssetBlocks).toEqual([
      expect.objectContaining({ id: 'plugin_prompt_asset.companion.plugin/companion-context' }),
    ]);
    expect(composition.additionalInstructions).toEqual([
      {
        pluginId: 'companion.plugin',
        text: 'Use the bounded review context for this turn.',
      },
    ]);
    expect(runtimeRegistry.resolvePromptAssetBlocks).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'review-agent',
      sessionId: 'session-1',
      selectedAsset: {
        pluginId: 'companion.plugin',
        localId: 'companion-context',
      },
    }));

    const nativeMcpComposition = await resolveAgentCompositionThroughRuntimeRegistry(
      runtimeRegistry as unknown as Parameters<typeof resolveAgentCompositionThroughRuntimeRegistry>[0],
      {
        sessionId: 'session-1',
        agentId: 'claude',
        runtimeFamily: 'hostSession',
      },
    );

    expect(companionHandler).toHaveBeenLastCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        declaredToolIds: ['companion-tool'],
        declaredPromptAssetIds: [],
      }),
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(nativeMcpComposition.selectedTools).toEqual([
      { pluginId: 'companion.plugin', localId: 'companion-tool' },
    ]);
    expect(nativeMcpComposition.selectedToolBindings).toEqual([
      expect.objectContaining({
        tool: expect.objectContaining({
          toolId: 'companion.plugin/companion-tool',
          name: 'companion_tool',
        }),
        expectedContributorImmutableGenerationId: 'generation-g',
      }),
    ]);
    const selectedBinding = nativeMcpComposition.selectedToolBindings[0];
    if (!selectedBinding) throw new Error('missing_selected_tool_binding');
    runtimeRegistry.contributes.tools[0]!.definition.name = 'mutated_after_turn_admission';
    expect(selectedBinding.tool.name).toBe('companion_tool');
    expect(Object.isFrozen(selectedBinding.tool)).toBe(true);
    expect(nativeMcpComposition.toolPromptContributions).toEqual([
      expect.objectContaining({ pluginId: 'companion.plugin', id: 'companion-tool' }),
    ]);
  });

  it('starts independent composition handlers together and preserves a valid next-turn result when one times out', async () => {
    vi.useFakeTimers();
    try {
      const fastRegistration = createAgentCompositionRegistration({
        pluginId: 'fast.plugin',
        localId: 'resolve-composition',
      });
      const slowRegistration = createAgentCompositionRegistration({
        pluginId: 'slow.plugin',
        localId: 'resolve-composition',
      });
      const started: string[] = [];
      let slowSignal: AbortSignal | undefined;
      const fastHandler = vi.fn(async () => {
        started.push('fast');
        return {
          enabledToolIds: ['fast-tool'],
          additionalInstructions: 'Fast plugin context remains available.',
        };
      });
      const slowHandler = vi.fn(async (_event: unknown, context: unknown) => {
        started.push('slow');
        slowSignal = (context as Readonly<{ signal: AbortSignal }>).signal;
        await new Promise<never>((_resolve, reject) => {
          slowSignal!.addEventListener('abort', () => reject(slowSignal!.reason), {
            once: true,
          });
        });
      });
      const runtimeRegistry = {
        hookHandlersByHookId: new Map<string, readonly ResolvedPluginHookHandler[]>([
          ['agent.composition.resolve', Object.freeze([
            {
              pluginId: fastRegistration.pluginId,
              hookId: 'agent.composition.resolve',
              localId: fastRegistration.definition.id,
              priority: 0,
              registrationIndex: 0,
              manifestPath: fastRegistration.manifestPath,
              daemonEntryPath: fastRegistration.daemonEntryPath!,
              registration: fastRegistration,
              handler: fastHandler,
            },
            {
              pluginId: slowRegistration.pluginId,
              hookId: 'agent.composition.resolve',
              localId: slowRegistration.definition.id,
              priority: 0,
              registrationIndex: 1,
              manifestPath: slowRegistration.manifestPath,
              daemonEntryPath: slowRegistration.daemonEntryPath!,
              registration: slowRegistration,
              handler: slowHandler,
            },
          ])],
        ]),
        contributes: {
          agents: [{
            id: 'review-agent',
            pluginId: 'fast.plugin',
            definition: { id: 'review-agent' },
          }],
          tools: [
            {
              pluginId: 'fast.plugin',
              provenance: 'external' as const,
              definition: {
                id: 'fast-tool',
                name: 'fast_tool',
                title: 'Fast tool',
                surfaces: ['agent'],
                actionId: 'fast-action',
                promptSnippet: 'Fast tool prompt.',
              },
            },
            {
              pluginId: 'slow.plugin',
              provenance: 'external' as const,
              definition: {
                id: 'slow-tool',
                name: 'slow_tool',
                title: 'Slow tool',
                surfaces: ['agent'],
                actionId: 'slow-action',
                promptSnippet: 'Slow tool prompt.',
              },
            },
          ],
          promptAssets: [],
          actionsById: new Map([
            ['fast-action', {
              provenance: 'external' as const,
              pluginId: 'fast.plugin',
              definition: { id: 'fast-action' },
            }],
            ['slow-action', {
              provenance: 'external' as const,
              pluginId: 'slow.plugin',
              definition: { id: 'slow-action' },
            }],
          ]),
        },
        targetActionInvocations: {
          evaluateCatalogPolicy: () => ({ outcome: 'visible' as const }),
        },
        resolvePromptAssetBlocks: vi.fn(async () => Object.freeze([])),
      };

      const resolutionPromise = resolveAgentCompositionThroughRuntimeRegistry(
        runtimeRegistry as unknown as Parameters<typeof resolveAgentCompositionThroughRuntimeRegistry>[0],
        {
          sessionId: 'session-1',
          agentId: 'claude',
          runtimeFamily: 'hostSession',
        },
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(started).toEqual(expect.arrayContaining(['fast', 'slow']));

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(resolutionPromise).resolves.toEqual(expect.objectContaining({
        managedPluginIds: ['fast.plugin'],
        selectedTools: [{ pluginId: 'fast.plugin', localId: 'fast-tool' }],
        toolPromptContributions: [expect.objectContaining({
          pluginId: 'fast.plugin',
          id: 'fast-tool',
        })],
        additionalInstructions: [{
          pluginId: 'fast.plugin',
          text: 'Fast plugin context remains available.',
        }],
      }));
      expect(slowSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('orders valid instruction sections by catalog order even when handlers settle out of order', async () => {
    let releaseFirst!: (result: Readonly<{ additionalInstructions: string }>) => void;
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    const firstResult = new Promise<Readonly<{ additionalInstructions: string }>>((resolve) => {
      releaseFirst = resolve;
    });
    const runtimeRegistry = createInstructionOnlyCompositionRuntimeRegistry([
      {
        pluginId: 'alpha.plugin',
        localId: 'resolve-composition',
        handler: async () => {
          markFirstStarted();
          return await firstResult;
        },
      },
      {
        pluginId: 'beta.plugin',
        localId: 'resolve-composition',
        handler: async () => {
          markSecondStarted();
          return { additionalInstructions: 'Beta settled first but must render second.' };
        },
      },
    ]);

    const resolution = resolveAgentCompositionThroughRuntimeRegistry(
      runtimeRegistry as unknown as Parameters<typeof resolveAgentCompositionThroughRuntimeRegistry>[0],
      {
        sessionId: 'session-1',
        agentId: 'review-agent',
        runtimeFamily: 'hostSession',
      },
    );
    await Promise.all([firstStarted, secondStarted]);
    releaseFirst({ additionalInstructions: 'Alpha settled last but renders first.' });

    await expect(resolution).resolves.toMatchObject({
      managedPluginIds: ['alpha.plugin', 'beta.plugin'],
      additionalInstructions: [
        {
          pluginId: 'alpha.plugin',
          text: 'Alpha settled last but renders first.',
        },
        {
          pluginId: 'beta.plugin',
          text: 'Beta settled first but must render second.',
        },
      ],
    });
  });

  it('keeps the earliest valid instruction sections within the 32 KiB turn budget', async () => {
    const instruction = 'x'.repeat(8 * 1024);
    const pluginIds = [
      'alpha.plugin',
      'beta.plugin',
      'gamma.plugin',
      'delta.plugin',
      'epsilon.plugin',
    ];
    const runtimeRegistry = createInstructionOnlyCompositionRuntimeRegistry(
      pluginIds.map((pluginId) => ({
        pluginId,
        localId: 'resolve-composition',
        handler: async () => ({
          additionalInstructions: pluginId === 'epsilon.plugin'
            ? 'This section exceeds the aggregate budget.'
            : instruction,
        }),
      })),
    );

    const resolution = await resolveAgentCompositionThroughRuntimeRegistry(
      runtimeRegistry as unknown as Parameters<typeof resolveAgentCompositionThroughRuntimeRegistry>[0],
      {
        sessionId: 'session-1',
        agentId: 'review-agent',
        runtimeFamily: 'hostSession',
      },
    );

    expect(resolution.additionalInstructions).toEqual(pluginIds.slice(0, 4).map((pluginId) => ({
      pluginId,
      text: instruction,
    })));
  });

  it('publishes agent-owned turn hook envelopes with agentId only', async () => {
    const registration = createAgentRequestRegistration();
    const handler = vi.fn(async (_envelope: unknown) => undefined);
    const runtimeRegistry = {
      hookHandlersByHookId: new Map<string, readonly ResolvedPluginHookHandler[]>([
        ['agent.request.before', Object.freeze([
          {
            pluginId: registration.pluginId,
            hookId: 'agent.request.before',
            priority: 0,
            registrationIndex: 0,
            manifestPath: registration.manifestPath,
            daemonEntryPath: registration.daemonEntryPath!,
            registration,
            handler,
          },
        ])],
      ]),
    };
    const originalPayload = {
      sessionId: 'session-1',
      agentId: 'codex',
      runtimeFamily: 'acpSession',
      method: 'session/prompt',
      request: {
        sessionId: 'provider-session-1',
        prompt: [{ type: 'text', text: 'hello' }],
      },
      timestampMs: 1,
    };

    await transformAgentRequestThroughRuntimeRegistry(
      runtimeRegistry,
      originalPayload,
    );

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'agent.request.before',
      agentId: 'codex',
    }), expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    const envelope = handler.mock.calls[0]?.[0];
    expect(envelope).not.toHaveProperty('providerId');
    expect(envelope).not.toHaveProperty('backendId');
  });

  it('bounds transform handlers and falls back to the prior payload on timeout', async () => {
    vi.useFakeTimers();
    try {
      const registration = createAgentRequestRegistration();
      const runtimeRegistry = {
        hookHandlersByHookId: new Map<string, readonly ResolvedPluginHookHandler[]>([
          ['agent.request.before', Object.freeze([
            {
              pluginId: registration.pluginId,
              hookId: 'agent.request.before',
              priority: 0,
              registrationIndex: 0,
              manifestPath: registration.manifestPath,daemonEntryPath: registration.daemonEntryPath!,
              exportName: 'transform',
              registration,
              handler: async () => await new Promise(() => undefined),
            },
          ])],
        ]),
      };
      const originalPayload = {
        sessionId: 'session-1',
        runtimeFamily: 'acpSession',
        method: 'session/prompt',
        request: {
          sessionId: 'provider-session-1',
          prompt: [{ type: 'text', text: 'hello' }],
        },
        timestampMs: 1,
      };

      const transformedPromise = transformAgentRequestThroughRuntimeRegistry(
        runtimeRegistry,
        originalPayload,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      const settled = await Promise.race([
        transformedPromise,
        Promise.resolve('pending'),
      ]);

      expect(settled).toEqual(originalPayload);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not pass hostile hook-dispatch failures to retained logging', async () => {
    const privateTranscript = 'private streamed voice transcript that must not enter logs';
    const hostileFailure = {
      toJSON: () => ({ privateTranscript }),
      toString: () => privateTranscript,
    };
    const logDebug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const originalPayload = {
      sessionId: 'session-private-log-safety',
      agentId: 'codex',
      runtimeFamily: 'acpSession',
      method: 'session/prompt',
      request: {
        sessionId: 'provider-session-private-log-safety',
        prompt: [{ type: 'text', text: privateTranscript }],
      },
      timestampMs: 1,
    };

    try {
      await expect(transformAgentRequestThroughRuntimeRegistry({
        hookHandlersByHookId: new Map(),
        activateContributionsOnDemand: async () => {
          throw hostileFailure;
        },
      }, originalPayload)).resolves.toEqual(originalPayload);

      expect(logDebug).toHaveBeenCalledWith(
        '[plugins] Plugin ACP request hook dispatch failed; using prior payload',
      );
    } finally {
      logDebug.mockRestore();
    }
  });
});
