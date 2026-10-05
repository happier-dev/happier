import { describe, expect, it } from 'vitest';
import { createCliWidgetInputActionDepsV1 } from './widgetInputActionDeps';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

describe('Widget Action input transport authority', () => {
    it('validates a picker-only typed pin before admitting executable widget input', async () => {
        const inputType = { pluginId: 'com.acme.widgets', localId: 'repository' };
        const surface = { pluginId: inputType.pluginId, localId: 'checks' };
        const type = { identity: inputType, occurrenceId: 'current', definition: { id: inputType.localId,
            title: 'Repository', semantic: 'repository', valueSchema: { type: 'object' as const,
                properties: { repositoryId: { type: 'string' as const } }, required: ['repositoryId'], additionalProperties: false } } };
        const deps = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId: 'viewer',
            getDeps: () => ({ ...createUnavailableActionTransportDeps(), resolveInputType: async () => type }),
            readCandidates: async () => [{ surface, availability: 'available', inputs: { fields: [
                { path: 'repository', title: 'Repository', widget: 'select', inputType },
            ] } }], validateSession: async () => true,
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
            getDeps: () => { throw new Error('No options may be read after Session admission refuses'); },
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
            getDeps: () => { throw new Error('No dynamic field options in this declaration'); },
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
        expect(reads).toEqual([undefined, 'B']);
    });
});
