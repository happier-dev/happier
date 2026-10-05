import { describe, expect, it } from 'vitest';

import { admitDeclarativeStaticModel } from './declarativeStaticModel';

const action = Object.freeze({
    identity: Object.freeze({ pluginId: 'acme.dashboard', localId: 'refresh' }),
    qualifiedId: 'acme.dashboard/refresh',
    occurrenceId: '7',
    enabled: true,
    title: 'Refresh',
});
const destination = Object.freeze({
    identity: Object.freeze({ pluginId: 'acme.dashboard', localId: 'details' }),
    qualifiedId: 'acme.dashboard/details',
    occurrenceId: '7',
});
const setting = Object.freeze({
    pluginId: 'acme.dashboard',
    id: 'density',
    qualifiedId: 'acme.dashboard/density',
    schema: Object.freeze({ type: 'string' }),
    secret: false,
    setting: Object.freeze({
        id: 'density',
        contributionId: 'dashboard',
        qualifiedId: 'acme.dashboard/density',
        descriptor: Object.freeze({
            id: 'density',
            title: 'Density',
            target: Object.freeze({ kind: 'plugin' }),
            scope: 'account',
            schema: Object.freeze({ type: 'string' }),
            secret: false,
        }),
    }),
});
const uiQuery = Object.freeze({
    collection: Object.freeze({ pluginId: 'acme.dashboard', collectionId: 'tasks' }),
    id: 'open-tasks',
    indexId: 'by-status',
    parameters: Object.freeze({
        status: Object.freeze({ kind: 'string', maxUtf8Bytes: 16, enum: Object.freeze(['open']) }),
    }),
    prefix: Object.freeze([{ kind: 'parameter', parameterId: 'status' }]),
    order: 'asc',
    pageSize: 20,
    projectedFields: Object.freeze([{ field: 'title', kind: 'string' }]),
});

function model(inventory: Readonly<Record<string, unknown>>) {
    return Object.freeze({
        identity: Object.freeze({
            pluginId: 'acme.dashboard',
            localId: 'dashboard',
            qualifiedId: 'acme.dashboard/dashboard',
            occurrenceId: '7',
        }),
        visible: true,
        requiredHostMethods: Object.freeze([]),
        declarativeInventory: Object.freeze({
            actions: Object.freeze([]),
            destinations: Object.freeze([]),
            settings: Object.freeze([]),
            uiQueries: Object.freeze([]),
            ...inventory,
        }),
        root: Object.freeze({ kind: 'text', path: 'root', order: 0, text: 'Dashboard' }),
    });
}

