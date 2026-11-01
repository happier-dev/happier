import { describe, expect, it } from 'vitest';
import { createPluginRegistrationScope } from './scope.js';
import type { PluginWorkItemsResolveRequestV1, PluginWorkItemsFindLinkedRequestV1 } from '@happier-dev/protocol/plugins/contributions/workItems';

describe('private registration scope', () => {
    it('publishes trusted runtime receivers without entitlement or frozen-facade enforcement', async () => {
        const scope = createPluginRegistrationScope({
            pluginId: 'sample', target: { realm: 'daemon' },
            rights: [
                { family: 'providers', localId: 'provider', target: { realm: 'daemon' },
                    providerArms: { managedRuntime: false, catalogParserIds: [] } },
                { family: 'agents', localId: 'agent', target: { realm: 'daemon' } },
            ],
        });
        if (!('providers' in scope.api)) throw new Error('Expected daemon registrations');
        const runtime = {
            value: 'first',
            helper: () => 'helper',
            async start() { return `${this.helper()}:${this.value}`; },
        };
        scope.api.providers.register('provider', runtime);
        const externalSessions = {
            source: { kind: 'first' },
            helper: () => 'changed',
            async resolveSource() { return { ok: true, value: { source: { kind: this.helper() } } }; },
            async listCandidates() { return { ok: true, value: { candidates: [], nextCursor: null } }; },
            async resolveLinkIdentity() { return { ok: true, value: { source: this.source, remoteSessionId: 'one', linkData: {} } }; },
            async resolveLinkedIdentity() { return { ok: true, value: { source: this.source, remoteSessionId: 'one', linkData: {} } }; },
            async pageTranscript() { return { ok: true, value: { items: [], nextCursor: null } }; },
            async readAfterTranscript() { return { ok: true, value: { outcome: 'already_current' } }; },
        };
        scope.api.agents.registerExternalSessions('agent', externalSessions);
        const registration = scope.commit()[0];
        if (registration?.family !== 'providers') throw new Error('Expected Provider registration');
        const provider = registration.value as { managedRuntime: typeof runtime };
        expect(Object.isFrozen(provider.managedRuntime)).toBe(false);
        runtime.value = 'changed';
        await expect(provider.managedRuntime.start()).resolves.toBe('helper:changed');
        const agent = scope.registrations().find(row => row.family === 'agents');
        const registered = agent?.value as { externalSessions: Pick<typeof externalSessions, 'resolveSource'> };
        expect(Object.isFrozen(registered.externalSessions)).toBe(false);
        await expect(registered.externalSessions.resolveSource()).resolves.toEqual({
            ok: true, value: { source: { kind: 'changed' } },
        });
        await scope.dispose();
    });

    it('preserves live WorkItems receivers while normalizing requested result identities', async () => {
        let watchContext: unknown;
        const target = { realm: 'client', artifactId: 'client', exportName: 'activate', platform: 'web' } as const;
        const scope = createPluginRegistrationScope({
            pluginId: 'sample', target,
            rights: [{ family: 'workItems', localId: 'work-items', target: {
                realm: 'client', artifactId: 'client', exportName: 'activate', platforms: ['web'],
            } }],
        });
        const runtime = {
            title: 'Owner value',
            async resolve(request: PluginWorkItemsResolveRequestV1) {
                return Object.fromEntries(request.itemIds.slice(0, 1).map(id => [id, {
                    title: this.title, category: 'started' as const, linkedSessions: [],
                }]));
            },
            async findLinked(request: PluginWorkItemsFindLinkedRequestV1) { return request.sessionIds.map(id => `item-${id}`); },
            watch(_request: unknown, onChange: () => void, context: unknown) { watchContext = context; onChange(); return () => { this.title = 'Retired'; }; },
        };
        if (!('workItems' in scope.api)) throw new Error('Expected client registrations');
        scope.api.workItems.register('work-items', runtime);
        const registrations = scope.commit();
        const registration = registrations[0];
        if (registration?.family !== 'workItems') throw new Error('Expected WorkItems registration');
        runtime.title = 'Updated owner value';
        runtime.resolve = async function(request) {
            return Object.fromEntries(request.itemIds.slice(0, 1).map(id => [id, {
                title: `Replacement:${this.title}`, category: 'started' as const, linkedSessions: [],
            }]));
        };
        const context = { signal: new AbortController().signal };
        const captured = registration.value as Readonly<Record<string, (...args: unknown[]) => unknown>>;
        await expect(captured.resolve!({ serverId: 'home', itemIds: ['one', 'two'] }, context)).resolves.toEqual({
            one: { title: 'Replacement:Updated owner value', category: 'started', linkedSessions: [] }, two: null,
        });
        await expect(captured.findLinked!({ serverId: 'home', sessionIds: ['session'] }, context)).resolves.toEqual(['item-session']);
        let invalidated = false;
        const cleanup = captured.watch!({ serverId: 'home', itemIds: ['one'] }, () => { invalidated = true; }, context);
        expect(watchContext).toBe(context);
        expect(invalidated).toBe(true);
        if (typeof cleanup !== 'function') throw new Error('Expected watch cleanup');
        cleanup();
        expect(runtime.title).toBe('Retired');
        await scope.dispose();
    });

    it('rejects WorkItems results outside the requested identities', async () => {
        const scope = createPluginRegistrationScope({
            pluginId: 'sample', target: { realm: 'client', artifactId: 'client', exportName: 'activate', platform: 'web' },
            rights: [{ family: 'workItems', localId: 'work-items', target: {
                realm: 'client', artifactId: 'client', exportName: 'activate', platforms: ['web'],
            } }],
        });
        if (!('workItems' in scope.api)) throw new Error('Expected client registrations');
        scope.api.workItems.register('work-items', { async resolve() { return { extra: null }; } });
        const registration = scope.commit()[0];
        if (registration?.family !== 'workItems') throw new Error('Expected WorkItems registration');
        const captured = registration.value as Readonly<Record<string, (...args: unknown[]) => unknown>>;
        await expect(captured.resolve!({ serverId: 'home', itemIds: ['one'] }, {
            signal: new AbortController().signal,
        })).rejects.toBeInstanceOf(TypeError);
        await scope.dispose();
    });

    it('preserves trusted Agent descriptor receivers and closes registration after commit', () => {
        const scope = createPluginRegistrationScope({
            pluginId: 'sample', target: { realm: 'daemon' },
            rights: [{ family: 'agents', localId: 'agent', target: { realm: 'daemon' }, requiredFields: ['factory', 'sessionRunnerFactory'] }],
        });
        const api = scope.api;
        if (!('agents' in api)) throw new Error('Expected daemon registrations');
        const locator = { module: './agent.js', export: 'createRunner', runtimeApiVersion: 1 as const };
        api.agents.register('agent', () => undefined, { sessionRunnerFactory: locator });
        const registration = scope.commit()[0];
        locator.module = './changed.js';
        if (registration?.family !== 'agents') throw new Error('Expected Agent registration');
        expect(registration.value).toMatchObject({ sessionRunnerFactory: { module: './changed.js' } });
        expect(() => api.agents.register('agent', () => undefined)).toThrow();
    });
});
