import { describe, expect, it, vi } from 'vitest';
import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import type { ResolvedHookRegistration } from '@/plugins/projection/registry/types';

import { dispatchPluginHookEvent } from './dispatchPluginHookEvent';

function createBackendPrerequisiteHookRegistration(params: Readonly<{
  pluginId: string;
  exportName: string;
  agentIdFilter?: string;
  providerIdFilter?: string;
  backendIdFilter?: string;
}>): ResolvedHookRegistration {
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
      handler: {
        target: 'plugin',
        exportName: params.exportName,
      },
    },
  };
}

describe('dispatchPluginHookEvent', () => {
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
          allowed: false,
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
    const handler = vi.fn(async () => ({ allowed: true }));
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
          allowed: false,
        },
      },
      outcomes: [
        expect.objectContaining({
          pluginId: 'acme.plugin',
          status: 'rejected',
          error: 'spawn blocked',
        }),
      ],
    });
  });

  it('fails closed when a matching fail-closed hook registration has no resolved handler', async () => {
    const availableRegistration = createBackendPrerequisiteHookRegistration({
      pluginId: 'available.plugin',
      exportName: 'allowSpawn',
      agentIdFilter: 'codex',
    });
    const unavailableRegistration = createBackendPrerequisiteHookRegistration({
      pluginId: 'missing.plugin',
      exportName: 'missingSpawn',
    });

    const result = await dispatchPluginHookEvent({
      runtimeRegistry: {
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
                handler: async () => ({ allowed: true }),
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
      matchedHandlerCount: 2,
      aggregate: {
        executionKind: 'decide',
        result: {
          allowed: false,
        },
      },
      outcomes: [
        expect.objectContaining({
          pluginId: 'available.plugin',
          status: 'fulfilled',
        }),
        expect.objectContaining({
          pluginId: 'missing.plugin',
          status: 'rejected',
          error: expect.stringContaining('unavailable'),
        }),
      ],
    });
  });

  it('stops at the first fulfilled decision for firstDecision hooks', async () => {
    const secondHandler = vi.fn().mockResolvedValue({ allowed: false });
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
                handler: async () => ({ allowed: true }),
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
          allowed: true,
        },
      },
    });
    expect(secondHandler).not.toHaveBeenCalled();
  });

  it('rejects invalid typed hook payloads before invoking handlers', async () => {
    const handler = vi.fn(async () => ({ observed: true }));

    const result = await dispatchPluginHookEvent({
      runtimeRegistry: {
        readHookEventEnvelopeV1,
        hookHandlersByHookId: new Map([
          [
            'subagent.started',
            [
              {
                pluginId: 'acme.plugin',
                hookId: 'subagent.started',
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
                    id: 'subagent.started',
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
        eventId: 'subagent.started',
        category: 'lifecycle',
        scope: 'session',
        timestampMs: 1,
        payload: {},
      },
    });

    expect(result).toMatchObject({
      eventId: 'subagent.started',
      matchedHandlerCount: 0,
      validationError: expect.stringContaining('subagent.started'),
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
