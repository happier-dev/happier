import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

describe('executable plugin declared event ownership', () => {
    it('binds a manifest subscription to its real handler and retires it across reload', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-declared-events-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-declared-events-plugin-'));
        const marker = globalThis as typeof globalThis & {
            __HAPPIER_DECLARED_EVENT_DELIVERIES?: unknown[];
        };
        marker.__HAPPIER_DECLARED_EVENT_DELIVERIES = [];
        await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
        await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
            schemaVersion: 2,
            id: 'acme.declared-events',
            version: '1.0.0',
            displayName: 'Declared events fixture',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: { required: [], optional: [] },
            contributes: {
                events: [{
                    id: 'changed',
                    kind: 'event',
                    title: 'Changed',
                    payloadSchema: {
                        type: 'object',
                        properties: { revision: { type: 'number' } },
                        required: ['revision'],
                        additionalProperties: false,
                    },
                }, {
                    id: 'watch-changed',
                    kind: 'subscription',
                    event: 'changed',
                }],
            },
        }), 'utf8');
        await writeFile(join(pluginRoot, 'daemon.mjs'), `export function activate(api) {
            api.events.register('watch-changed', async (payload) => {
                globalThis.__HAPPIER_DECLARED_EVENT_DELIVERIES.push(payload);
            });
        }`, 'utf8');
        await seedCurrentLocalPathPluginFixture({
            happyHomeDir,
            pluginRoot,
            pluginId: 'acme.declared-events',
            manifestVersion: '1.0.0',
        });

        let firstRuntime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        let secondRuntime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        try {
            firstRuntime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
            expect(firstRuntime.pluginDiagnosticsByPluginId['acme.declared-events']).toEqual([]);
            expect(firstRuntime.contributes.events?.map((entry) => entry.definition.id)).toEqual([
                'acme.declared-events/changed',
                'acme.declared-events/watch-changed',
            ]);
            expect(firstRuntime.contributes.activationTargets.map((target) => target.pluginId)).toContain(
                'acme.declared-events',
            );
            const firstActivation = await firstRuntime.activateContributionsOnDemand([{
                pluginId: 'acme.declared-events',
                family: 'events',
                localId: 'watch-changed',
            }]);
            expect(firstActivation).toEqual([expect.objectContaining({
                pluginId: 'acme.declared-events',
                diagnostics: [],
            })]);
            expect(firstRuntime.activatedPluginIds.has('acme.declared-events')).toBe(true);
            const firstPublisher = firstRuntime.createPluginEventsService?.({
                pluginId: 'acme.declared-events',
                pluginVersion: '1.0.0',
            });
            expect(firstPublisher).not.toBeNull();
            await firstPublisher!.emit('changed', { revision: 1 });
            await vi.waitFor(() => expect(marker.__HAPPIER_DECLARED_EVENT_DELIVERIES).toEqual([
                { revision: 1 },
            ]));
            await firstRuntime.dispose();
            firstRuntime = null;

            secondRuntime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
            await secondRuntime.activateContributionsOnDemand([{
                pluginId: 'acme.declared-events',
                family: 'events',
                localId: 'watch-changed',
            }]);
            const secondPublisher = secondRuntime.createPluginEventsService?.({
                pluginId: 'acme.declared-events',
                pluginVersion: '1.0.0',
            });
            expect(secondPublisher).not.toBeNull();
            await secondPublisher!.emit('changed', { revision: 2 });
            await vi.waitFor(() => expect(marker.__HAPPIER_DECLARED_EVENT_DELIVERIES).toEqual([
                { revision: 1 },
                { revision: 2 },
            ]));
        } finally {
            await firstRuntime?.dispose();
            await secondRuntime?.dispose();
            delete marker.__HAPPIER_DECLARED_EVENT_DELIVERIES;
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    });
});
