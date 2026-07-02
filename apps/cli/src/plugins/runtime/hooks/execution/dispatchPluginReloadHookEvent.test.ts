import { describe, expect, it, vi } from 'vitest';

import { dispatchPluginReloadHookEvent } from './dispatchPluginReloadHookEvent';

const passThroughHookEnvelope = (value: unknown) => value as unknown as ReturnType<
    NonNullable<typeof import('@happier-dev/protocol').readHookEventEnvelopeV1>
>;

describe('dispatchPluginReloadHookEvent', () => {
    it('emits reload lifecycle envelopes with plugin scope', async () => {
        const handler = vi.fn(async () => undefined);

        const result = await dispatchPluginReloadHookEvent({
            runtimeRegistry: {
                hookHandlersByHookId: new Map([
                    [
                        'plugin.reload.before',
                        [
                            {
                                pluginId: 'acme.reload',
                                hookId: 'plugin.reload.before',
                                priority: 0,
                                registrationIndex: 0,
                                manifestPath: '/tmp/plugin.json',
                                manifestDigest: 'sha256:reload',
                                daemonEntryPath: '/tmp/daemon.mjs',
                                exportName: 'default',
                                registration: {
                                    provenance: 'external',
                                    source: { kind: 'path' },
                                    pluginId: 'acme.reload',
                                    manifestPath: '/tmp/plugin.json',
                                    manifestDigest: 'sha256:reload',
                                    daemonEntryPath: '/tmp/daemon.mjs',
                                    sourceSpec: {
                                        kind: 'path',
                                        locator: '/tmp',
                                        trustPolicy: 'local_trusted',
                                        installPolicy: 'link',
                                    },
                                    definition: {
                                        hookApiVersion: 1,
                                        id: 'plugin.reload.before',
                                        category: 'lifecycle',
                                        scope: 'plugin' as unknown as 'backend',
                                        executionKind: 'observe',
                                        handler: {
                                            target: 'plugin',
                                        },
                                    },
                                },
                                handler,
                            },
                        ],
                    ],
                ]),
                readHookEventEnvelopeV1: passThroughHookEnvelope,
            },
            eventId: 'plugin.reload.before',
            payload: {
                pluginIds: ['acme.reload'],
            },
            timestampMs: 123,
        });

        expect(result).toEqual(expect.objectContaining({
            eventId: 'plugin.reload.before',
            matchedHandlerCount: 1,
        }));
        expect(handler).toHaveBeenCalledWith(expect.objectContaining({
            eventId: 'plugin.reload.before',
            scope: 'plugin',
            timestampMs: 123,
        }));
    });
});
