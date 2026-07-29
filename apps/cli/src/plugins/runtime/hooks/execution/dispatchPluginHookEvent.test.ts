import { describe, expect, it, vi } from 'vitest';
import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import type { ResolvedActivatedHookRegistration } from '@/plugins/projection/registry/types';
import { logger } from '@/ui/logger';

import { dispatchPluginHookEvent } from './dispatchPluginHookEvent';

function createBackendPrerequisiteHookRegistration(params: Readonly<{
  pluginId: string;
  exportName: string;
  agentIdFilter?: string;
  providerIdFilter?: string;
  backendIdFilter?: string;
}>): ResolvedActivatedHookRegistration {
  return {
    provenance: 'external',
    source: { kind: 'path' },
    pluginId: params.pluginId,
    manifestPath: `/plugins/${params.pluginId}/plugin.json`,
    manifestDigest: `sha256:${params.pluginId}`,
    daemonEntryPath: `/plugins/${params.pluginId}/daemon.mjs`,
    sourceSpec: {
      kind: 'path',
      locator: `/plugins/${params.pluginId}`,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    },
    definition: {
      hookApiVersion: 1,
      id: 'agent.resolvePrerequisites',
      category: 'decision',
      scope: 'agent',
      executionKind: 'decide',
      ...(params.agentIdFilter || params.providerIdFilter || params.backendIdFilter
        ? {
            filters: {
              ...(params.agentIdFilter ? { agentId: params.agentIdFilter } : {}),
              ...(params.providerIdFilter ? { providerId: params.providerIdFilter } : {}),
              ...(params.backendIdFilter ? { backendId: params.backendIdFilter } : {}),
            },
          }
        : {}),
    },
  };
}

