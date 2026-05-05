import { describe, expect, it, vi } from 'vitest';
import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import { dispatchPluginHookEvent } from './dispatchPluginHookEvent';

describe('dispatchPluginHookEvent', () => {
  it('aggregates augment hook object results in deterministic handler order', async () => {
    const result = await dispatchPluginHookEvent({
      runtimeRegistry: {
        readHookEventEnvelopeV1,
        hookHandlersByHookId: new Map([
          [
            'spawn.augmentEnv',
            [
              {
                pluginId: 'alpha.plugin',
                hookId: 'spawn.augmentEnv',
                priority: 10,
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
                    id: 'spawn.augmentEnv',
                    category: 'augmentation',
                    scope: 'backend',
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
                hookId: 'spawn.augmentEnv',
                priority: 0,
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
                    id: 'spawn.augmentEnv',
                    category: 'augmentation',
                    scope: 'backend',
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
        eventId: 'spawn.augmentEnv',
        category: 'augmentation',
        scope: 'backend',
        backendId: 'codex',
        timestampMs: 1,
        payload: {},
      },
    });

    expect(result).toMatchObject({
      eventId: 'spawn.augmentEnv',
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

  it('fails closed for decide hooks when a matched handler rejects', async () => {
    const result = await dispatchPluginHookEvent({
      runtimeRegistry: {
        readHookEventEnvelopeV1,
        hookHandlersByHookId: new Map([
          [
            'backend.resolveRuntimePrerequisites',
            [
              {
                pluginId: 'acme.plugin',
                hookId: 'backend.resolveRuntimePrerequisites',
                priority: 0,
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
                    id: 'backend.resolveRuntimePrerequisites',
                    category: 'decision',
                    scope: 'backend',
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
        eventId: 'backend.resolveRuntimePrerequisites',
        category: 'decision',
        scope: 'backend',
        backendId: 'codex',
        timestampMs: 1,
        payload: {},
      },
    });

    expect(result).toMatchObject({
      eventId: 'backend.resolveRuntimePrerequisites',
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

  it('stops at the first fulfilled decision for firstDecision hooks', async () => {
    const secondHandler = vi.fn().mockResolvedValue({ allowed: false });
    const result = await dispatchPluginHookEvent({
      runtimeRegistry: {
        readHookEventEnvelopeV1,
        hookHandlersByHookId: new Map([
          [
            'backend.resolveRuntimePrerequisites',
            [
              {
                pluginId: 'alpha.plugin',
                hookId: 'backend.resolveRuntimePrerequisites',
                priority: 10,
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
                    id: 'backend.resolveRuntimePrerequisites',
                    category: 'decision',
                    scope: 'backend',
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
                hookId: 'backend.resolveRuntimePrerequisites',
                priority: 0,
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
                    id: 'backend.resolveRuntimePrerequisites',
                    category: 'decision',
                    scope: 'backend',
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
        eventId: 'backend.resolveRuntimePrerequisites',
        category: 'decision',
        scope: 'backend',
        backendId: 'codex',
        timestampMs: 1,
        payload: {},
      },
    });

    expect(result).toMatchObject({
      eventId: 'backend.resolveRuntimePrerequisites',
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
});
