import { beforeEach, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';

import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createSpawnHappyCliEnvScope } from '@/testkit/process/spawnHappyCliHarness';
import { createCommittedContributedActionInvoker } from '../invocation/actions/createCommittedContributedActionDeps';
import { DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY } from '../context/daemonDatabaseLimitsPolicy';
import { resolveExecutablePluginRuntimeRegistry, type ResolvedExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';

beforeEach(() => {
    const scope = createSpawnHappyCliEnvScope();
    scope.patch({ HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '1', HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '1' });
    return scope.restore;
});

it('keeps retained Action handlers and their SQLite database usable after registry replacement', async () => {
    const pluginId = 'acme.retained-handlers';
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
        coldStart: true,
        runtimeOptions: { daemonDatabaseLimits: DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY },
        plugins: [{
            manifest: createPluginManifestV2Fixture({
                id: pluginId,
                contributes: {
                    daemonDatabases: [{
                        id: 'events', migrations: [{ version: 1, id: 'create-events' }],
                        incumbentQueryFixtureId: 'events-readable', retention: [],
                    }],
                    actions: [{
                        id: 'read', title: 'Read', scopes: ['global'], surfaces: ['cli'],
                        execution: { target: 'daemon' }, placementBindings: ['commandPalette'], dangerLevel: 'safe',
                    }],
                },
            }),
            files: { 'daemon.mjs': `
                let active = false;
                const events = {
                    migrations: [{ version: 1, id: 'create-events', async up(tx) {
                        await tx.execute('CREATE TABLE events (id INTEGER PRIMARY KEY)');
                    } }],
                    incumbentQueryFixture: { id: 'events-readable', async run(tx) {
                        await tx.query('SELECT id FROM events');
                    } },
                };
                export const daemonDatabases = { events };
                export function activate(api) {
                    if (active) throw new Error('overlapping activation');
                    active = true;
                    api.actions.register('read', async (_input, context) => {
                        const database = await context.services.storage.daemon.database('events', events);
                        await database.execute('INSERT INTO events DEFAULT VALUES');
                        const [{ reads }] = await database.query('SELECT count(*) AS reads FROM events');
                        return { active, reads };
                    });
                    return () => { active = false; };
                }
            ` },
        }],
    });
    let successor: ResolvedExecutablePluginRuntimeRegistry | undefined;
    const execute = (registry: typeof fixture.registry) => createActionExecutor({
        ...createUnavailableActionTransportDeps(),
        invokeContributedAction: createCommittedContributedActionInvoker({
            acquireRuntimeRegistryLease: async () => ({ registry, source: 'ephemeral', durableRevision: -1, release: async () => {} }),
        }),
    }).execute('action.invoke', { action: { pluginId, localId: 'read' }, input: {} }, { surface: 'cli' });
    try {
        expect(await execute(fixture.registry)).toMatchObject({ ok: true, result: { active: true, reads: 1 } });
        const component = fixture.registry.retainPluginActivationComponent?.(pluginId);
        if (!component) throw new Error('Missing activated component');
        const occurrence = fixture.registry.readPluginOccurrenceId(pluginId);
        if (!occurrence) throw new Error('Missing serving occurrence');
        successor = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir: fixture.happyHomeDir,
            contributes: fixture.registry.contributes,
            generationAuthority: fixture.committed,
            generation: fixture.registry.generation + 1,
            pluginIds: [],
            retainedActivationRegistryLeases: [component],
            servingPluginOccurrences: new Map([[pluginId, {
                occurrenceId: occurrence,
                sourceCustody: fixture.registry.readPluginSourceCustody(pluginId),
            }]]),
            daemonDatabaseLimits: DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY,
        });
        const retainedResult = await execute(successor);
        expect(retainedResult, JSON.stringify(retainedResult)).toMatchObject({ ok: true, result: { active: true, reads: 2 } });
        await fixture.registry.dispose();
        expect(await execute(successor)).toMatchObject({ ok: true, result: { active: true, reads: 3 } });
    } finally {
        await successor?.dispose();
        await fixture.dispose();
    }
});
