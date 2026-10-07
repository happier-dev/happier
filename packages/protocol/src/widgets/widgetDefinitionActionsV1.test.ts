import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '../actions/actionExecutor.js';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { createWidgetDefinitionArtifactPortV1 } from './widgetDefinitionArtifactV1.js';
import { createSessionWidgetDefinitionSourceReaderV1 } from './widgetDefinitionPromotionV1.js';
import { SessionSurfaceItemV1Schema, isSessionSurfaceItemSourceCompatible } from '../sessions/board/item.js';
import { projectWidgetDefinitionForSharedPublicationV1, WidgetDefinitionV1Schema } from './widgetDefinitionV1.js';
import { resolveConfiguredWidgetInputs } from './widgetInputAdmissionV1.js';

const account = { serverId: 'home', accountId: 'owner' };
const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const descriptor = { sizeDeclaration: { sizes: ['medium', 'full'] as ('medium' | 'full')[], defaultSize: 'medium' as const }, inputs: { fields: [{ path: 'session', title: 'Session', widget: 'json' as const, required: true, optionsSourceId: 'sessions' }] },
    inputSchema: { type: 'object' as const, properties: { session: { type: 'object' as const, properties: { serverId: { type: 'string' as const }, sessionId: { type: 'string' as const } }, required: ['serverId', 'sessionId'], additionalProperties: false } }, required: ['session'], additionalProperties: false },
    sessionInputPath: 'session' };