describe('admitDeclarativeStaticModel', () => {
    it('reattaches drag nodes only to this model declaration and occurrence', () => {
        const source = { ...destination, identity: { pluginId: 'acme.dashboard', localId: 'card' }, qualifiedId: 'acme.dashboard/card', referenceSchema: { type: 'string' } };
        const target = { ...destination, identity: { pluginId: 'acme.dashboard', localId: 'tray' }, qualifiedId: 'acme.dashboard/tray' };
        const sourceReference = { identity: source.identity, qualifiedId: source.qualifiedId, occurrenceId: source.occurrenceId };
        const root = { kind: 'dropTarget', path: 'root', order: 0, target, children: [
            { kind: 'dragSource', path: 'root.children[0]', order: 1, source: sourceReference, reference: '42', children: [] },
        ] };
        const candidate = { ...model({ dragSources: [source], dropTargets: [target] }), root };
        expect(admitDeclarativeStaticModel({ model: candidate, expectedPluginId: 'acme.dashboard' })?.dragSources.size).toBe(1);
        for (const reference of [
            { ...sourceReference, occurrenceId: 'retired' },
            { ...sourceReference, qualifiedId: 'acme.dashboard/missing' },
            { ...sourceReference, identity: { pluginId: 'foreign.plugin', localId: 'card' }, qualifiedId: 'foreign.plugin/card' },
        ]) {
            expect(admitDeclarativeStaticModel({ model: { ...candidate, root: { ...root, children: [{ ...root.children[0], source: reference }] } },
                expectedPluginId: 'acme.dashboard' })).toBeNull();
        }
        expect(admitDeclarativeStaticModel({ model: { ...candidate, declarativeInventory: { ...candidate.declarativeInventory, dragSources: [] } },
            expectedPluginId: 'acme.dashboard' })).toBeNull();
    });
    it('admits one immutable qualified inventory view', () => {
        const admitted = admitDeclarativeStaticModel({
            model: model({
                actions: [action],
                destinations: [destination],
                settings: [setting],
                uiQueries: [uiQuery],
            }),
            expectedPluginId: 'acme.dashboard',
        });

        expect(admitted?.occurrenceId).toBe('7');
        expect(admitted?.actions.get(action.qualifiedId)?.enabled).toBe(true);
        expect(admitted?.destinations.get(destination.qualifiedId)?.identity.localId).toBe('details');
        expect(admitted?.settingsById.get('density')?.inventory.qualifiedId).toBe('acme.dashboard/density');
        expect(admitted?.uiQueries.size).toBe(1);
        expect(Object.isFrozen(admitted)).toBe(true);
    });

    it.each([
        ['two Actions', { actions: [action, action] }],
        ['three Actions', { actions: [action, action, action] }],
        ['two destinations', { destinations: [destination, destination] }],
        ['three destinations', { destinations: [destination, destination, destination] }],
        ['two Settings bindings', { settings: [setting, setting] }],
        ['two UI queries', { uiQueries: [uiQuery, uiQuery] }],
    ])('rejects the whole model for %s instead of selecting a competing authority', (_label, inventory) => {
        expect(admitDeclarativeStaticModel({
            model: model(inventory),
            expectedPluginId: 'acme.dashboard',
        })).toBeNull();
    });

    it.each([
        ['actions', 'missing', undefined],
        ['actions', 'malformed', Object.freeze({})],
        ['destinations', 'missing', undefined],
        ['destinations', 'malformed', Object.freeze({})],
        ['settings', 'missing', undefined],
        ['settings', 'malformed', Object.freeze({})],
        ['uiQueries', 'missing', undefined],
        ['uiQueries', 'malformed', Object.freeze({})],
    ] as const)('rejects a %s inventory that is %s instead of silently treating it as empty', (
        inventoryKey,
        _condition,
        replacement,
    ) => {
        const complete = model({});
        const completeInventory = complete.declarativeInventory;
        const candidateInventory: Record<string, unknown> = Object.fromEntries(Object.entries(completeInventory)
            .filter(([key]) => key !== inventoryKey));
        if (replacement !== undefined) candidateInventory[inventoryKey] = replacement;

        expect(admitDeclarativeStaticModel({
            model: Object.freeze({
                ...complete,
                declarativeInventory: Object.freeze(candidateInventory),
            }),
            expectedPluginId: 'acme.dashboard',
        })).toBeNull();
    });

    it('rejects an identity whose qualified id does not match its local id', () => {
        const candidate = {
            ...model({}),
            identity: Object.freeze({
                pluginId: 'acme.dashboard',
                localId: 'dashboard',
                qualifiedId: 'acme.dashboard/another-surface',
                occurrenceId: '7',
            }),
        };
        expect(admitDeclarativeStaticModel({
            model: candidate,
            expectedPluginId: 'acme.dashboard',
        })).toBeNull();
    });

    it('rejects a root field that disagrees with the admitted Settings projection', () => {
        const candidate = {
            ...model({ settings: [setting] }),
            root: Object.freeze({
                kind: 'field',
                path: 'root',
                order: 0,
                setting: Object.freeze({
                    ...setting.setting,
                    descriptor: Object.freeze({
                        ...setting.setting.descriptor,
                        scope: 'daemon',
                    }),
                }),
            }),
        };
        expect(admitDeclarativeStaticModel({
            model: candidate,
            expectedPluginId: 'acme.dashboard',
        })).toBeNull();
    });

    it('also checks Settings custody under a targeted-surface fallback child', () => {
        const mismatchedField = Object.freeze({
            kind: 'field',
            path: 'root.fallback',
            order: 0,
            setting: Object.freeze({
                ...setting.setting,
                descriptor: Object.freeze({
                    ...setting.setting.descriptor,
                    scope: 'daemon',
                }),
            }),
        });
        const candidate = {
            ...model({ settings: [setting] }),
            root: Object.freeze({
                kind: 'targetedSurface',
                path: 'root',
                order: 0,
                fallback: mismatchedField,
            }),
        };
        expect(admitDeclarativeStaticModel({
            model: candidate,
            expectedPluginId: 'acme.dashboard',
        })).toBeNull();
    });
});
