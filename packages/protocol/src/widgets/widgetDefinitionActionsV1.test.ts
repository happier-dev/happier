import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '../actions/actionExecutor.js';
import { ActionsSettingsV1Schema } from '../actions/actionSettings.js';
import { isApprovalRequiredByActionsSettings } from '../actions/actionApprovalPolicy.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
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
    it.each(['widgets.definition.create', 'widgets.definition.duplicate', 'widgets.definition.saveFromSession'] as const)('refuses an invalid new Artifact identity at the %s boundary', async actionId => {
        const requests: unknown[] = [];
        const boundary = createWorkBoardArtifactBoundary();
        const port = createWidgetDefinitionArtifactPortV1(boundary.forAccount(account.accountId), { accountId: account.accountId });
        const draft = { name: 'Count', sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] },
            inputSchema: { type: 'object', additionalProperties: false },
            body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Count' } } } };
        await port.create(WidgetDefinitionV1Schema.parse({ v: 1, id: 'retained-id', ...draft, provenance: { source: { kind: 'authored' } } }));
        const executor = createActionExecutor({ widgetAccountScope: () => account, widgetDefinitionArtifacts: port,
            approvalsCreate: async ({ request }) => { requests.push(request); return { artifactId: 'approval' }; } });
        const input = actionId === 'widgets.definition.create'
            ? { account, artifactId: 'not-a-uuid', definition: draft }
            : actionId === 'widgets.definition.duplicate' ? { account, artifactId: 'retained-id', newArtifactId: 'not-a-uuid' }
                : { account, artifactId: 'not-a-uuid', session: { serverId: account.serverId, sessionId: 'session-a' }, itemId: 'source' };
        expect(await executor.execute(actionId, input, { surface: 'agent', serverId: account.serverId,
            defaultSessionId: 'session-a', actionRequestId: 'invalid-identity' }))
            .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(requests).toEqual([]);
        expect(await port.get('not-a-uuid')).toBeNull();
        expect(await executor.execute('widgets.definition.get', { account, artifactId: 'retained-id' }, { surface: 'ui', serverId: account.serverId }))
            .toMatchObject({ ok: true, result: { definition: { id: 'retained-id' } } });
    });
    it('promotes HTML through the real Save Action into an independent library bundle with its admitted policy', async () => {
        const boundary = createWorkBoardArtifactBoundary();
        const port = createWidgetDefinitionArtifactPortV1({ ...boundary.transport,
            read: async (...args) => { const row = await boundary.transport.read(...args); return row ? { ...row, ownerAccountId: account.accountId } : null; },
            list: async args => { const page = await boundary.transport.list(args); return { ...page, items: page.items.map(row => ({ ...row, ownerAccountId: account.accountId })) }; },
        }, { accountId: account.accountId });
        const source = { v: 1, entrypoint: 'index.html', files: {
            'index.html': { mime: 'text/html', contentBase64: 'PGgxPlJlc3VsdDwvaDE+' },
            'data.json': { mime: 'application/json', contentBase64: 'e30=' },
        } };
        const item = SessionSurfaceItemV1Schema.parse({ v: 1, title: 'Result', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'hostedHtml', source, requestedCapabilities: { networkOrigins: ['https://cdn.example.com'] } } });
        let currentItem = item;
        const reader = createSessionWidgetDefinitionSourceReaderV1({ sessionBoardAction: async () => ({ v: 1, serverId: account.serverId, sessionId: 'session-a',
            capabilities: { readTranscript: true, editSessionRecords: false }, layout: null, items: [{ itemId: 'source', revision, title: currentItem.title, sourceKind: currentItem.source.kind, item: currentItem }],
            incomplete: false, page: { cursor: null, hasNext: false } }), readInstalledDescriptor: async () => null });
        const executor = createActionExecutor({ widgetAccountScope: () => account, widgetDefinitionArtifacts: port, readSessionWidgetDefinitionSource: reader });
        const result = await executor.execute('widgets.definition.saveFromSession', { account, session: { serverId: account.serverId, sessionId: 'session-a' },
            itemId: 'source', artifactId: 'f886bc99-2489-4bb8-8214-fac6458c9f38' }, { surface: 'ui', authority: 'present_user', serverId: account.serverId, bypassApprovals: true });
        expect(result).toMatchObject({ ok: true, result: { definition: { id: 'f886bc99-2489-4bb8-8214-fac6458c9f38', body: {
            kind: 'html', source, requestedCapabilities: { networkOrigins: ['https://cdn.example.com'] },
        } }, suggestedBindings: {} } });
        const saved = await port.get('f886bc99-2489-4bb8-8214-fac6458c9f38');
        expect(saved?.body).toEqual({ kind: 'html', source, requestedCapabilities: { networkOrigins: ['https://cdn.example.com'] } });
        expect(await port.list()).toMatchObject([{ artifactId: 'f886bc99-2489-4bb8-8214-fac6458c9f38', bodyKind: 'html' }]);
        currentItem = SessionSurfaceItemV1Schema.parse({ ...item, source: { kind: 'widget', instance: {
            v: 1, id: 'source', definition: { kind: 'inline', definition: saved }, bindings: {}, networkOverride: { network: 'none' },
        } } });
        expect(await executor.execute('widgets.definition.saveFromSession', { account, session: { serverId: account.serverId, sessionId: 'session-a' },
            itemId: 'source', artifactId: 'af0d3196-5428-41e6-88bd-03f3c41a8ee6' }, { surface: 'ui', authority: 'present_user', serverId: account.serverId, bypassApprovals: true }))
            .toMatchObject({ ok: true, result: { definition: { networkOverride: { network: 'none' },
                body: { kind: 'html', source, requestedCapabilities: { network: 'none' } } } } });
        source.files['index.html'].contentBase64 = 'PGgxPkVkaXQ8L2gxPg==';
        expect((await port.get('f886bc99-2489-4bb8-8214-fac6458c9f38'))?.body).toEqual(saved?.body);
        expect(await executor.execute('widgets.definition.create', { account, artifactId: 'aaf11a6d-d846-4a0b-8cda-8c0f48b22829', definition: {
            name: 'New HTML', body: saved!.body, inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
        } }, { surface: 'agent', serverId: account.serverId, defaultSessionId: 'session-a',
            actionCaller: { kind: 'session', sessionId: 'session-a', starterDepth: 0, turnDepth: 0 }, actionRequestId: 'html-create' }))
            .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
        expect(await port.get('aaf11a6d-d846-4a0b-8cda-8c0f48b22829')).toBeNull();
    });

    it('defers saving Session content until the canonical approval owner admits the library copy', async () => {
        const boundary = createWorkBoardArtifactBoundary();
        const port = createWidgetDefinitionArtifactPortV1({ ...boundary.transport,
            read: async (...args) => { const row = await boundary.transport.read(...args); return row ? { ...row, ownerAccountId: account.accountId } : null; },
            list: async args => { const page = await boundary.transport.list(args); return { ...page, items: page.items.map(row => ({ ...row, ownerAccountId: account.accountId })) }; },
        }, { accountId: account.accountId });
        const item = SessionSurfaceItemV1Schema.parse({ v: 1, title: 'Session output', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Private output' } } } });
        const reader = createSessionWidgetDefinitionSourceReaderV1({ sessionBoardAction: async () => ({ v: 1, serverId: account.serverId, sessionId: 'session-a',
            capabilities: { readTranscript: true, editSessionRecords: true }, layout: null, items: [{ itemId: 'source', revision, title: item.title, sourceKind: 'declarative', item }],
            incomplete: false, page: { cursor: null, hasNext: false } }), readInstalledDescriptor: async () => null });
        const requests: unknown[] = [];
        const executor = createActionExecutor({ widgetAccountScope: () => account, widgetDefinitionArtifacts: port, readSessionWidgetDefinitionSource: reader,
            approvalsCreate: async ({ request }) => { requests.push(request); return { artifactId: 'save-approval' }; },
        });
        expect(await executor.execute('widgets.definition.saveFromSession', { account, session: { serverId: account.serverId, sessionId: 'session-a' }, itemId: 'source', artifactId: 'fae94558-ca81-4a2e-8fdb-ec1bed33c7af' },
            { surface: 'cli', serverId: account.serverId, defaultSessionId: 'session-a', actionCaller: { kind: 'host' }, actionRequestId: 'save-from-session' }))
            .toEqual({ ok: true, result: { kind: 'approval_request_created', artifactId: 'save-approval', actionId: 'widgets.definition.saveFromSession' } });
        expect(requests).toMatchObject([{ actionId: 'widgets.definition.saveFromSession', approval: { flow: 'deferred', result: 'required' } }]);
        expect(await port.get('fae94558-ca81-4a2e-8fdb-ec1bed33c7af')).toBeNull();
        expect(item.source).toEqual({ kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Private output' } } });
    });
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
            itemId: 'source', artifactId: '9224803d-1ffe-4a49-8c63-92aa7382ccff' }, { surface: 'cli', serverId: 'home', bypassApprovals: true });
        expect(promoted).toMatchObject({ ok: true, result: { suggestedBindings: { session: { kind: 'context', slot: 'session' } } } });
        const saved = await port.get('9224803d-1ffe-4a49-8c63-92aa7382ccff');
        expect(saved).not.toBeNull();
        const bound = resolveConfiguredWidgetInputs({ instance: { v: 1, id: 'placed-b', definition: { kind: 'artifact', artifactId: '9224803d-1ffe-4a49-8c63-92aa7382ccff' },
            bindings: { session: { kind: 'context', slot: 'session' } } }, descriptor: saved!, providedContext: { session: [{ serverId: 'home', sessionId: 'session-b' }] }, viewerValues: {} });
        expect(bound).toEqual({ status: 'ready', input: { session: { serverId: 'home', sessionId: 'session-b' } } });
        expect(saved?.body).toEqual(definition.body);
    });
    it.each(['cli', 'voice'] as const)('copies exact Session content on %s without removing it and makes its contextual Session read configurable', async (surface) => {
        const b = createWorkBoardArtifactBoundary();
        const port = createWidgetDefinitionArtifactPortV1({ ...b.transport,
            read: async (...args) => { const row = await b.transport.read(...args); return row ? { ...row, ownerAccountId: 'owner' } : null; },
            list: async args => { const page = await b.transport.list(args); return { ...page, items: page.items.map(row => ({ ...row, ownerAccountId: 'owner' })) }; },
        }, { accountId: 'owner' });
        const item = SessionSurfaceItemV1Schema.parse({ v: 1, title: 'Session checks', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'widget', instance: { v: 1, id: 'source-item', definition: { kind: 'installed', surface: { pluginId: 'com.acme.test', localId: 'checks' } },
                networkOverride: { network: 'none' },
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
            itemId: 'source-item', artifactId: '8ced9e9f-4305-4794-8dd9-8138b9ac378e' }, { surface, serverId: 'home', bypassApprovals: true });
        expect(result).toMatchObject({ ok: true, result: { definition: { id: '8ced9e9f-4305-4794-8dd9-8138b9ac378e', inputs: descriptor.inputs,
            provenance: { source: { kind: 'session', serverId: 'home', sessionId: 'session-a', itemId: 'source-item' } } },
            suggestedBindings: { session: { kind: 'context', slot: 'session' } } } });
        expect(requests).toEqual(['session.board.get']);
        expect(item.source.kind === 'widget' && item.source.instance.bindings.session).toEqual({ kind: 'value', value: { serverId: 'home', sessionId: 'session-a' } });
        expect(await port.get('8ced9e9f-4305-4794-8dd9-8138b9ac378e')).toMatchObject({ sessionInputPath: 'session', networkOverride: { network: 'none' } });
        const wrongAccount = await executor.execute('widgets.definition.get', { account: { ...account, accountId: 'other' }, artifactId: '8ced9e9f-4305-4794-8dd9-8138b9ac378e' }, { surface: 'cli', serverId: 'home' });
        expect(wrongAccount).toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
    });
    it('honors an explicit Voice Ask before changing the Account library', async () => {
        const boundary = createWorkBoardArtifactBoundary();
        const port = createWidgetDefinitionArtifactPortV1({ ...boundary.transport,
            read: async (...args) => { const row = await boundary.transport.read(...args); return row ? { ...row, ownerAccountId: 'owner' } : null; },
            list: async args => { const page = await boundary.transport.list(args); return { ...page, items: page.items.map(row => ({ ...row, ownerAccountId: 'owner' })) }; },
        }, { accountId: 'owner' });
        let approvalRequest: ApprovalRequest | null = null;
        const executor = createActionExecutor({ widgetAccountScope: () => account, widgetDefinitionArtifacts: port,
            isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, context.actionsSettings ?? ActionsSettingsV1Schema.parse({ v: 1 }), context),
            // Approval persistence is a host system boundary; the decision owner remains real.
            approvalsCreate: async ({ request }) => { approvalRequest = request; return { artifactId: 'definition-approval' }; },
            approvalsGet: async () => approvalRequest,
            approvalsUpdate: async ({ request }) => { approvalRequest = request; return { ok: true }; },
        });
        const context = { surface: 'voice' as const, serverId: 'home', actionCaller: { kind: 'host' as const }, actionRequestId: 'definition-update' };
        const input = { account, artifactId: 'a685e92b-ed95-4899-85dc-7b2162f004e0', definition: { name: 'Original', ...descriptor,
            body: { kind: 'installed', surface: { pluginId: 'com.acme.test', localId: 'signups' } } } };
        expect(await executor.execute('widgets.definition.create', input, context)).toMatchObject({ ok: true });
        const update = { account, artifactId: input.artifactId, patch: { name: 'Changed' } };
        const approval = await executor.execute('widgets.definition.update', update, { ...context,
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'widgets.definition.update': { approvalRequiredSurfaces: ['voice'] } } }),
        });
        expect(approval).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'definition-approval' } });
        expect((await port.get(input.artifactId))?.name).toBe('Original');
        expect(await executor.execute('approval.request.decide', { artifactId: 'definition-approval', decision: 'reject' },
            { surface: 'ui', authority: 'present_user', serverId: 'home' }))
            .toMatchObject({ ok: true, result: { status: 'rejected' } });
        expect((await port.get(input.artifactId))?.name).toBe('Original');
        expect(await executor.execute('widgets.definition.update', update, { ...context,
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'widgets.definition.update': { enabled: false } } }),
        })).toMatchObject({ ok: false, errorCode: 'action_disabled' });
        expect((await port.get(input.artifactId))?.name).toBe('Original');
        expect(await executor.execute('widgets.definition.update', update, { ...context,
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'widgets.definition.update': ['voice'] } }),
        })).toMatchObject({ ok: true, result: { definition: { name: 'Changed' } } });
        expect(await executor.execute('widgets.definition.list', { account }, context)).toMatchObject({
            ok: true, result: { definitions: [{ artifactId: input.artifactId, name: 'Changed' }] },
        });
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

    it('records who made a definition and when, and lists both in its readable summary', async () => {
        const b = createWorkBoardArtifactBoundary();
        const port = createWidgetDefinitionArtifactPortV1({ ...b.transport,
            read: async (...args) => { const row = await b.transport.read(...args); return row ? { ...row, ownerAccountId: 'owner' } : null; },
            list: async args => { const page = await b.transport.list(args); return { ...page, items: page.items.map(row => ({ ...row, ownerAccountId: 'owner' })) }; },
        }, { accountId: 'owner' });
        const executor = createActionExecutor({ widgetAccountScope: () => account, widgetDefinitionArtifacts: port });
        const draft = { name: 'Signups', ...descriptor, body: { kind: 'installed', surface: { pluginId: 'com.acme.test', localId: 'signups' } } };
        vi.useFakeTimers();
        try {
            vi.setSystemTime(Date.UTC(2026, 9, 3, 9, 30));
            expect(await executor.execute('widgets.definition.create', { account, artifactId: 'aaa148c0-2da1-48dc-8aa5-3046717b4beb', definition: draft },
                { surface: 'agent', serverId: 'home', bypassApprovals: true })).toMatchObject({ ok: true });
            vi.setSystemTime(Date.UTC(2026, 9, 4, 12, 0));
            expect(await executor.execute('widgets.definition.create', { account, artifactId: '1f72c7e9-ae22-4903-85b6-339d144f6ecc', definition: { ...draft, name: 'Mine' } },
                { surface: 'ui', serverId: 'home', authority: 'present_user', bypassApprovals: true })).toMatchObject({ ok: true });
        } finally { vi.useRealTimers(); }
        const listed = await executor.execute('widgets.definition.list', { account }, { surface: 'ui', serverId: 'home', authority: 'present_user' });
        expect(listed).toMatchObject({ ok: true, result: { definitions: expect.arrayContaining([
            expect.objectContaining({ artifactId: 'aaa148c0-2da1-48dc-8aa5-3046717b4beb', author: { kind: 'agent' }, createdAt: Date.UTC(2026, 9, 3, 9, 30) }),
            expect.objectContaining({ artifactId: '1f72c7e9-ae22-4903-85b6-339d144f6ecc', author: { kind: 'person' }, createdAt: Date.UTC(2026, 9, 4, 12, 0) }),
        ]) } });
        expect((await port.get('aaa148c0-2da1-48dc-8aa5-3046717b4beb'))?.provenance).toMatchObject({ author: { kind: 'agent' }, createdAt: Date.UTC(2026, 9, 3, 9, 30) });
    });
});
