import { describe, expect, it } from 'vitest';
import { AccountProfileSchema } from '../account/profile.js';
import { createActionExecutor, type ActionExecutorDeps } from '../actions/actionExecutor.js';
import { ActionsSettingsV1Schema } from '../actions/actionSettings.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { sameQualifiedConnectedAccountRef } from '../connect/qualifiedConnectedAccountPersistence.js';
import { createWidgetActionInputResolverV1 } from './widgetActionInputResolverV1.js';
import { resolveWidgetViewerPurposeValuesV1 } from './widgetViewerPurposeV1.js';
import type { WidgetInputDescriptorV1 } from './widgetInputAdmissionV1.js';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { createWorkBoardArtifactPortV1 } from '../boards/workBoardArtifactV1.js';
import { createWorkBoardV1 } from '../boards/workBoardV1.js';
import { createWorkBoardWidgetActionPortV1 } from './workBoardWidgetActionPortV1.js';
import { createWidgetDefinitionArtifactPortV1 } from './widgetDefinitionArtifactV1.js';
import { createHomeHubArtifactPortV1 } from '../home/homeHubArtifactV1.js';
import { createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1 } from './widgetSurfaceArtifactV1.js';
import { WidgetDefinitionV1Schema } from './widgetDefinitionV1.js';
import { createSessionWidgetDefinitionSourceReaderV1 } from './widgetDefinitionPromotionV1.js';
import { SessionSurfaceItemV1Schema, type SessionSurfaceItemV1 } from '../sessions/board/item.js';
import { readBuiltinWidgetDescriptorV1 } from './builtinWidgetDescriptorV1.js';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import { readInputPath } from '../inputs/inputPredicates.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { getArtifactUseTargetV1 } from '../artifacts/artifactSharingV1.js';
import { buildWidgetDefinitionArtifactHeaderV1 } from './widgetDefinitionArtifactV1.js';
import { readUsagePeriodOptions } from '../inputs/usageQuery.js';

