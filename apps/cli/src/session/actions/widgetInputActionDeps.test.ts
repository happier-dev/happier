import { describe, expect, it } from 'vitest';
import { createCliWidgetInputActionDepsV1 } from './widgetInputActionDeps';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

describe('Widget Action input transport authority', () => {
    it('refuses an unreadable declared Session target without an explicit plugin path', async () => {
        const surface = { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } };
        const definition = { pluginId: 'com.acme.widgets', localId: 'checks' };
        const deps = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId: 'viewer',
            getDeps: () => ({ ...createUnavailableActionTransportDeps(), widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }) }),
            readCandidates: async () => [{ surface: definition, availability: 'available', inputs: { fields: [
                { path: 'chosen', title: 'Session', widget: 'json', required: true, inputType: { hostType: 'session' } },
            ] } }], validateSession: async () => false,
        });
        expect(await deps.widgetInputs!.resolve({ ref: { surface, instanceId: 'copy' }, instance: { v: 1, id: 'copy',
            definition: { kind: 'installed', surface: definition }, bindings: { chosen: { kind: 'value', value: { serverId: 'home', sessionId: 'B' } } } },
            context: { surface: 'cli' } })).toMatchObject({ status: 'unavailable' });
    });
    it('admits only the exact declared Workspace present in current surface context', async () => {
        const surface = { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } };
        const checkout = { id: 'checkout', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
        const deps = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId: 'viewer',
            getDeps: () => ({ ...createUnavailableActionTransportDeps(), widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }) }),
            readCandidates: async () => { throw new Error('Native metadata has no plugin discovery'); },
            validateSession: async () => { throw new Error('A checkout grants no Session access'); },
        });
        const request = { ref: { surface, instanceId: 'copy' }, instance: { v: 1 as const, id: 'copy', definition: { kind: 'builtin' as const, id: 'project_code' },
            bindings: { checkout: { kind: 'value' as const, value: checkout } } },
            context: { surface: 'cli' as const, widgetAreaContext: { surface, values: { checkout: [checkout] } } } };
        expect(await deps.widgetInputs!.resolve(request)).toEqual({ status: 'ready', input: { checkout } });
        expect(await deps.widgetInputs!.resolve({ ...request, instance: { ...request.instance,
            bindings: { checkout: { kind: 'value', value: { ...checkout, rootPath: '/other' } } } } })).toMatchObject({ status: 'denied',
            fields: [{ path: 'checkout', reasonCode: 'widget_target_identity_mismatch' }] });
        expect(await deps.widgetInputs!.resolve({ ...request, context: { surface: 'cli' } })).toMatchObject({ status: 'denied' });
        expect(await deps.widgetInputs!.resolve({ ...request, context: { surface: 'cli' },
            instance: { ...request.instance, bindings: { checkout: { kind: 'context', slot: 'checkout' } } },
            groupBindings: { checkout: { kind: 'value', value: checkout } } })).toMatchObject({ status: 'denied' });
    });
    it('resolves app-read fields without Session or credential authority and refuses ambiguous target declarations', async () => {
        const surface = { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } };
        const definition = { pluginId: 'com.acme.widgets', localId: 'usage' };
        const deps = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId: 'viewer',
            getDeps: () => ({ ...createUnavailableActionTransportDeps(), widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }) }),
            readCandidates: async () => [{ surface: definition, availability: 'available', inputs: { fields: [
                { path: 'period', title: 'Period', widget: 'text', required: true },
            ] } }], validateSession: async () => { throw new Error('App reads grant no Session authority'); },
            readViewerPurposeContext: async () => { throw new Error('App reads grant no credentials'); },
        });
        const request = { ref: { surface, instanceId: 'copy' }, instance: { v: 1 as const, id: 'copy',
            definition: { kind: 'installed' as const, surface: definition }, bindings: { period: { kind: 'value' as const, value: 'week' } } },
            context: { surface: 'cli' as const } };
        expect(await deps.widgetInputs!.resolve(request)).toEqual({ status: 'ready', input: { period: 'week' } });
        const ambiguous = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId: 'viewer',
            getDeps: () => ({ ...createUnavailableActionTransportDeps(), widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }) }),
            readCandidates: async () => [{ surface: definition, availability: 'available', inputs: { fields: [
                { path: 'one', title: 'Session', widget: 'json', inputType: { hostType: 'session' } },
                { path: 'two', title: 'Checkout', widget: 'json', inputType: { hostType: 'workspace' } },
            ] } }], validateSession: async () => { throw new Error('Ambiguous targets must be refused'); },
        });
        expect(await ambiguous.widgetInputs!.resolve({ ...request, instance: { ...request.instance, bindings: {} } })).toMatchObject({ status: 'unavailable' });
    });
    it('discovers the exact group-selected Session and rechecks its access without rebinding a child pin', async () => {
        const surface = { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } };
        const definition = { pluginId: 'com.acme.widgets', localId: 'checks' };
        const instance = { v: 1 as const, id: 'copy', definition: { kind: 'installed' as const, surface: definition },
            bindings: { session: { kind: 'context' as const, slot: 'session' } } };
        const candidate = { surface: definition, availability: 'available' as const, sessionInputPath: 'session',
            inputs: { fields: [{ path: 'session', title: 'Session', widget: 'json' as const, required: true }] } };
        let allowed = true;
        const targets: string[] = [];
        const deps = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId: 'viewer',
            getDeps: () => ({ ...createUnavailableActionTransportDeps(), widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }),
                widgetSurfaceActions: { home: {
                    read: async () => ({ surface, canEdit: true, instances: [{ instance }], items: [{ kind: 'group', id: 'group', width: 'full',
                        frameStyle: 'card', dividers: 'hairline', children: [{ kind: 'widget', instance }],
                        context: { session: { kind: 'value', value: { serverId: 'home', sessionId: 'B' } } } }] }),
                    apply: async () => { throw new Error('Resolution must not write a layout'); },
                } } }),
            readCandidates: async (_signal, session) => session?.sessionId === 'B' || session?.sessionId === 'C' ? [candidate] : [],
            validateSession: async session => { targets.push(session.sessionId); return allowed; },
        });
        const request = { ref: { surface, instanceId: instance.id }, instance, context: { surface: 'cli' as const } };
        expect(await deps.widgetInputs!.resolve(request)).toEqual({ status: 'ready', input: { session: { serverId: 'home', sessionId: 'B' } } });
        expect(await deps.widgetInputs!.resolve({ ...request, instance: { ...instance, bindings: {
            session: { kind: 'value', value: { serverId: 'home', sessionId: 'C' } },
        } } })).toEqual({ status: 'ready', input: { session: { serverId: 'home', sessionId: 'C' } } });
        expect(targets).toContain('B');
        expect(targets).toContain('C');
        allowed = false;
        expect(await deps.widgetInputs!.resolve(request)).toMatchObject({ status: 'unavailable' });
    });
    it('validates a picker-only typed pin before admitting executable widget input', async () => {
        const inputType = { pluginId: 'com.acme.widgets', localId: 'repository' };
        const surface = { pluginId: inputType.pluginId, localId: 'checks' };
        const type = { identity: inputType, occurrenceId: 'current', definition: { id: inputType.localId,
            title: 'Repository', semantic: 'repository', valueSchema: { type: 'object' as const,
                properties: { repositoryId: { type: 'string' as const } }, required: ['repositoryId'], additionalProperties: false } } };
        const deps = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId: 'viewer',
            getDeps: () => ({ ...createUnavailableActionTransportDeps(), widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }), resolveInputType: async () => type }),
            validateSession: async () => { throw new Error('Repository input grants no Session access'); },
            readCandidates: async () => [{ surface, availability: 'available', inputs: { fields: [
                { path: 'repository', title: 'Repository', widget: 'select', inputType },
            ] } }],
        });
        const request = { ref: { surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } }, instanceId: 'copy' },
            instance: { v: 1 as const, id: 'copy', definition: { kind: 'installed' as const, surface },
                bindings: { repository: { kind: 'value' as const, value: { repositoryId: 'repo' } } } }, context: { surface: 'cli' as const } };
        expect(await deps.widgetInputs!.resolve(request)).toEqual({ status: 'ready', input: { repository: { repositoryId: 'repo' } } });
        expect(await deps.widgetInputs!.resolve({ ...request, instance: { ...request.instance,
            bindings: { repository: { kind: 'value', value: { repositoryId: 42 } } } } })).toMatchObject({ status: 'invalid',
            fields: [{ path: 'repository', reasonCode: 'input_type_value_invalid' }] });
    });
    it('admits native metadata without plugin discovery but refuses the exact unreadable bound Session', async () => {
        const targets: Array<{ serverId: string; sessionId: string }> = [];
        const deps = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId: 'viewer',
            getDeps: () => ({ ...createUnavailableActionTransportDeps(), widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }) }),
            readCandidates: async () => { throw new Error('Native metadata does not come from a plugin daemon'); },
            validateSession: async target => { targets.push(target); return false; },
        });
        const result = await deps.widgetInputs!.resolve({
            ref: { surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'sessionBoard', sessionId: 'A' } }, instanceId: 'native-copy' },
            instance: { v: 1, id: 'native-copy', definition: { kind: 'builtin', id: 'changes' }, bindings: {
                session: { kind: 'value', value: { serverId: 'home', sessionId: 'B' } },
            } }, context: { surface: 'cli', authority: 'present_user' },
        });
        expect(result).toMatchObject({ status: 'denied', fields: [{ path: 'session', reasonCode: 'widget_session_access_denied' }] });
        expect(targets).toEqual([{ serverId: 'home', sessionId: 'B' }]);
    });
    it('admits bound Session input against current B rather than physical A declaration', async () => {
        const definition = { pluginId: 'com.acme.widgets', localId: 'checks' };
        const reads: (string | undefined)[] = [];
        const deps = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId: 'viewer',
            getDeps: () => ({ ...createUnavailableActionTransportDeps(), widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }) }),
            validateSession: async () => true,
            readCandidates: async (_signal, session) => {
                reads.push(session?.sessionId);
                return [{ surface: definition, availability: 'available', sessionInputPath: 'session',
                    inputs: { fields: [{ path: 'session', title: 'Session', widget: 'json', required: true },
                        { path: 'count', title: 'Count', widget: 'number', required: true }] },
                    inputSchema: { type: 'object', properties: { session: { type: 'object', properties: {
                        serverId: { type: 'string' }, sessionId: { type: 'string' },
                    }, required: ['serverId', 'sessionId'], additionalProperties: false },
                    count: { type: 'number', minimum: session?.sessionId === 'B' ? 3 : 1 } },
                    required: ['session', 'count'], additionalProperties: false } }];
            },
        });
        const result = await deps.widgetInputs!.resolve({
            ref: { surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'sessionBoard', sessionId: 'A' } }, instanceId: 'copy' },
            instance: { v: 1, id: 'copy', definition: { kind: 'installed', surface: definition }, bindings: {
                session: { kind: 'value', value: { serverId: 'home', sessionId: 'B' } }, count: { kind: 'value', value: 2 },
            } }, context: { surface: 'cli', authority: 'present_user' },
        });
        expect(result.status).toBe('invalid');
        expect(reads).toEqual(['A', 'B']);
    });
});