describe('dispatchPluginHookEvent', () => {
  it('keeps authorized stream-token input raw for the plugin but sanitizes every Happier-owned failure surface', async () => {
    const sensitiveTokenText = 'private transcript with sk-live-claim-45';
    const publishHookObservation = vi.fn(async () => undefined);
    const logDebug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const registration: ResolvedActivatedHookRegistration = {
      provenance: 'external',
      source: { kind: 'path' },
      pluginId: 'echo.plugin',
      manifestPath: '/plugins/echo/plugin.json',
      manifestDigest: 'sha256:echo',
      daemonEntryPath: '/plugins/echo/daemon.mjs',
      sourceSpec: {
        kind: 'path',
        locator: '/plugins/echo',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
      definition: {
        hookApiVersion: 1,
        id: 'agent.stream.token',
        category: 'lifecycle',
        scope: 'agent',
        executionKind: 'observe',
      },
    };
    const handler = vi.fn(async (event: unknown) => {
      const tokenText = (event as Readonly<{
        payload: Readonly<{ tokenText: string }>;
      }>).payload.tokenText;
      expect(tokenText).toBe(sensitiveTokenText);
      const pluginError = new Error(`plugin echoed sensitive input: ${tokenText}`, {
        cause: new Error(`nested plugin cause echoed sensitive input: ${tokenText}`),
      });
      throw new Proxy(pluginError, {
        getPrototypeOf() {
          throw new Error(`plugin getPrototypeOf trap echoed sensitive input: ${tokenText}`);
        },
        get(target, property, receiver) {
          if (property === 'toString' || property === Symbol.toPrimitive) {
            throw new Error(`plugin coercion trap echoed sensitive input: ${tokenText}`);
          }
          return Reflect.get(target, property, receiver);
        },
      });
    });

    try {
      const result = await dispatchPluginHookEvent({
        runtimeRegistry: {
          readHookEventEnvelopeV1,
          hookHandlersByHookId: new Map([[
            'agent.stream.token',
            [{
              pluginId: 'echo.plugin',
              hookId: 'agent.stream.token',
              priority: 0,
              registrationIndex: 0,
              manifestPath: registration.manifestPath,
              manifestDigest: registration.manifestDigest,
              daemonEntryPath: registration.daemonEntryPath!,
              exportName: 'observeToken',
              registration,
              handler,
            }],
          ]]),
        },
        event: {
          hookVersion: 1,
          eventId: 'agent.stream.token',
          category: 'lifecycle',
          scope: 'agent',
          happySessionId: 'session-claim-45',
          agentId: 'codex',
          turnId: 'turn-claim-45',
          timestampMs: 1,
          payload: {
            sessionId: 'session-claim-45',
            agentId: 'codex',
            runtimeFamily: 'hostSession',
            turnId: 'turn-claim-45',
            tokenText: sensitiveTokenText,
            streamKind: 'assistant',
            timestampMs: 1,
          },
        },
        publishHookObservation,
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(result.outcomes).toEqual([{
        pluginId: 'echo.plugin',
        hookId: 'agent.stream.token',
        status: 'rejected',
        error: 'plugin_hook_handler_failed',
      }]);
      expect(publishHookObservation).toHaveBeenCalledWith({
        pluginId: 'echo.plugin',
        hookId: 'agent.stream.token',
        status: 'rejected',
        durationMs: expect.any(Number),
        error: 'plugin_hook_handler_failed',
      });
      expect(logDebug).toHaveBeenCalledWith(
        '[plugins] Plugin hook handler failed',
        {
          pluginId: 'echo.plugin',
          hookId: 'agent.stream.token',
          error: 'plugin_hook_handler_failed',
        },
      );

      const happierOwnedFailureSurfaces = JSON.stringify({
        result,
        analytics: publishHookObservation.mock.calls,
        logs: logDebug.mock.calls,
      });
      expect(happierOwnedFailureSurfaces).not.toContain(sensitiveTokenText);
      expect(happierOwnedFailureSurfaces).not.toContain('plugin echoed sensitive input');
      expect(happierOwnedFailureSurfaces).not.toContain('nested plugin cause');
      expect(happierOwnedFailureSurfaces).not.toContain('plugin getPrototypeOf trap');
      expect(happierOwnedFailureSurfaces).not.toContain('plugin coercion trap');
    } finally {
      logDebug.mockRestore();
    }
  });

  it('parses hook envelopes through the canonical protocol owner instead of a registry method-presence fallback', async () => {
    const obsoleteParser = vi.fn(() => null);

    const result = await dispatchPluginHookEvent({
      runtimeRegistry: {
        readHookEventEnvelopeV1: obsoleteParser,
        hookHandlersByHookId: new Map(),
      },
      event: {
        hookVersion: 1,
        eventId: 'agent.resolvePrerequisites',
        category: 'decision',
        scope: 'agent',
        agentId: 'codex',
        timestampMs: 1,
        payload: {
          agentId: 'codex',
          backendId: 'codex',
          cwd: '/workspace',
          env: {},
        },
      },
    });

    expect(result.eventId).toBe('agent.resolvePrerequisites');
    expect(obsoleteParser).not.toHaveBeenCalled();
  });

  it('fails closed for invalid fail-closed decision hook payloads', async () => {
    const result = await dispatchPluginHookEvent({
      runtimeRegistry: {
        readHookEventEnvelopeV1,
        hookHandlersByHookId: new Map(),
      },
      event: {
        hookVersion: 1,
        eventId: 'agent.resolvePrerequisites',
        category: 'decision',
        scope: 'agent',
        agentId: 'codex',
        timestampMs: 1,
        payload: {
          backendId: 'codex',
        },
      },
    });

    expect(result).toMatchObject({
      eventId: 'agent.resolvePrerequisites',
      matchedHandlerCount: 0,
      validationError: expect.stringContaining('Invalid payload'),
      aggregate: {
        executionKind: 'decide',
        result: {
          decision: 'deny',
        },
      },
    });
  });

  it('aggregates augment hook object results in deterministic handler order', async () => {
    const result = await dispatchPluginHookEvent({
      runtimeRegistry: {
        readHookEventEnvelopeV1,
        hookHandlersByHookId: new Map([
          [
            'agent.spawnEnv.augment',
            [
              {
                pluginId: 'alpha.plugin',
                hookId: 'agent.spawnEnv.augment',
                priority: 10,
                registrationIndex: 0,
                manifestPath: '/plugins/alpha/plugin.json',
                manifestDigest: 'sha256:alpha',
                daemonEntryPath: '/plugins/alpha/daemon.mjs',
                exportName: 'augmentSpawn',
                registration: {
                  provenance: 'external',
                  source: { kind: 'path' },
                  pluginId: 'alpha.plugin',
                  manifestPath: '/plugins/alpha/plugin.json',
                  manifestDigest: 'sha256:alpha',
                  daemonEntryPath: '/plugins/alpha/daemon.mjs',
                  sourceSpec: {
                    kind: 'path',
                    locator: '/plugins/alpha',
                    trustPolicy: 'local_trusted',
                    installPolicy: 'link',
                  },
                  definition: {
                    hookApiVersion: 1,
                    id: 'agent.spawnEnv.augment',
                    category: 'augmentation',
                    scope: 'daemon',
                    executionKind: 'augment',
                    handler: {
                      target: 'plugin',
                      exportName: 'augmentSpawn',
                    },
                  },
                },
                handler: async () => ({ firstAugment: true }),
              },
              {
                pluginId: 'beta.plugin',
                hookId: 'agent.spawnEnv.augment',
                priority: 0,
                registrationIndex: 1,
                manifestPath: '/plugins/beta/plugin.json',
                manifestDigest: 'sha256:beta',
                daemonEntryPath: '/plugins/beta/daemon.mjs',
                exportName: 'augmentSpawn',
                registration: {
                  provenance: 'external',
                  source: { kind: 'path' },
                  pluginId: 'beta.plugin',
                  manifestPath: '/plugins/beta/plugin.json',
                  manifestDigest: 'sha256:beta',
                  daemonEntryPath: '/plugins/beta/daemon.mjs',
                  sourceSpec: {
                    kind: 'path',
                    locator: '/plugins/beta',
                    trustPolicy: 'local_trusted',
                    installPolicy: 'link',
                  },
                  definition: {
                    hookApiVersion: 1,
                    id: 'agent.spawnEnv.augment',
                    category: 'augmentation',
                    scope: 'daemon',
                    executionKind: 'augment',
                    handler: {
                      target: 'plugin',
                      exportName: 'augmentSpawn',
                    },
                  },
                },
                handler: async () => ({ secondAugment: true }),
              },
            ],
          ],
        ]),
      },
      event: {
        hookVersion: 1,
        eventId: 'agent.spawnEnv.augment',
        category: 'augmentation',
        scope: 'daemon',
        agentId: 'codex',
        timestampMs: 1,
        payload: {
          backendId: 'codex',
          agentId: 'codex',
          timestampMs: 1,
        },
      },
    });

    expect(result).toMatchObject({
      eventId: 'agent.spawnEnv.augment',
      matchedHandlerCount: 2,
      aggregate: {
        executionKind: 'augment',
        result: {
          firstAugment: true,
          secondAugment: true,
        },
      },
    });
  });

  it('matches agent-owned hook registrations by filters.agentId only', async () => {
    const codexHandler = vi.fn(async () => ({ codex: true }));
    const otherHandler = vi.fn(async () => ({ other: true }));

    const result = await dispatchPluginHookEvent({
      runtimeRegistry: {
        readHookEventEnvelopeV1,
        hookHandlersByHookId: new Map([
          [
            'agent.spawnEnv.augment',
            [
              {
                pluginId: 'codex.plugin',
                hookId: 'agent.spawnEnv.augment',
                priority: 0,
                registrationIndex: 0,
                manifestPath: '/plugins/codex/plugin.json',
                manifestDigest: 'sha256:codex',
                daemonEntryPath: '/plugins/codex/daemon.mjs',
                exportName: 'augmentCodex',
                registration: {
                  provenance: 'external',
                  source: { kind: 'path' },
                  pluginId: 'codex.plugin',
                  manifestPath: '/plugins/codex/plugin.json',
                  manifestDigest: 'sha256:codex',
                  daemonEntryPath: '/plugins/codex/daemon.mjs',
                  sourceSpec: {
                    kind: 'path',
                    locator: '/plugins/codex',
                    trustPolicy: 'local_trusted',
                    installPolicy: 'link',
                  },
                  definition: {
                    hookApiVersion: 1,
                    id: 'agent.spawnEnv.augment',
                    category: 'augmentation',
                    scope: 'daemon',
                    executionKind: 'augment',
                    filters: { agentId: 'codex' },
                    handler: {
                      target: 'plugin',
                      exportName: 'augmentCodex',
                    },
                  },
                },
                handler: codexHandler,
              },
              {
                pluginId: 'other.plugin',
                hookId: 'agent.spawnEnv.augment',
                priority: 0,
                registrationIndex: 1,
                manifestPath: '/plugins/other/plugin.json',
                manifestDigest: 'sha256:other',
                daemonEntryPath: '/plugins/other/daemon.mjs',
                exportName: 'augmentOther',
                registration: {
                  provenance: 'external',
                  source: { kind: 'path' },
                  pluginId: 'other.plugin',
                  manifestPath: '/plugins/other/plugin.json',
                  manifestDigest: 'sha256:other',
                  daemonEntryPath: '/plugins/other/daemon.mjs',
                  sourceSpec: {
                    kind: 'path',
                    locator: '/plugins/other',
                    trustPolicy: 'local_trusted',
                    installPolicy: 'link',
                  },
                  definition: {
                    hookApiVersion: 1,
                    id: 'agent.spawnEnv.augment',
                    category: 'augmentation',
                    scope: 'daemon',
                    executionKind: 'augment',
                    filters: { agentId: 'other' },
                    handler: {
                      target: 'plugin',
                      exportName: 'augmentOther',
                    },
                  },
                },
                handler: otherHandler,
              },
            ],
          ],
        ]),
      },
      event: {
        hookVersion: 1,
        eventId: 'agent.spawnEnv.augment',
        category: 'augmentation',
        scope: 'daemon',
        agentId: 'codex',
        providerId: 'other',
        backendId: 'other',
        timestampMs: 1,
        payload: {
          agentId: 'codex',
          timestampMs: 1,
        },
      },
    });

    expect(result).toMatchObject({
      eventId: 'agent.spawnEnv.augment',
      matchedHandlerCount: 1,
      aggregate: {
        executionKind: 'augment',
        result: {
          codex: true,
        },
      },
    });
    expect(codexHandler).toHaveBeenCalledTimes(1);
    expect(otherHandler).not.toHaveBeenCalled();
  });

  it('does not match retired providerId or backendId filters for agent-owned hooks', async () => {
    const providerAliasHandler = vi.fn(async () => ({ providerAlias: true }));
    const backendAliasHandler = vi.fn(async () => ({ backendAlias: true }));

    const result = await dispatchPluginHookEvent({
      runtimeRegistry: {
        readHookEventEnvelopeV1,
        hookHandlersByHookId: new Map([
          [
            'agent.spawnEnv.augment',
            [
              {
                pluginId: 'provider-alias.plugin',
                hookId: 'agent.spawnEnv.augment',
                priority: 0,
                registrationIndex: 0,
                manifestPath: '/plugins/provider-alias/plugin.json',
                manifestDigest: 'sha256:provider-alias',
                daemonEntryPath: '/plugins/provider-alias/daemon.mjs',
                exportName: 'providerAlias',
                registration: {
                  provenance: 'external',
                  source: { kind: 'path' },
                  pluginId: 'provider-alias.plugin',
                  manifestPath: '/plugins/provider-alias/plugin.json',
                  manifestDigest: 'sha256:provider-alias',
                  daemonEntryPath: '/plugins/provider-alias/daemon.mjs',
                  sourceSpec: {
                    kind: 'path',
                    locator: '/plugins/provider-alias',
                    trustPolicy: 'local_trusted',
                    installPolicy: 'link',
                  },
                  definition: {
                    hookApiVersion: 1,
                    id: 'agent.spawnEnv.augment',
                    category: 'augmentation',
                    scope: 'daemon',
                    executionKind: 'augment',
                    filters: { providerId: 'codex' },
                    handler: {
                      target: 'plugin',
                      exportName: 'providerAlias',
                    },
                  },
                },
                handler: providerAliasHandler,
              },
              {
                pluginId: 'backend-alias.plugin',
                hookId: 'agent.spawnEnv.augment',
                priority: 0,
                registrationIndex: 1,
                manifestPath: '/plugins/backend-alias/plugin.json',
                manifestDigest: 'sha256:backend-alias',
                daemonEntryPath: '/plugins/backend-alias/daemon.mjs',
                exportName: 'backendAlias',
                registration: {
                  provenance: 'external',
                  source: { kind: 'path' },
                  pluginId: 'backend-alias.plugin',
                  manifestPath: '/plugins/backend-alias/plugin.json',
                  manifestDigest: 'sha256:backend-alias',
                  daemonEntryPath: '/plugins/backend-alias/daemon.mjs',
                  sourceSpec: {
                    kind: 'path',
                    locator: '/plugins/backend-alias',
                    trustPolicy: 'local_trusted',
                    installPolicy: 'link',
                  },
                  definition: {
                    hookApiVersion: 1,
                    id: 'agent.spawnEnv.augment',
                    category: 'augmentation',
                    scope: 'daemon',
                    executionKind: 'augment',
                    filters: { backendId: 'codex' },
                    handler: {
                      target: 'plugin',
                      exportName: 'backendAlias',
                    },
                  },
                },
                handler: backendAliasHandler,
              },
            ],
          ],
        ]),
      },
      event: {
        hookVersion: 1,
        eventId: 'agent.spawnEnv.augment',
        category: 'augmentation',
        scope: 'daemon',
        agentId: 'codex',
        providerId: 'codex',
        backendId: 'codex',
        timestampMs: 1,
        payload: {
          agentId: 'codex',
          timestampMs: 1,
        },
      },
    });

    expect(result).toMatchObject({
      eventId: 'agent.spawnEnv.augment',
      matchedHandlerCount: 0,
    });
    expect(providerAliasHandler).not.toHaveBeenCalled();
    expect(backendAliasHandler).not.toHaveBeenCalled();
  });

  it('passes caller-provided dispatch context to matched hook handlers', async () => {
    const handler = vi.fn(async () => ({ decision: 'allow' as const }));
    const context = Object.freeze({
      tools: Object.freeze({
        resolveManagedInstallable: vi.fn(),
      }),
    });

    await dispatchPluginHookEvent({
      runtimeRegistry: {
        readHookEventEnvelopeV1,
        hookHandlersByHookId: new Map([
          [
            'agent.resolvePrerequisites',
            [
              {
                pluginId: 'acme.plugin',
                hookId: 'agent.resolvePrerequisites',
                priority: 0,
                registrationIndex: 0,
                manifestPath: '/plugins/acme/plugin.json',
                manifestDigest: 'sha256:acme',
                daemonEntryPath: '/plugins/acme/daemon.mjs',
                exportName: 'validateSpawn',
                registration: {
                  provenance: 'external',
                  source: { kind: 'path' },
                  pluginId: 'acme.plugin',
                  manifestPath: '/plugins/acme/plugin.json',
                  manifestDigest: 'sha256:acme',
                  daemonEntryPath: '/plugins/acme/daemon.mjs',
                  sourceSpec: {
                    kind: 'path',
                    locator: '/plugins/acme',
                    trustPolicy: 'local_trusted',
                    installPolicy: 'link',
                  },
                  definition: {
                    hookApiVersion: 1,
                    id: 'agent.resolvePrerequisites',
                    category: 'decision',
                    scope: 'agent',
                    executionKind: 'decide',
                    handler: {
                      target: 'plugin',
                      exportName: 'validateSpawn',
                    },
                  },
                },
                handler,
              },
            ],
          ],
        ]),
      },
      event: {
        hookVersion: 1,
        eventId: 'agent.resolvePrerequisites',
        category: 'decision',
        scope: 'agent',
        agentId: 'codex',
        timestampMs: 1,
        payload: {
          backendId: 'codex',
          targetRef: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          runtimeTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          agentId: 'codex',
          timestampMs: 1,
        },
      },
      context,
    });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'agent.resolvePrerequisites',
    }), context);
  });

  it('aborts a timed-out handler context, denies its late effect, and cleans up merged-signal listeners', async () => {
    const registration = createBackendPrerequisiteHookRegistration({
      pluginId: 'acme.plugin',
      exportName: 'validateSpawn',
    });
    const callerController = new AbortController();
    const addEventListener = vi.spyOn(callerController.signal, 'addEventListener');
    const removeEventListener = vi.spyOn(callerController.signal, 'removeEventListener');
    const lateEffect = vi.fn();
    let resumeHandler: (() => void) | undefined;
    let receivedSignal: AbortSignal | undefined;
    const handler = vi.fn(async (_event: unknown, context: unknown) => {
      const record = context as Readonly<{ signal?: AbortSignal; tools?: unknown }>;
      receivedSignal = record.signal;
      expect(record.tools).toEqual({ marker: 'preserved' });
      await new Promise<void>((resolve) => {
        resumeHandler = resolve;
      });
      if (record.signal?.aborted) {
        const error = new Error('late hook effect denied');
        error.name = 'AbortError';
        throw error;
      }
      lateEffect();
      return { decision: 'allow' as const };
    });

    const result = await dispatchPluginHookEvent({
      runtimeRegistry: {
        readHookEventEnvelopeV1,
        hookHandlersByHookId: new Map([[
          'agent.resolvePrerequisites',
          [{
            pluginId: 'acme.plugin',
            hookId: 'agent.resolvePrerequisites',
            priority: 0,
            registrationIndex: 0,
            manifestPath: registration.manifestPath,
            manifestDigest: registration.manifestDigest,
            daemonEntryPath: registration.daemonEntryPath!,
            exportName: 'validateSpawn',
            registration,
            handler,
          }],
        ]]),
      },
      event: {
        hookVersion: 1,
        eventId: 'agent.resolvePrerequisites',
        category: 'decision',
        scope: 'agent',
        agentId: 'codex',
        timestampMs: 1,
        payload: {
          agentId: 'codex',
          runtimeTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          timestampMs: 1,
        },
      },
      context: {
        signal: callerController.signal,
        tools: { marker: 'preserved' },
      },
      handlerTimeoutMs: 1,
    });

    expect(result.outcomes).toEqual([
      expect.objectContaining({
        pluginId: 'acme.plugin',
        status: 'rejected',
        error: 'plugin_hook_handler_timed_out',
      }),
    ]);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal).not.toBe(callerController.signal);
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toMatchObject({
      name: 'PluginHookHandlerTimeoutError',
      message: 'plugin_hook_handler_timed_out',
    });
    expect(addEventListener).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledOnce();

    resumeHandler?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(lateEffect).not.toHaveBeenCalled();
  });

  it('fails closed for decide hooks when a matched handler rejects', async () => {
    const result = await dispatchPluginHookEvent({
      runtimeRegistry: {
        readHookEventEnvelopeV1,
        hookHandlersByHookId: new Map([
          [
            'agent.resolvePrerequisites',
            [
              {
                pluginId: 'acme.plugin',
                hookId: 'agent.resolvePrerequisites',
                priority: 0,
                registrationIndex: 0,
                manifestPath: '/plugins/acme/plugin.json',
                manifestDigest: 'sha256:acme',
                daemonEntryPath: '/plugins/acme/daemon.mjs',
                exportName: 'denySpawn',
                registration: {
                  provenance: 'external',
                  source: { kind: 'path' },
                  pluginId: 'acme.plugin',
                  manifestPath: '/plugins/acme/plugin.json',
                  manifestDigest: 'sha256:acme',
                  daemonEntryPath: '/plugins/acme/daemon.mjs',
                  sourceSpec: {
                    kind: 'path',
                    locator: '/plugins/acme',
                    trustPolicy: 'local_trusted',
                    installPolicy: 'link',
                  },
                  definition: {
                    hookApiVersion: 1,
                    id: 'agent.resolvePrerequisites',
                    category: 'decision',
                    scope: 'agent',
                    executionKind: 'decide',
                    handler: {
                      target: 'plugin',
                      exportName: 'denySpawn',
                    },
                  },
                },
                handler: async () => {
                  throw new Error('spawn blocked');
                },
              },
            ],
          ],
        ]),
      },
      event: {
        hookVersion: 1,
        eventId: 'agent.resolvePrerequisites',
        category: 'decision',
        scope: 'agent',
        agentId: 'codex',
        timestampMs: 1,
        payload: {
          backendId: 'codex',
          targetRef: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          runtimeTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          agentId: 'codex',
          timestampMs: 1,
        },
      },
    });

    expect(result).toMatchObject({
      eventId: 'agent.resolvePrerequisites',
      matchedHandlerCount: 1,
      aggregate: {
        executionKind: 'decide',
        result: {
          decision: 'deny',
        },
      },
      outcomes: [
        expect.objectContaining({
          pluginId: 'acme.plugin',
          status: 'rejected',
          error: 'plugin_hook_handler_failed',
        }),
      ],
    });
  });

  it('does not let a retired static hook registration participate in fail-closed authority', async () => {
    const availableRegistration = createBackendPrerequisiteHookRegistration({
      pluginId: 'available.plugin',
      exportName: 'allowSpawn',
      agentIdFilter: 'codex',
    });
    const unavailableRegistration = createBackendPrerequisiteHookRegistration({
      pluginId: 'missing.plugin',
      exportName: 'missingSpawn',
    });

    // This fixture represents runtime bytes that the canonical typed owner no longer admits.
    const retiredStaticRegistry = {
      readHookEventEnvelopeV1,
      contributes: {
        hookRegistrations: Object.freeze([
          availableRegistration,
          unavailableRegistration,
        ]),
      },
      hookHandlersByHookId: new Map([
        [
          'agent.resolvePrerequisites',
          [
            {
              pluginId: 'available.plugin',
              hookId: 'agent.resolvePrerequisites',
              priority: 0,
              registrationIndex: 0,
              manifestPath: availableRegistration.manifestPath,
              manifestDigest: availableRegistration.manifestDigest,
              daemonEntryPath: '/plugins/available.plugin/daemon.mjs',
              exportName: 'allowSpawn',
              registration: availableRegistration,
              handler: async () => ({ decision: 'allow' as const }),
            },
          ],
        ],
      ]),
    } as unknown as Parameters<typeof dispatchPluginHookEvent>[0]['runtimeRegistry'];

    const result = await dispatchPluginHookEvent({
      runtimeRegistry: retiredStaticRegistry,
      event: {
        hookVersion: 1,
        eventId: 'agent.resolvePrerequisites',
        category: 'decision',
        scope: 'agent',
        agentId: 'codex',
        timestampMs: 1,
        payload: {
          backendId: 'codex',
          targetRef: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          runtimeTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          agentId: 'codex',
          timestampMs: 1,
        },
      },
    });

    expect(result).toMatchObject({
      eventId: 'agent.resolvePrerequisites',
      matchedHandlerCount: 1,
      aggregate: {
        executionKind: 'decide',
        result: {
          decision: 'allow',
        },
      },
      outcomes: [
        expect.objectContaining({
          pluginId: 'available.plugin',
          status: 'fulfilled',
        }),
      ],
    });
  });

  it('fails closed when one of two current manifest declarations has no exact activated handler', async () => {
    const pluginId = 'acme.failclosed';
    const ingested = ingestCanonicalPluginManifest({
      schemaVersion: 2,
      id: pluginId,
      version: '1.0.0',
      displayName: 'Fail-closed hook',
      engines: { happier: '^0.0.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './daemon.mjs' },
      hostAccess: { required: [], optional: [] },
      contributes: {
        hooks: [{
          id: 'resolve-prerequisites',
          on: 'agent.resolvePrerequisites',
          hookApiVersion: 1,
          category: 'decision',
          scope: 'agent',
          filters: { agentId: 'codex' },
          executionKind: 'decide',
        }, {
          id: 'resolve-prerequisites-secondary',
          on: 'agent.resolvePrerequisites',
          hookApiVersion: 1,
          category: 'decision',
          scope: 'agent',
          filters: { agentId: 'codex' },
          executionKind: 'decide',
        }],
      },
    }, {
      manifestAuthority: 'external',
      enforceEngineCompatibility: false,
    });
    if (!ingested.ok) throw new Error(JSON.stringify(ingested.diagnostics));
    const activateContributionsOnDemand = vi.fn(async () => Object.freeze([]));

    const result = await dispatchPluginHookEvent({
      runtimeRegistry: {
        readHookEventEnvelopeV1,
        activateContributionsOnDemand,
        contributes: {
          activationTargets: Object.freeze([{
            provenance: 'external',
            source: { kind: 'path' },
            pluginId,
            manifestPath: `/plugins/${pluginId}/plugin.json`,
            manifestDigest: 'sha256:codex',
            daemonEntryPath: `/plugins/${pluginId}/daemon.mjs`,
            sourceSpec: {
              kind: 'path',
              locator: `/plugins/${pluginId}`,
              trustPolicy: 'local_trusted',
              installPolicy: 'link',
            },
            manifest: ingested.manifest,
          }]),
        },
        hookHandlersByHookId: new Map([[
          'agent.resolvePrerequisites',
          [{
            pluginId,
            localId: 'resolve-prerequisites',
            hookId: 'agent.resolvePrerequisites',
            priority: 0,
            registrationIndex: 0,
            manifestPath: `/plugins/${pluginId}/plugin.json`,
            manifestDigest: 'sha256:codex',
            daemonEntryPath: `/plugins/${pluginId}/daemon.mjs`,
            exportName: '<activation>',
            registration: createBackendPrerequisiteHookRegistration({
              pluginId,
              exportName: '<activation>',
              agentIdFilter: 'codex',
            }),
            handler: async () => ({ decision: 'allow' as const }),
          }],
        ]]),
      },
      event: {
        hookVersion: 1,
        eventId: 'agent.resolvePrerequisites',
        category: 'decision',
        scope: 'agent',
        agentId: 'codex',
        timestampMs: 1,
        payload: {
          agentId: 'codex',
          runtimeTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          timestampMs: 1,
        },
      },
    });

    expect(activateContributionsOnDemand).toHaveBeenCalledWith([
      {
        pluginId,
        family: 'hooks',
        localId: 'resolve-prerequisites',
      },
      {
        pluginId,
        family: 'hooks',
        localId: 'resolve-prerequisites-secondary',
      },
    ]);
    expect(result).toMatchObject({
      matchedHandlerCount: 2,
      outcomes: [
        {
          pluginId,
          hookId: 'agent.resolvePrerequisites',
          status: 'fulfilled',
          result: { decision: 'allow' },
        },
        {
          pluginId,
          hookId: 'agent.resolvePrerequisites',
          status: 'rejected',
          error: expect.stringContaining('unavailable'),
        },
      ],
      aggregate: {
        executionKind: 'decide',
        result: { decision: 'deny' },
      },
    });
  });

  it('stops at the first fulfilled decision for firstDecision hooks', async () => {
    const secondHandler = vi.fn().mockResolvedValue({ decision: 'deny' as const });
    const result = await dispatchPluginHookEvent({
      runtimeRegistry: {
        readHookEventEnvelopeV1,
        hookHandlersByHookId: new Map([
          [
            'agent.resolvePrerequisites',
            [
              {
                pluginId: 'alpha.plugin',
                hookId: 'agent.resolvePrerequisites',
                priority: 10,
                registrationIndex: 0,
                manifestPath: '/plugins/alpha/plugin.json',
                manifestDigest: 'sha256:alpha',
                daemonEntryPath: '/plugins/alpha/daemon.mjs',
                exportName: 'allowRequest',
                registration: {
                  provenance: 'external',
                  source: { kind: 'path' },
                  pluginId: 'alpha.plugin',
                  manifestPath: '/plugins/alpha/plugin.json',
                  manifestDigest: 'sha256:alpha',
                  daemonEntryPath: '/plugins/alpha/daemon.mjs',
                  sourceSpec: {
                    kind: 'path',
                    locator: '/plugins/alpha',
                    trustPolicy: 'local_trusted',
                    installPolicy: 'link',
                  },
                  definition: {
                    hookApiVersion: 1,
                    id: 'agent.resolvePrerequisites',
                    category: 'decision',
                    scope: 'agent',
                    executionKind: 'decide',
                    handler: {
                      target: 'plugin',
                      exportName: 'allowRequest',
                    },
                  },
                },
                handler: async () => ({ decision: 'allow' as const }),
              },
              {
                pluginId: 'beta.plugin',
                hookId: 'agent.resolvePrerequisites',
                priority: 0,
                registrationIndex: 1,
                manifestPath: '/plugins/beta/plugin.json',
                manifestDigest: 'sha256:beta',
                daemonEntryPath: '/plugins/beta/daemon.mjs',
                exportName: 'denyRequest',
                registration: {
                  provenance: 'external',
                  source: { kind: 'path' },
                  pluginId: 'beta.plugin',
                  manifestPath: '/plugins/beta/plugin.json',
                  manifestDigest: 'sha256:beta',
                  daemonEntryPath: '/plugins/beta/daemon.mjs',
                  sourceSpec: {
                    kind: 'path',
                    locator: '/plugins/beta',
                    trustPolicy: 'local_trusted',
                    installPolicy: 'link',
                  },
                  definition: {
                    hookApiVersion: 1,
                    id: 'agent.resolvePrerequisites',
                    category: 'decision',
                    scope: 'agent',
                    executionKind: 'decide',
                    handler: {
                      target: 'plugin',
                      exportName: 'denyRequest',
                    },
                  },
                },
                handler: secondHandler,
              },
            ],
          ],
        ]),
      },
      event: {
        hookVersion: 1,
        eventId: 'agent.resolvePrerequisites',
        category: 'decision',
        scope: 'agent',
        agentId: 'codex',
        timestampMs: 1,
        payload: {
          backendId: 'codex',
          targetRef: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          runtimeTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          agentId: 'codex',
          timestampMs: 1,
        },
      },
    });

    expect(result).toMatchObject({
      eventId: 'agent.resolvePrerequisites',
      matchedHandlerCount: 1,
      aggregate: {
        executionKind: 'decide',
        result: {
          decision: 'allow',
        },
      },
    });
    expect(secondHandler).not.toHaveBeenCalled();
  });

  it('continues past an explicit abstention and stops at the next deterministic decision', async () => {
    const abstainRegistration = createBackendPrerequisiteHookRegistration({
      pluginId: 'alpha.plugin',
      exportName: 'abstainRequest',
    });
    const denyRegistration = createBackendPrerequisiteHookRegistration({
      pluginId: 'beta.plugin',
      exportName: 'denyRequest',
    });
    const denyHandler = vi.fn(async () => ({
      decision: 'deny' as const,
      reasonCode: 'missing_prerequisite',
      errorMessage: 'Required prerequisite is unavailable.',
    }));

    const result = await dispatchPluginHookEvent({
      runtimeRegistry: {
        readHookEventEnvelopeV1,
        hookHandlersByHookId: new Map([[
          'agent.resolvePrerequisites',
          [
            {
              pluginId: 'alpha.plugin', hookId: 'agent.resolvePrerequisites', priority: 0, registrationIndex: 0,
              manifestPath: abstainRegistration.manifestPath, manifestDigest: abstainRegistration.manifestDigest,
              daemonEntryPath: abstainRegistration.daemonEntryPath!, exportName: 'abstainRequest',
              registration: abstainRegistration, handler: async () => ({ decision: 'abstain' as const }),
            },
            {
              pluginId: 'beta.plugin', hookId: 'agent.resolvePrerequisites', priority: 1, registrationIndex: 1,
              manifestPath: denyRegistration.manifestPath, manifestDigest: denyRegistration.manifestDigest,
              daemonEntryPath: denyRegistration.daemonEntryPath!, exportName: 'denyRequest',
              registration: denyRegistration, handler: denyHandler,
            },
          ],
        ]]),
      },
      event: {
        hookVersion: 1, eventId: 'agent.resolvePrerequisites', category: 'decision', scope: 'agent',
        agentId: 'codex', timestampMs: 1,
        payload: {
          agentId: 'codex', runtimeTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, timestampMs: 1,
        },
      },
    });

    expect(denyHandler).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      matchedHandlerCount: 2,
      aggregate: {
        executionKind: 'decide',
        result: {
          decision: 'deny',
          reasonCode: 'missing_prerequisite',
          errorMessage: 'Required prerequisite is unavailable.',
        },
      },
    });
  });

  it('treats undefined and malformed decision results as fail-closed handler failures', async () => {
    const malformedRegistration = createBackendPrerequisiteHookRegistration({
      pluginId: 'alpha.plugin',
      exportName: 'malformedRequest',
    });
    const laterHandler = vi.fn(async () => ({ decision: 'allow' as const }));

    const result = await dispatchPluginHookEvent({
      runtimeRegistry: {
        readHookEventEnvelopeV1,
        hookHandlersByHookId: new Map([[
          'agent.resolvePrerequisites',
          [{
            pluginId: 'alpha.plugin', hookId: 'agent.resolvePrerequisites', priority: 0, registrationIndex: 0,
            manifestPath: malformedRegistration.manifestPath, manifestDigest: malformedRegistration.manifestDigest,
            daemonEntryPath: malformedRegistration.daemonEntryPath!, exportName: 'malformedRequest',
            registration: malformedRegistration, handler: async () => undefined,
          }, {
            pluginId: 'beta.plugin', hookId: 'agent.resolvePrerequisites', priority: 1, registrationIndex: 1,
            manifestPath: '/plugins/beta.plugin/plugin.json', manifestDigest: 'sha256:beta.plugin',
            daemonEntryPath: '/plugins/beta.plugin/daemon.mjs', exportName: 'allowRequest',
            registration: createBackendPrerequisiteHookRegistration({ pluginId: 'beta.plugin', exportName: 'allowRequest' }),
            handler: laterHandler,
          }],
        ]]),
      },
      event: {
        hookVersion: 1, eventId: 'agent.resolvePrerequisites', category: 'decision', scope: 'agent',
        agentId: 'codex', timestampMs: 1,
        payload: {
          agentId: 'codex', runtimeTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, timestampMs: 1,
        },
      },
    });

    expect(laterHandler).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      matchedHandlerCount: 1,
      outcomes: [expect.objectContaining({ pluginId: 'alpha.plugin', status: 'rejected' })],
      aggregate: { executionKind: 'decide', result: { decision: 'deny' } },
    });
  });

  it('rejects invalid typed hook payloads before invoking handlers', async () => {
    const handler = vi.fn(async () => ({ observed: true }));
    const activateContributionsOnDemand = vi.fn(async () => Object.freeze([]));

    const result = await dispatchPluginHookEvent({
      runtimeRegistry: {
        readHookEventEnvelopeV1,
        activateContributionsOnDemand,
        hookHandlersByHookId: new Map([
          [
            'session.spawned',
            [
              {
                pluginId: 'acme.plugin',
                hookId: 'session.spawned',
                priority: 0,
                registrationIndex: 0,
                manifestPath: '/plugins/acme/plugin.json',
                manifestDigest: 'sha256:acme',
                daemonEntryPath: '/plugins/acme/daemon.mjs',
                exportName: 'onSubagentStart',
                registration: {
                  provenance: 'external',
                  source: { kind: 'path' },
                  pluginId: 'acme.plugin',
                  manifestPath: '/plugins/acme/plugin.json',
                  manifestDigest: 'sha256:acme',
                  daemonEntryPath: '/plugins/acme/daemon.mjs',
                  sourceSpec: {
                    kind: 'path',
                    locator: '/plugins/acme',
                    trustPolicy: 'local_trusted',
                    installPolicy: 'link',
                  },
                  definition: {
                    hookApiVersion: 1,
                    id: 'session.spawned',
                    category: 'lifecycle',
                    scope: 'session',
                    executionKind: 'observe',
                    handler: {
                      target: 'plugin',
                      exportName: 'onSubagentStart',
                    },
                  },
                },
                handler,
              },
            ],
          ],
        ]),
      },
      event: {
        hookVersion: 1,
        eventId: 'session.spawned',
        category: 'lifecycle',
        scope: 'session',
        timestampMs: 1,
        payload: {},
      },
    });

    expect(result).toMatchObject({
      eventId: 'session.spawned',
      matchedHandlerCount: 0,
      validationError: expect.stringContaining('session.spawned'),
    });
    expect(handler).not.toHaveBeenCalled();
    expect(activateContributionsOnDemand).not.toHaveBeenCalled();
  });
});