describe('shared widget publication purpose admission', () => {
    it('promotes Session declarative, installed, HTML and builtin content then adds independent copies with captured policy', async () => {
        const account = { serverId: 'home', accountId: 'viewer' };
        const boundary = createWorkBoardArtifactBoundary([createWorkBoardV1({ id: 'board', name: 'Destination' })]);
        const accountTransport = boundary.forAccount(account.accountId);
        const widgetDefinitionArtifacts = createWidgetDefinitionArtifactPortV1({ ...boundary.transport,
            read: accountTransport.read,
            list: async args => { const page = await boundary.transport.list(args); return { ...page, items: page.items.map(row => ({ ...row, ownerAccountId: account.accountId })) }; },
        }, { accountId: account.accountId });
        const homeHubArtifacts = createHomeHubArtifactPortV1(accountTransport, { accountId: account.accountId });
        const home = { ...account, owner: { kind: 'home' as const } };
        const project = { ...account, owner: { kind: 'project' as const, projectId: 'project' } };
        const board = { ...account, owner: { kind: 'workBoard' as const, boardId: 'board' } };
        const workBoardArtifacts = createWorkBoardArtifactPortV1({ ...boundary.transport, read: accountTransport.read });
        let sourceItem: SessionSurfaceItemV1 | null = null;
        const emptyDescriptor = { inputs: { fields: [] }, inputSchema: { type: 'object' as const, additionalProperties: false },
            sizeDeclaration: { sizes: ['medium' as const], defaultSize: 'medium' as const } };
        const reader = createSessionWidgetDefinitionSourceReaderV1({
            // Session record HTTP and immutable installed-descriptor projection are transport boundaries.
            sessionBoardAction: async () => ({ v: 1, serverId: account.serverId, sessionId: 'source-session',
                capabilities: { readTranscript: true, editSessionRecords: false }, layout: null,
                items: sourceItem ? [{ itemId: 'source-item', revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', title: sourceItem.title,
                    sourceKind: sourceItem.source.kind, item: sourceItem }] : [], incomplete: false, page: { cursor: null, hasNext: false } }),
            readInstalledDescriptor: async () => emptyDescriptor,
        });
        const executor = createActionExecutor({ widgetAccountScope: () => account, widgetDefinitionArtifacts, homeHubArtifacts,
            readSessionWidgetDefinitionSource: reader,
            workBoardArtifacts,
            widgetSurfaceActions: {
                project: createWidgetAreaActionPortV1(target => createWidgetSurfaceArtifactPortV1(accountTransport, { surface: target, isCurrent: () => true })),
                workBoard: createWorkBoardWidgetActionPortV1(workBoardArtifacts),
            },
            widgetInputs: createWidgetActionInputResolverV1({
                readDescriptor: async request => request.instance.definition.kind === 'artifact'
                    ? widgetDefinitionArtifacts.get(request.instance.definition.artifactId) : null,
                readContext: async () => ({}), readViewerValues: async () => ({ values: {} }),
                validateValue: async () => ({ status: 'valid' }),
                // The Period's choices are protocol-local, as the real options resolver answers them.
                resolveOptions: async (field, input) => field.optionsSourceId === 'usage.query.period' ? readUsagePeriodOptions(input.period) : [],
            }),
        });
        const draft = { v: 1, name: 'Library copy', inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, provenance: { source: { kind: 'authored' } } };
        const installed = WidgetDefinitionV1Schema.parse({ ...draft, id: '859e0d79-80a9-4ebc-86ab-775b0868d404', networkOverride: { network: 'none' },
            body: { kind: 'installed', surface: { pluginId: 'acme.metrics', localId: 'widget' } } });
        const html = WidgetDefinitionV1Schema.parse({ ...draft, id: 'f886bc99-2489-4bb8-8214-fac6458c9f38', body: { kind: 'html', requestedCapabilities: { networkOrigins: ['https://cdn.example.com'] },
            source: { v: 1, entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html', contentBase64: 'PGgxPlJlc3VsdDwvaDE+' } } } } });
        const declarative = WidgetDefinitionV1Schema.parse({ ...draft, id: 'fb501d1b-236a-4cb5-87c7-64d77fe32bb8',
            body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Saved result' } } } });
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: account.serverId };
        for (const definition of [installed, html, declarative]) {
            sourceItem = SessionSurfaceItemV1Schema.parse({ v: 1, title: definition.name, frame: 'card', height: { mode: 'auto', fallback: 'regular' },
                source: definition.body.kind === 'installed' ? { kind: 'widget', instance: {
                    v: 1, id: 'source-item', definition: definition.body, bindings: {}, networkOverride: definition.networkOverride,
                } } : definition.body.kind === 'html' ? { kind: 'hostedHtml', source: definition.body.source,
                    requestedCapabilities: definition.body.requestedCapabilities } : definition.body.kind === 'declarative'
                        ? { kind: 'declarative', document: definition.body.document }
                        : { kind: 'widget', instance: { v: 1, id: 'source-item', definition: definition.body, bindings: {} } } });
            const promoted = await executor.execute('widgets.definition.saveFromSession', { account, session: { serverId: account.serverId, sessionId: 'source-session' },
                itemId: 'source-item', artifactId: definition.id }, { ...context, bypassApprovals: true });
            expect(promoted, JSON.stringify(promoted)).toMatchObject({ ok: true, result: { definition: {
                    body: definition.body, provenance: { source: { kind: 'session', serverId: account.serverId, sessionId: 'source-session', itemId: 'source-item' } },
                } } });
        }
        for (const surface of [home, board, project]) for (const definition of [installed, html, declarative]) {
            const instance = { v: 1, id: `${definition.id}-${surface.owner.kind}`, definition: { kind: 'artifact', artifactId: definition.id }, bindings: {} };
            const result = await executor.execute('widgets.item.add', { surface, instance }, context);
            expect(result).toMatchObject({ ok: true, result: { instance: { ...instance,
                ...(definition.id === declarative.id ? {} : {
                    networkOverride: definition.id === installed.id ? { network: 'none' } : { networkOrigins: ['https://cdn.example.com'] },
                }) } } });
        }
        await widgetDefinitionArtifacts.update(installed.id, { networkOverride: { network: 'open' } });
        await widgetDefinitionArtifacts.update(html.id, { body: { ...html.body, requestedCapabilities: { network: 'open' } } });
        for (const surface of [home, board, project]) expect(await executor.execute('widgets.item.list', { surface }, context))
            .toMatchObject({ ok: true, result: { instances: expect.arrayContaining([
                expect.objectContaining({ instance: expect.objectContaining({ id: `${installed.id}-${surface.owner.kind}`, networkOverride: { network: 'none' } }) }),
                expect.objectContaining({ instance: expect.objectContaining({ id: `${html.id}-${surface.owner.kind}`, networkOverride: { networkOrigins: ['https://cdn.example.com'] } }) }),
                expect.objectContaining({ instance: expect.objectContaining({ id: `${declarative.id}-${surface.owner.kind}`, definition: { kind: 'artifact', artifactId: declarative.id } }) }),
            ]) } });
        const builtin = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'usage_daily' })!;
        const query = normalizeUsageQuery({ period: { startMs: 1000 }, metric: 'tokens' });
        const bindings = Object.fromEntries(builtin.inputs!.fields.map(field => [field.path,
            { kind: 'value', value: StrictJsonValueSchema.parse(readInputPath(query, field.path)) }]));
        sourceItem = SessionSurfaceItemV1Schema.parse({ v: 1, title: 'Daily usage', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'widget', instance: { v: 1, id: 'source-item', definition: builtin.definition, bindings, networkOverride: { network: 'none' } } } });
        const promoted = await executor.execute('widgets.definition.saveFromSession', { account, session: { serverId: account.serverId, sessionId: 'source-session' },
            itemId: 'source-item', artifactId: '43a66c6b-7737-4525-8f3b-757e0cd82a90' }, { ...context, bypassApprovals: true });
        expect(promoted).toMatchObject({ ok: true, result: { definition: { id: '43a66c6b-7737-4525-8f3b-757e0cd82a90', body: builtin.definition,
            inputs: builtin.inputs, inputSchema: builtin.inputSchema, sizeDeclaration: builtin.sizeDeclaration, networkOverride: { network: 'none' } }, suggestedBindings: bindings } });
        const saved = await widgetDefinitionArtifacts.get('43a66c6b-7737-4525-8f3b-757e0cd82a90');
        expect(saved?.body).toEqual(builtin.definition);
        expect(await widgetDefinitionArtifacts.list()).toEqual(expect.arrayContaining([expect.objectContaining({ artifactId: '43a66c6b-7737-4525-8f3b-757e0cd82a90', bodyKind: 'builtin' })]));
        for (const surface of [home, project]) {
            const instance = { v: 1, id: `saved-builtin-${surface.owner.kind}`, definition: { kind: 'artifact', artifactId: '43a66c6b-7737-4525-8f3b-757e0cd82a90' }, bindings };
            expect(await executor.execute('widgets.item.add', { surface, instance }, context)).toMatchObject({ ok: true,
                result: { instance: { ...instance, networkOverride: { network: 'none' } } } });
        }
        sourceItem = SessionSurfaceItemV1Schema.parse({ v: 1, title: saved!.name, frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'widget', instance: { v: 1, id: 'source-item', definition: { kind: 'inline', definition: saved }, bindings,
                networkOverride: { network: 'open' } } } });
        expect(await executor.execute('widgets.definition.saveFromSession', { account, session: { serverId: account.serverId, sessionId: 'source-session' },
            itemId: 'source-item', artifactId: 'eb8a4343-41ed-4b86-894a-fdf7844fa468' }, { ...context, bypassApprovals: true })).toMatchObject({ ok: true,
                result: { definition: { body: builtin.definition, networkOverride: { network: 'open' } }, suggestedBindings: bindings } });
        sourceItem = null;
        expect((await widgetDefinitionArtifacts.get('43a66c6b-7737-4525-8f3b-757e0cd82a90'))?.networkOverride).toEqual({ network: 'none' });
        const sessionBuiltin = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'session_summary' })!;
        sourceItem = SessionSurfaceItemV1Schema.parse({ v: 1, title: 'Summary', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'widget', instance: { v: 1, id: 'source-item', definition: sessionBuiltin.definition,
                bindings: { session: { kind: 'value', value: { serverId: account.serverId, sessionId: 'source-session' } } } } } });
        expect(await executor.execute('widgets.definition.saveFromSession', { account, session: { serverId: account.serverId, sessionId: 'source-session' },
            itemId: 'source-item', artifactId: 'ab7c00c1-8e6f-44cd-8c2d-0137679cfd99' }, { ...context, bypassApprovals: true })).toMatchObject({ ok: true,
                result: { definition: { body: sessionBuiltin.definition, inputs: sessionBuiltin.inputs, sessionInputPath: 'session' },
                    suggestedBindings: { session: { kind: 'context', slot: 'session' } } } });
        if (!saved) throw new Error('Expected saved builtin');
        expect(getArtifactUseTargetV1({ artifactId: saved.id, header: buildWidgetDefinitionArtifactHeaderV1(saved), body: JSON.stringify(saved) }))
            .toMatchObject({ canShare: true, publicLinkAllowed: true });
        // Unknown executable identities and extra body authority are refused at the real write Action, before persistence.
        for (const body of [{ kind: 'builtin', id: 'unknown-widget' }, { kind: 'builtin', id: 'usage_daily', resource: 'author' }]) {
            expect(await executor.execute('widgets.definition.create', { account, artifactId: '22d3fb99-f1d8-4ee2-8a21-ea7dd848b6c2',
                definition: { name: draft.name, sizeDeclaration: draft.sizeDeclaration, inputs: draft.inputs, inputSchema: draft.inputSchema, body } }, context))
                .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        }
        expect(await widgetDefinitionArtifacts.get('22d3fb99-f1d8-4ee2-8a21-ea7dd848b6c2')).toBeNull();
    });
    it('resolves the existing purpose selection and freezes only viewer intent, rejecting private caller override input', async () => {
        const consumer = { pluginId: 'acme.metrics', localId: 'metrics' };
        const selected = { service: { pluginId: consumer.pluginId, localId: 'cloud' }, accountId: 'mine' };
        const profile = AccountProfileSchema.parse({ id: 'viewer', connectedAccountsV4: [{ ref: selected, status: 'connected', authenticationModeId: 'token',
            configurationReady: true, configurationRevision: null, revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [] }] });
        const descriptor: WidgetInputDescriptorV1 & { resources: typeof consumer[] } = {
            resources: [consumer], connectedAccountPurposeBindings: [{ path: 'connection', purpose: 'read', consumer }],
            inputs: { fields: [{ path: 'connection', title: 'Connection', widget: 'select', connectedAccountOptions: true }] },
            inputSchema: { type: 'object', properties: { connection: { type: 'object', properties: {
                service: { type: 'object', properties: { pluginId: { type: 'string' }, localId: { type: 'string' } }, required: ['pluginId', 'localId'], additionalProperties: false },
                accountId: { type: 'string' } }, required: ['service', 'accountId'], additionalProperties: false } }, additionalProperties: false },
        };
        const selection = (instance: Parameters<typeof resolveWidgetViewerPurposeValuesV1>[0]['instance']) => resolveWidgetViewerPurposeValuesV1({
            instance, descriptor, profile, purposeBindings: { v: 1, bindings: [{ purpose: { consumer, purpose: 'read' }, target: { kind: 'account', account: selected } }] },
            resources: [{ id: consumer.localId, pluginId: consumer.pluginId, resourceKind: 'config', scope: 'global', connectedAccountPurposes: [{ purpose: 'read', serviceRefs: [selected.service] }] }], now: 1,
        });
        const widgetInputs = createWidgetActionInputResolverV1({ readDescriptor: async () => descriptor, readContext: async () => ({}),
            readViewerValues: async request => selection(request.instance),
            validateValue: async (field, value, request) => {
                const own = selection(request.instance).values[field.path];
                return own && sameQualifiedConnectedAccountRef(own, value as typeof selected)
                    ? { status: 'valid' } : { status: 'denied', reasonCode: 'widgets_viewer_selection_unavailable' };
            },
            // The host credential-picker boundary is unavailable; admitted purpose defaults must not depend on it.
            resolveOptions: async () => ({ status: 'unavailable', reasonCode: 'credential_picker_unavailable' }),
        });
        let pending: ApprovalRequest | undefined;
        // Approval persistence is the external boundary. The executor and all widget admission logic remain real.
        const deps = { widgetInputs, widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }),
            approvalsCreate: async ({ request }: { request: ApprovalRequest }) => { pending = request; return { artifactId: 'approval' }; },
            isApprovalExecutionOriginCurrent: async () => true,
        } as unknown as ActionExecutorDeps;
        const instance = { v: 1 as const, id: 'copy', definition: { kind: 'installed' as const, surface: { pluginId: consumer.pluginId, localId: 'widget' } },
            bindings: { connection: { kind: 'viewer' as const, purpose: 'read' } } };
        const surface = { serverId: 'home', accountId: 'viewer', owner: { kind: 'sessionBoard' as const, sessionId: 'shared' } };
        const ref = { surface, instanceId: instance.id };
        expect(await widgetInputs.resolve({ ref, instance, context: {} })).toEqual({ status: 'ready', input: { connection: selected } });
        const executor = createActionExecutor(deps);
        const context = { surface: 'agent' as const, authority: 'account_automation' as const, actionCaller: { kind: 'host' as const },
            serverId: 'home', defaultSessionId: 'shared', actionRequestId: 'publish-widget',
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'widgets.item.add': { approvalRequiredSurfaces: ['agent'] } } }) };
        expect(await executor.execute('widgets.item.add', { surface, instance, placement: {} }, context))
            .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'approval' } });
        expect(pending).toMatchObject({ actionArgs: { instance } });
        expect(pending?.actionArgs).not.toHaveProperty('viewerValues');
        expect(JSON.stringify(pending?.actionArgs)).not.toContain('mine');
        pending = undefined;
        expect(await executor.execute('widgets.item.add', { surface, instance, viewerValues: { connection: { ...selected, accountId: 'other' } }, placement: {} }, context))
            .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(pending).toBeUndefined();
    });
});
