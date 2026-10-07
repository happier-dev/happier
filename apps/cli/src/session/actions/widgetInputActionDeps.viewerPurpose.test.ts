import { describe, expect, it } from 'vitest';
import { AccountProfileSchema, ConnectedAccountUiProjectionEntryV1Schema, PluginUiViewV2Schema, type QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCliWidgetInputActionDepsV1 } from './widgetInputActionDeps';

describe('CLI widget existing viewer purpose selection', () => {
    it('follows exact native owner B context while an explicit C pin still selects current C metadata', async () => {
        const identity = { pluginId: 'acme.exact-target', localId: 'widget' };
        const descriptor = (sessionId: string) => ({ surface: identity, availability: 'available' as const, sessionInputPath: 'session',
            sizeDeclaration: { sizes: [sessionId === 'B' ? 'tall' : 'full'], defaultSize: sessionId === 'B' ? 'tall' : 'full' } satisfies import('@happier-dev/protocol/widgets').WidgetSizeDeclarationV1,
            inputs: { fields: [{ path: 'session', title: 'Session', widget: 'json' as const }] },
            inputSchema: { type: 'object' as const, properties: { session: { type: 'object' as const } }, additionalProperties: false } });
        const deps = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId: 'account', getDeps: createUnavailableActionTransportDeps,
            readCandidates: async (_signal, session) => session ? [descriptor(session.sessionId)] : [], validateSession: async () => true });
        const request = { ref: { surface: { serverId: 'home', accountId: 'account', owner: { kind: 'sessionBoard' as const, sessionId: 'B' } }, instanceId: 'copy' },
            instance: { v: 1 as const, id: 'copy', definition: { kind: 'installed' as const, surface: identity },
                bindings: { session: { kind: 'context' as const, slot: 'session' } } }, context: { surface: 'cli' as const } };
        expect(await deps.widgetInputs!.resolve(request)).toMatchObject({ status: 'ready', input: { session: { serverId: 'home', sessionId: 'B' } } });
        expect(await deps.widgetInputs!.readSizeDeclaration(request)).toEqual({ sizes: ['tall'], defaultSize: 'tall' });
        expect(await deps.widgetInputs!.readSizeDeclaration({ ...request, instance: { ...request.instance,
            bindings: { session: { kind: 'value', value: { serverId: 'home', sessionId: 'C' } } } } })).toEqual({ sizes: ['full'], defaultSize: 'full' });
    });
    it('discovers only the exact declared pinned Session for a B-only widget and refuses wrong-path or competing pins', async () => {
        const surface = { serverId: 'home', accountId: 'account', owner: { kind: 'sessionBoard' as const, sessionId: 'A' } };
        const identity = { pluginId: 'acme.b-only', localId: 'widget' };
        const descriptor = (path: string) => ({ surface: identity, availability: 'available' as const, sessionInputPath: path,
            sizeDeclaration: { sizes: ['tall'], defaultSize: 'tall' } satisfies import('@happier-dev/protocol/widgets').WidgetSizeDeclarationV1,
            inputs: { fields: [{ path, title: 'Session', widget: 'select' as const }] },
            inputSchema: { type: 'object' as const, properties: { [path]: { type: 'object' as const } }, required: [path], additionalProperties: false } });
        const deps = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId: 'account', getDeps: createUnavailableActionTransportDeps,
            readCandidates: async (_signal, session) => session?.sessionId === 'B' ? [descriptor('session')]
                : session?.sessionId === 'C' ? [descriptor('other')] : [], validateSession: async session => ['B', 'C'].includes(session.sessionId) });
        const request = { ref: { surface, instanceId: 'copy' }, instance: { v: 1 as const, id: 'copy',
            definition: { kind: 'installed' as const, surface: identity }, bindings: { session: { kind: 'value' as const, value: { serverId: 'home', sessionId: 'B' } } } },
            context: { surface: 'cli' as const } };
        expect(await deps.widgetInputs!.resolve(request)).toMatchObject({ status: 'ready', input: { session: { serverId: 'home', sessionId: 'B' } } });
        expect(await deps.widgetInputs!.readSizeDeclaration(request)).toEqual({ sizes: ['tall'], defaultSize: 'tall' });
        expect(await deps.widgetInputs!.readSizeDeclaration({ ...request, instance: { ...request.instance, bindings: { wrong: request.instance.bindings.session } } })).toBeNull();
        expect(await deps.widgetInputs!.readSizeDeclaration({ ...request, instance: { ...request.instance, bindings: {
            ...request.instance.bindings, other: { kind: 'value', value: { serverId: 'home', sessionId: 'C' } } } } })).toBeNull();
    });
    it('resolves each authenticated principal own current selection and clears missing or revoked selections', async () => {
        const surface = { pluginId: 'acme.metrics', localId: 'widget' };
        const consumer = { pluginId: surface.pluginId, localId: 'metrics' };
        const service = { pluginId: surface.pluginId, localId: 'cloud' };
        const candidate = { surface, sizeDeclaration: { sizes: ['medium', 'full'], defaultSize: 'medium' } satisfies import('@happier-dev/protocol/widgets').WidgetSizeDeclarationV1, availability: 'available' as const, resources: [consumer],
            connectedAccountDescriptors: [ConnectedAccountUiProjectionEntryV1Schema.parse({ id: service.localId, pluginId: service.pluginId, serviceId: service.localId,
                provenance: 'external', sourceKind: 'installed', title: 'Cloud', capabilities: [], diagnostics: [], availability: { state: 'available', reason: 'resolved' },
                authentication: { defaultModeId: 'token', modes: [{ id: 'token', kind: 'oauthDeviceCode', outcomeReconciliation: 'none' }] } })],
            resourceDeclarations: [{ id: consumer.localId, pluginId: consumer.pluginId, resourceKind: 'config' as const, scope: 'global' as const,
                connectedAccountPurposes: [{ purpose: 'read', serviceRefs: [service] }] }],
            connectedAccountPurposeBindings: [{ path: 'connection', purpose: 'read', consumer }],
            inputs: { fields: [{ path: 'connection', title: 'Connection', widget: 'select' as const, connectedAccountOptions: true as const }] },
            inputSchema: { type: 'object' as const, properties: { connection: { type: 'object' as const, properties: {
                service: { type: 'object' as const, properties: { pluginId: { type: 'string' as const }, localId: { type: 'string' as const } }, required: ['pluginId', 'localId'], additionalProperties: false },
                accountId: { type: 'string' as const } }, required: ['service', 'accountId'], additionalProperties: false } }, additionalProperties: false } };
        const admitted = PluginUiViewV2Schema.parse({ sizeDeclaration: candidate.sizeDeclaration, id: surface.localId, renderer: 'native', container: 'widget', target: { kind: 'app' },
            inputs: candidate.inputs, inputSchema: candidate.inputSchema, resources: candidate.resources,
            connectedAccountPurposeBindings: candidate.connectedAccountPurposeBindings });
        expect(admitted).toMatchObject({ inputs: candidate.inputs, inputSchema: candidate.inputSchema });
        const principal = (accountId: string) => {
            const selected = { service, accountId: `${accountId}-connection` };
            let profile = AccountProfileSchema.parse({ id: accountId, connectedAccountsV4: [{ ref: selected, status: 'connected', authenticationModeId: 'token',
                configurationReady: true, configurationRevision: null, revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [] }] });
            let purposeBindings: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [{ purpose: { consumer, purpose: 'read' }, target: { kind: 'account', account: selected } }] };
            let retired = false;
            const deps = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId,
                // Catalog metadata is a transport boundary; declaration admission and all option eligibility remain real.
                getDeps: () => ({ ...createUnavailableActionTransportDeps(), ...deps,
                    widgetAccountScope: () => ({ serverId: 'home', accountId }),
                    widgetCatalog: { list: async () => [{ definition: { kind: 'installed', surface }, title: 'Metrics',
                        fields: candidate.inputs.fields, sizeDeclaration: candidate.sizeDeclaration, availability: 'available', instanceCount: 0 }] },
                }), readCandidates: async () => [{ ...candidate,
                    resourceDeclarations: retired ? [] : candidate.resourceDeclarations }], validateSession: async () => true,
                // Authenticated profile/settings transport is the boundary; purpose admission and binding remain real.
                readViewerPurposeContext: async () => ({ profile, purposeBindings }),
            });
            const request = { ref: { surface: { serverId: 'home', accountId, owner: { kind: 'home' as const } }, instanceId: 'copy' },
                instance: { v: 1 as const, id: 'copy', definition: { kind: 'installed' as const, surface }, bindings: { connection: { kind: 'viewer' as const, purpose: 'read' } } }, context: { surface: 'cli' as const } };
            return { selected, request, resolve: () => deps.widgetInputs!.resolve(request),
                pin: (value: typeof selected, shared = false) => deps.widgetInputs!.resolve({ ...request,
                    ref: { ...request.ref, surface: { ...request.ref.surface, owner: shared ? { kind: 'sessionBoard', sessionId: 'shared' } : request.ref.surface.owner } },
                    instance: { ...request.instance, bindings: { connection: { kind: 'value', value } } }, admission: 'configuration' }),
                unrelatedService: () => {
                    const other = { service: { ...service, localId: 'other-cloud' }, accountId: selected.accountId };
                    profile = AccountProfileSchema.parse({ ...profile, connectedAccountsV4: [...profile.connectedAccountsV4,
                        { ...profile.connectedAccountsV4[0], ref: other }] });
                    return other;
                },
                revoke: () => { profile = AccountProfileSchema.parse({ ...profile, connectedAccountsV4: [{ ...profile.connectedAccountsV4[0], status: 'needs_reauth' }] }); },
                clear: () => { purposeBindings = { v: 1, bindings: [] }; },
                retire: () => { retired = true; },
                retireAccount: () => { profile = AccountProfileSchema.parse({ ...profile, id: 'retired-account' }); },
                group: () => {
                    profile = AccountProfileSchema.parse({ ...profile, connectedAccountGroupsV4: [{ v: 1, ref: { service, groupId: 'default' },
                        incarnation: 'viewer-group', displayName: 'Default', policy: {}, activeConnectedAccountId: selected.accountId, generation: 1, runtimeStateRevision: 1,
                        state: {}, createdAt: 1, updatedAt: 1, members: [{ v: 1, connectedAccountId: selected.accountId, priority: 1, enabled: true, state: {}, createdAt: 1, updatedAt: 1 }] }] });
                    purposeBindings = { v: 1, bindings: [{ purpose: { consumer, purpose: 'read' }, target: { kind: 'group', service, groupId: 'default' } }] };
                },
                draft: (value: typeof selected) => {
                    const staleCaller = { ...request, viewerValues: { connection: value } };
                    return deps.widgetInputs!.resolve(staleCaller);
                },
            };
        };
        const a = principal('A'); const b = principal('B');
        expect(await a.resolve()).toEqual({ status: 'ready', input: { connection: a.selected } });
        expect(await b.resolve()).toEqual({ status: 'ready', input: { connection: b.selected } });
        expect(await b.pin(b.selected)).toEqual({ status: 'ready', input: { connection: b.selected } });
        expect(await b.pin(b.selected, true)).toMatchObject({ status: 'denied' });
        expect(await b.pin(a.selected)).toMatchObject({ status: 'denied' });
        expect(await b.pin(b.unrelatedService())).toMatchObject({ status: 'invalid', fields: [{ reasonCode: 'widget_input_option_unavailable' }] });
        expect(await b.draft(a.selected)).toEqual({ status: 'ready', input: { connection: b.selected } });
        b.group(); expect(await b.resolve()).toEqual({ status: 'ready', input: { connection: b.selected } });
        b.revoke(); expect(await b.resolve()).toMatchObject({ status: 'selection_required', fields: [{ reasonCode: 'widget_viewer_connection_missing' }] });
        expect(await b.pin(b.selected)).toMatchObject({ status: 'denied' });
        expect(await a.resolve()).toEqual({ status: 'ready', input: { connection: a.selected } });
        a.clear(); expect(await a.resolve()).toMatchObject({ status: 'selection_required', fields: [{ reasonCode: 'widget_viewer_connection_missing' }] });
        expect(await a.pin(a.selected)).toEqual({ status: 'ready', input: { connection: a.selected } });
        expect(await a.draft(b.selected)).toMatchObject({ status: 'selection_required', fields: [{ reasonCode: 'widget_viewer_connection_missing' }] });
        b.retire(); expect(await b.resolve()).toMatchObject({ status: 'unavailable', fields: [{ reasonCode: 'widget_viewer_purpose_undeclared' }] });
        a.retireAccount();
        expect(await a.resolve()).toMatchObject({ status: 'selection_required' });
        expect(await a.pin(a.selected)).toMatchObject({ status: 'denied' });
    });
});