describe('widget definition semantic Actions', () => {
    it('promotes a shared live definition into configurable Session inputs rather than retaining the source Session pin', async () => {
        const b = createWorkBoardArtifactBoundary();
        const port = createWidgetDefinitionArtifactPortV1({ ...b.transport,
            read: async (...args) => { const row = await b.transport.read(...args); return row ? { ...row, ownerAccountId: 'owner' } : null; },
            list: async args => { const page = await b.transport.list(args); return { ...page, items: page.items.map(row => ({ ...row, ownerAccountId: 'owner' })) }; },
        }, { accountId: 'owner' });
        const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'shared-original', name: 'Count', ...descriptor,
            body: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Count', value: { path: ['count'], type: 'number' },
                data: { kind: 'resource', resource: { pluginId: 'com.acme.test', localId: 'counts' }, inputSchema: descriptor.inputSchema,
                    outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false } } } } },
            provenance: { source: { kind: 'authored' } } });
        const item = SessionSurfaceItemV1Schema.parse({ v: 1, title: 'Count', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'widget', instance: { v: 1, id: 'source', definition: { kind: 'inline', definition },
                bindings: { session: { kind: 'value', value: { serverId: 'home', sessionId: 'session-a' } } } } } });
        const reader = createSessionWidgetDefinitionSourceReaderV1({ sessionBoardAction: async () => ({ v: 1, serverId: 'home', sessionId: 'session-a',
            capabilities: { readTranscript: true, editSessionRecords: true }, layout: null, items: [{ itemId: 'source', revision, title: item.title, sourceKind: 'widget', item }],
            incomplete: false, page: { cursor: null, hasNext: false } }), readInstalledDescriptor: async () => null });
        const executor = createActionExecutor({ widgetAccountScope: () => account, widgetDefinitionArtifacts: port, readSessionWidgetDefinitionSource: reader });
        const promoted = await executor.execute('widgets.definition.saveFromSession', { account, session: { serverId: 'home', sessionId: 'session-a' },
            itemId: 'source', artifactId: 'promoted-live' }, { surface: 'cli', serverId: 'home', bypassApprovals: true });
        expect(promoted).toMatchObject({ ok: true, result: { suggestedBindings: { session: { kind: 'context', slot: 'session' } } } });
        const saved = await port.get('promoted-live');
        expect(saved).not.toBeNull();
        const bound = resolveConfiguredWidgetInputs({ instance: { v: 1, id: 'placed-b', definition: { kind: 'artifact', artifactId: 'promoted-live' },
            bindings: { session: { kind: 'context', slot: 'session' } } }, descriptor: saved!, providedContext: { session: [{ serverId: 'home', sessionId: 'session-b' }] }, viewerValues: {} });
        expect(bound).toEqual({ status: 'ready', input: { session: { serverId: 'home', sessionId: 'session-b' } } });
        expect(saved?.body).toEqual(definition.body);
    });
    it('copies exact Session content without removing it and makes its contextual Session read configurable', async () => {
        const b = createWorkBoardArtifactBoundary();
        const port = createWidgetDefinitionArtifactPortV1({ ...b.transport,
            read: async (...args) => { const row = await b.transport.read(...args); return row ? { ...row, ownerAccountId: 'owner' } : null; },
            list: async args => { const page = await b.transport.list(args); return { ...page, items: page.items.map(row => ({ ...row, ownerAccountId: 'owner' })) }; },
        }, { accountId: 'owner' });
        const item = SessionSurfaceItemV1Schema.parse({ v: 1, title: 'Session checks', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'widget', instance: { v: 1, id: 'source-item', definition: { kind: 'installed', surface: { pluginId: 'com.acme.test', localId: 'checks' } },
                bindings: { session: { kind: 'value', value: { serverId: 'home', sessionId: 'session-a' } } } } } });
        const requests: string[] = [];
        const reader = createSessionWidgetDefinitionSourceReaderV1({
            // Sealed Session Board HTTP transport is the genuine system boundary.
            sessionBoardAction: async args => { requests.push(args.actionId); return { v: 1, serverId: 'home', sessionId: 'session-a',
                capabilities: { readTranscript: true, editSessionRecords: true }, layout: null,
                items: [{ itemId: 'source-item', revision, title: item.title, sourceKind: 'widget', item }], incomplete: false, page: { cursor: null, hasNext: false } }; },
            // The declared descriptor is an immutable current daemon projection response.
            readInstalledDescriptor: async () => descriptor,
        });
        const executor = createActionExecutor({ widgetAccountScope: () => account, widgetDefinitionArtifacts: port, readSessionWidgetDefinitionSource: reader });
        const result = await executor.execute('widgets.definition.saveFromSession', { account, session: { serverId: 'home', sessionId: 'session-a' },
            itemId: 'source-item', artifactId: 'promoted' }, { surface: 'cli', serverId: 'home', bypassApprovals: true });
        expect(result).toMatchObject({ ok: true, result: { definition: { id: 'promoted', inputs: descriptor.inputs,
            provenance: { source: { kind: 'session', serverId: 'home', sessionId: 'session-a', itemId: 'source-item' } } },
            suggestedBindings: { session: { kind: 'context', slot: 'session' } } } });
        expect(requests).toEqual(['session.board.get']);
        expect(item.source.kind === 'widget' && item.source.instance.bindings.session).toEqual({ kind: 'value', value: { serverId: 'home', sessionId: 'session-a' } });
        expect(await port.get('promoted')).toMatchObject({ sessionInputPath: 'session' });
        const wrongAccount = await executor.execute('widgets.definition.get', { account: { ...account, accountId: 'other' }, artifactId: 'promoted' }, { surface: 'cli', serverId: 'home' });
        expect(wrongAccount).toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
    });
    it('admits an explicit shared copy while rejecting private selections inside copied definition bytes', () => {
        const definition = WidgetDefinitionV1Schema.parse({ sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' }, v: 1, id: 'original', name: 'Checks', body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Count' } } },
            inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } } });
        const instance = { v: 1, id: 'copy', definition: { kind: 'inline', definition }, bindings: {} };
        const raw = { v: 1, title: 'Copy', frame: 'card', height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'widget', instance } };
        const item = SessionSurfaceItemV1Schema.parse(raw);
        const changedInputs = SessionSurfaceItemV1Schema.parse({ ...raw, source: { kind: 'widget', instance: { ...instance, bindings: { session: { kind: 'context', slot: 'session' } } } } });
        expect(isSessionSurfaceItemSourceCompatible(item, changedInputs)).toBe(true);
        const editedCopy = SessionSurfaceItemV1Schema.parse({ ...raw, source: { kind: 'widget', instance: { ...instance,
            definition: { kind: 'inline', definition: { ...definition, name: 'Edited shared copy',
                body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Shared edit' } } } } },
        } } });
        expect(isSessionSurfaceItemSourceCompatible(item, editedCopy)).toBe(true);
        expect(SessionSurfaceItemV1Schema.safeParse({ ...raw, source: { kind: 'widget', instance: { ...instance,
            bindings: { connection: { kind: 'value', value: { nested: [{ service: { pluginId: 'com.acme.test', localId: 'cloud' }, accountId: 'private' }] } } },
        } } }).success).toBe(false);
        const liveDefinition = { ...definition, body: { kind: 'declarative', document: { version: 1, root: {
            kind: 'metric', label: 'Count', value: { path: ['count'], type: 'number' }, data: { kind: 'resource',
                resource: { pluginId: 'com.acme.test', localId: 'counts' }, inputSchema: { type: 'object', additionalProperties: false },
                outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false },
            },
        } } } };
        const liveRaw = { ...raw, source: { kind: 'widget', instance: { ...instance, definition: { kind: 'inline', definition: liveDefinition } } } };
        expect(SessionSurfaceItemV1Schema.safeParse(liveRaw).success).toBe(true);
        expect(SessionSurfaceItemV1Schema.safeParse({ ...liveRaw, source: { kind: 'widget', instance: { ...instance, definition: { kind: 'inline',
            definition: { ...liveDefinition, body: { ...liveDefinition.body, document: { version: 1, root: { ...liveDefinition.body.document.root,
                data: { ...liveDefinition.body.document.root.data, input: {} },
            } } } },
        } } } }).success).toBe(false);
        const personal = WidgetDefinitionV1Schema.parse({ ...liveDefinition, body: { ...liveDefinition.body, document: { version: 1,
            root: { ...liveDefinition.body.document.root, data: { ...liveDefinition.body.document.root.data, input: {} } },
        } } });
        const projected = projectWidgetDefinitionForSharedPublicationV1(personal);
        expect(SessionSurfaceItemV1Schema.safeParse({ ...raw, source: { kind: 'widget', instance: { ...instance,
            definition: { kind: 'inline', definition: projected },
        } } }).success).toBe(true);
        expect(personal.body.kind === 'declarative' && 'data' in personal.body.document.root && personal.body.document.root.data).toMatchObject({ input: {} });
        expect(SessionSurfaceItemV1Schema.safeParse({ ...raw, source: { kind: 'widget', instance: { ...instance, definition: { kind: 'inline', definition: { ...definition,
            inputs: { fields: [{ path: 'connection', title: 'Connection', widget: 'select', options: [{ label: 'Author connection', value: { service: { pluginId: 'com.acme.test', localId: 'cloud' }, accountId: 'private' } }] }] },
        } } } } }).success).toBe(false);
    });
});
