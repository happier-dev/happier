import { describe, expect, it } from 'vitest';
import { createWidgetActionInputResolverV1 } from './widgetActionInputResolverV1.js';
import type { WidgetInstanceRefV1, WidgetInstanceV1 } from './widgetInstanceV1.js';
import { AccountProfileSchema } from '../account/profile.js';
import { resolveWidgetViewerPurposeValuesV1 } from './widgetViewerPurposeV1.js';
import type { WidgetInputDescriptorV1 } from './widgetInputAdmissionV1.js';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '../connect/connectedAccountPurposeBindings.js';

const consumer = { pluginId: 'acme.metrics', localId: 'metrics' };
const service = { pluginId: consumer.pluginId, localId: 'cloud' };
const viewerDescriptor: WidgetInputDescriptorV1 & { resources: typeof consumer[] } = {
    resources: [consumer], connectedAccountPurposeBindings: [{ path: 'connection', purpose: 'read', consumer }],
    inputs: { fields: [{ path: 'connection', title: 'Connection', widget: 'select', required: true, connectedAccountOptions: true },
        { path: 'choice', title: 'Choice', widget: 'select', required: true, optionsSourceId: 'choices' }] },
    inputSchema: { type: 'object', properties: {
        connection: { type: 'object', properties: {
            service: { type: 'object', properties: { pluginId: { type: 'string' }, localId: { type: 'string' } },
                required: ['pluginId', 'localId'], additionalProperties: false },
            accountId: { type: 'string' } }, required: ['service', 'accountId'], additionalProperties: false },
        choice: { type: 'string', minLength: 2 },
    }, required: ['connection', 'choice'], additionalProperties: false },
};

function createUnconnectedViewerWidgetResolver() {
    let descriptor = viewerDescriptor;
    let profile = AccountProfileSchema.parse({ id: 'viewer' });
    let purposeBindings: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [] };
    let resources = [{ id: consumer.localId, pluginId: consumer.pluginId, resourceKind: 'config' as const, scope: 'global' as const,
        connectedAccountPurposes: [{ purpose: 'read', serviceRefs: [service] }] }];
    const resolver = createWidgetActionInputResolverV1({
        readDescriptor: async () => descriptor, readContext: async () => ({}),
        readViewerValues: async request => resolveWidgetViewerPurposeValuesV1({ instance: request.instance, descriptor,
            profile, purposeBindings, resources, now: 1 }),
        validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [{ value: 'current' }, { value: 'x' }],
    });
    return { resolver, setDescriptor: (value: typeof descriptor) => { descriptor = value; }, removeResource: () => { resources = []; },
        connect: (accountId: string) => {
            const selected = { service, accountId };
            profile = AccountProfileSchema.parse({ id: 'viewer', connectedAccountsV4: [{ ref: selected, status: 'connected', authenticationModeId: 'token',
                configurationReady: true, configurationRevision: null, revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [] }] });
            purposeBindings = { v: 1, bindings: [{ purpose: { consumer, purpose: 'read' }, target: { kind: 'account', account: selected } }] };
            return selected;
        } };
}

describe('current Widget field options admission', () => {
    it('admits declared viewer intent without a connection only for configuration, preserving execution and other value admission', async () => {
        const { resolver, removeResource, setDescriptor } = createUnconnectedViewerWidgetResolver();
        const request = { ref: { surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'sessionBoard' as const, sessionId: 'shared' } }, instanceId: 'copy' },
            instance: { v: 1 as const, id: 'copy', definition: { kind: 'installed' as const, surface: { pluginId: consumer.pluginId, localId: 'widget' } },
                bindings: { connection: { kind: 'viewer' as const, purpose: 'read' }, choice: { kind: 'value' as const, value: 'current' } } }, context: {} };
        expect(await resolver.resolve({ ...request, admission: 'configuration' })).toEqual({ status: 'ready', input: { choice: 'current' } });
        expect(await resolver.resolve(request)).toMatchObject({ status: 'selection_required', fields: [{ path: 'connection', reasonCode: 'widget_viewer_connection_missing' }] });
        expect(await resolver.resolve({ ...request, admission: 'configuration', instance: { ...request.instance,
            bindings: { ...request.instance.bindings, choice: { kind: 'value', value: 'stale' } } } }))
            .toMatchObject({ status: 'invalid', fields: [{ path: 'choice', reasonCode: 'widget_input_option_unavailable' }] });
        expect(await resolver.resolve({ ...request, admission: 'configuration', instance: { ...request.instance,
            bindings: { ...request.instance.bindings, choice: { kind: 'value', value: 'x' } } } }))
            .toMatchObject({ status: 'invalid', fields: expect.arrayContaining([{ path: 'choice', status: 'invalid', reasonCode: 'widget_input_schema_invalid' }]) });
        expect(await resolver.resolve({ ...request, admission: 'configuration', instance: { ...request.instance,
            bindings: { ...request.instance.bindings, connection: { kind: 'viewer', purpose: 'forged' } } } }))
            .toMatchObject({ status: 'unavailable', fields: [{ path: 'connection', reasonCode: 'widget_viewer_purpose_undeclared' }] });
        setDescriptor({ ...viewerDescriptor, inputSchema: { ...viewerDescriptor.inputSchema!, properties: {
            ...viewerDescriptor.inputSchema!.properties, connection: { type: 'string' },
        } } });
        expect(await resolver.resolve({ ...request, admission: 'configuration' }))
            .toMatchObject({ status: 'unavailable', fields: [{ path: 'connection', reasonCode: 'widget_viewer_purpose_undeclared' }] });
        setDescriptor(viewerDescriptor);
        removeResource();
        expect(await resolver.resolve({ ...request, admission: 'configuration' }))
            .toMatchObject({ status: 'unavailable', fields: [{ path: 'connection', reasonCode: 'widget_viewer_purpose_undeclared' }] });
    });
    it('defers nested viewer leaves across schema arms without exempting their required siblings', async () => {
        const { resolver, setDescriptor } = createUnconnectedViewerWidgetResolver();
        const connectionSchema = viewerDescriptor.inputSchema!.properties!.connection!;
        const arm = (choice: string) => ({ type: 'object' as const, properties: {
            credentials: { type: 'object' as const, properties: { connection: connectionSchema }, required: ['connection'], additionalProperties: false },
            choice: { type: 'string' as const, const: choice },
        }, required: ['credentials', 'choice'], additionalProperties: false });
        const descriptor = { ...viewerDescriptor, connectedAccountPurposeBindings: [{ path: 'credentials.connection', purpose: 'read', consumer }],
            inputs: { fields: viewerDescriptor.inputs!.fields.map(field => field.path === 'connection' ? { ...field, path: 'credentials.connection' } : field) },
            inputSchema: { oneOf: [arm('current'), arm('other')] } };
        setDescriptor(descriptor);
        const request = { ref: { surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'sessionBoard' as const, sessionId: 'shared' } }, instanceId: 'copy' },
            instance: { v: 1 as const, id: 'copy', definition: { kind: 'installed' as const, surface: { pluginId: consumer.pluginId, localId: 'widget' } },
                bindings: { 'credentials.connection': { kind: 'viewer' as const, purpose: 'read' }, choice: { kind: 'value' as const, value: 'current' } } },
            context: {}, admission: 'configuration' as const };
        expect(await resolver.resolve(request)).toEqual({ status: 'ready', input: { choice: 'current' } });
        setDescriptor({ ...descriptor, inputSchema: { ...arm('current'), properties: { ...arm('current').properties,
            credentials: { type: 'object', properties: { connection: connectionSchema, region: { type: 'string' } }, required: ['connection', 'region'], additionalProperties: false },
        } } });
        expect(await resolver.resolve(request)).toMatchObject({ status: 'invalid', fields: expect.arrayContaining([
            { path: 'choice', status: 'invalid', reasonCode: 'widget_input_schema_invalid' },
        ]) });
    });
    it('does not treat empty host purpose facts as admission of a Resource declaration', async () => {
        const resolver = createWidgetActionInputResolverV1({
            readDescriptor: async () => viewerDescriptor, readContext: async () => ({}),
            // A host with no available current-viewer profile cannot produce purpose-authority facts.
            readViewerValues: async () => ({ values: {} }), validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [{ value: 'current' }],
        });
        expect(await resolver.resolve({ ref: { surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' } }, instanceId: 'copy' },
            instance: { v: 1, id: 'copy', definition: { kind: 'installed', surface: { pluginId: consumer.pluginId, localId: 'widget' } },
                bindings: { connection: { kind: 'viewer', purpose: 'read' }, choice: { kind: 'value', value: 'current' } } }, context: {}, admission: 'configuration' }))
            .toMatchObject({ status: 'unavailable', fields: [{ path: 'connection', reasonCode: 'widget_viewer_purpose_authority_unavailable' }] });
    });
    it('can save viewer intent when exclusive schema arms distinguish future viewer values', async () => {
        const { resolver, setDescriptor, connect } = createUnconnectedViewerWidgetResolver();
        const inputSchema = { oneOf: ['first', 'second'].map(accountId => ({ ...viewerDescriptor.inputSchema!,
            allOf: [{ properties: { connection: { properties: { accountId: { const: accountId } } } } }],
        })) };
        setDescriptor({ ...viewerDescriptor, inputSchema });
        const request = { ref: { surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'sessionBoard' as const, sessionId: 'shared' } }, instanceId: 'copy' },
            instance: { v: 1 as const, id: 'copy', definition: { kind: 'installed' as const, surface: { pluginId: consumer.pluginId, localId: 'widget' } },
                bindings: { connection: { kind: 'viewer' as const, purpose: 'read' }, choice: { kind: 'value' as const, value: 'current' } } },
            context: {}, admission: 'configuration' as const };
        expect(await resolver.resolve(request)).toEqual({ status: 'ready', input: { choice: 'current' } });
        expect(await resolver.resolve({ ...request, instance: { ...request.instance, bindings: { ...request.instance.bindings, choice: { kind: 'value', value: 'x' } } } }))
            .toMatchObject({ status: 'invalid', fields: expect.arrayContaining([{ path: 'choice', status: 'invalid', reasonCode: 'widget_input_schema_invalid' }]) });
        const selected = connect('first');
        expect(await resolver.resolve({ ...request, admission: 'execution' })).toEqual({ status: 'ready', input: { connection: selected, choice: 'current' } });
        connect('outside');
        expect(await resolver.resolve({ ...request, admission: 'execution' })).toMatchObject({ status: 'invalid', fields: expect.arrayContaining([
            { path: 'connection', status: 'invalid', reasonCode: 'widget_input_schema_invalid' },
        ]) });
        setDescriptor({ ...viewerDescriptor, inputSchema: { ...viewerDescriptor.inputSchema!, oneOf: [
            { properties: { choice: { const: 'current' } } }, { properties: { choice: { minLength: 7 } } },
        ] } });
        // This union is about a saved literal, so its exclusive contract still rejects overlapping arms.
        expect(await resolver.resolve(request)).toMatchObject({ status: 'invalid', fields: expect.arrayContaining([
            { path: 'choice', status: 'invalid', reasonCode: 'widget_input_schema_invalid' },
        ]) });
    });
    it('rechecks a personal connection pin against current options even during configuration', async () => {
        const pin = { service: { pluginId: 'com.acme', localId: 'cloud' }, accountId: 'mine' };
        let available = true;
        const resolver = createWidgetActionInputResolverV1({
            readDescriptor: async () => ({ inputs: { fields: [{ path: 'connection', title: 'Connection', widget: 'select', connectedAccountOptions: true }] } }),
            readContext: async () => ({}), readViewerValues: async () => ({ values: {} }),
            validateValue: async () => ({ status: 'valid' }),
            // The host's current inventory is the boundary; configuration uses the real option admission owner.
            resolveOptions: async () => available ? [{ value: pin }] : [],
        });
        const request = { ref: { surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } }, instanceId: 'copy' },
            instance: { v: 1 as const, id: 'copy', definition: { kind: 'installed' as const, surface: { pluginId: 'com.acme', localId: 'widget' } },
                bindings: { connection: { kind: 'value' as const, value: pin } } }, context: {}, admission: 'configuration' as const };
        expect(await resolver.resolve(request)).toEqual({ status: 'ready', input: { connection: pin } });
        available = false;
        expect(await resolver.resolve(request)).toMatchObject({ status: 'invalid', fields: [{ reasonCode: 'widget_input_option_unavailable' }] });
    });
    it('validates typed pins even when a picker declares no options Resource', async () => {
        const inputType = { pluginId: 'com.acme.inputs', localId: 'repository' };
        const ports = {
            readDescriptor: async () => ({ inputs: { fields: [{ path: 'repository', title: 'Repository', widget: 'select' as const, inputType }] } }),
            readContext: async () => ({}), readViewerValues: async () => ({ values: {} }),
            validateValue: async () => ({ status: 'valid' as const }),
            resolveOptions: async () => [],
            readInputType: async () => ({ identity: inputType, occurrenceId: 'current', definition: {
                id: inputType.localId, title: 'Repository', semantic: 'repository', valueSchema: { type: 'object' as const,
                    properties: { repositoryId: { type: 'string' as const } }, required: ['repositoryId'], additionalProperties: false },
            } }),
        };
        const resolver = createWidgetActionInputResolverV1(ports);
        const request = { ref: { surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } }, instanceId: 'copy' },
            instance: { v: 1 as const, id: 'copy', definition: { kind: 'installed' as const, surface: { pluginId: 'com.acme', localId: 'widget' } },
                bindings: { repository: { kind: 'value' as const, value: { repositoryId: 42 } } } }, context: {} };
        expect(await resolver.resolve(request)).toMatchObject({ status: 'invalid', fields: [{ path: 'repository', reasonCode: 'input_type_value_invalid' }] });
        expect(await resolver.resolve({ ...request, instance: { ...request.instance,
            bindings: { repository: { kind: 'value', value: { repositoryId: 'repo' } } } } }))
            .toEqual({ status: 'ready', input: { repository: { repositoryId: 'repo' } } });
    });
    it('defers viewer values even when connected while still validating unrelated dynamic values', async () => {
        const selected = { service: { pluginId: 'acme.metrics', localId: 'cloud' }, accountId: 'mine' };
        const resolver = createWidgetActionInputResolverV1({
            readDescriptor: async () => ({ ...viewerDescriptor, connectedAccountPurposeBindings: [{ path: 'connection', purpose: 'metrics', consumer }] }),
            readContext: async () => ({}), readViewerValues: async () => ({ values: { connection: selected } }),
            validateValue: async (field, _value, request) => field.path === 'connection' && request.admission !== 'configuration'
                ? { status: 'unavailable', reasonCode: 'widget_viewer_purpose_authority_unavailable' } : { status: 'valid' },
            // A private metadata choice has no credential options source. The other source is real current admission.
            resolveOptions: async field => field.path === 'connection'
                ? { status: 'unavailable', reasonCode: 'credential_picker_unavailable' } : [{ value: 'current' }],
        });
        const request = { ref: { surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } }, instanceId: 'copy' },
            instance: { v: 1 as const, id: 'copy', definition: { kind: 'installed' as const, surface: { pluginId: 'acme.metrics', localId: 'widget' } },
                bindings: { connection: { kind: 'viewer' as const, purpose: 'metrics' }, choice: { kind: 'value' as const, value: 'stale' } } }, context: {} };
        expect(await resolver.resolve({ ...request, admission: 'configuration' })).toEqual({ status: 'invalid',
            fields: [{ path: 'choice', status: 'invalid', reasonCode: 'widget_input_option_unavailable' }] });
        expect(await resolver.resolve({ ...request, instance: { ...request.instance, bindings: { ...request.instance.bindings, choice: { kind: 'value', value: 'current' } } }, admission: 'configuration' }))
            .toEqual({ status: 'ready', input: { choice: 'current' } });
        expect(await resolver.resolve(request)).toMatchObject({ fields: expect.arrayContaining([{ path: 'connection', status: 'unavailable', reasonCode: 'widget_viewer_purpose_authority_unavailable' }]) });
    });
    it('uses only the current viewer purpose selection, never an instance override supplied by a caller', async () => {
        const stored = { service: { pluginId: 'acme.metrics', localId: 'cloud' }, accountId: 'old' };
        const chosen = { ...stored, accountId: 'new' };
        let values: Record<string, typeof stored> = { connection: stored };
        const resolver = createWidgetActionInputResolverV1({
            readDescriptor: async () => ({ inputs: { fields: [{ path: 'connection', title: 'Connection', widget: 'json', required: true }] },
                inputSchema: { type: 'object', properties: { connection: { type: 'object' } }, required: ['connection'], additionalProperties: false } }),
            readContext: async () => ({}), readViewerValues: async () => ({ values }),
            validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [],
        });
        const request = { ref: { surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } }, instanceId: 'copy' },
            instance: { v: 1 as const, id: 'copy', definition: { kind: 'installed' as const, surface: { pluginId: 'acme.metrics', localId: 'widget' } },
                bindings: { connection: { kind: 'viewer' as const, purpose: 'metrics' } } }, context: {} };
        // A stale JavaScript caller may still supply the removed field; it cannot influence authority.
        const overridden = { ...request, viewerValues: { connection: chosen } };
        const cleared = { ...request, viewerValues: {} };
        expect(await resolver.resolve(overridden)).toEqual({ status: 'ready', input: { connection: stored } });
        expect(await resolver.resolve(cleared)).toEqual({ status: 'ready', input: { connection: stored } });
        expect(await resolver.resolve(request)).toEqual({ status: 'ready', input: { connection: stored } });
        values = {};
        expect(await resolver.resolve(overridden))
            .toMatchObject({ status: 'selection_required', fields: [{ path: 'connection', reasonCode: 'widget_viewer_selection_missing' }] });
    });
    it('denies a hidden bound value before exposing executable input', async () => {
        const resolver = createWidgetActionInputResolverV1({
            readDescriptor: async () => ({ inputs: { fields: [
                { path: 'enabled', title: 'Enabled', widget: 'boolean' },
                { path: 'connection', title: 'Connection', widget: 'json', visibleWhen: { op: 'truthy', path: 'enabled' } },
            ] } }),
            readContext: async () => ({}), readViewerValues: async () => ({ values: {} }),
            validateValue: async field => field.path === 'connection'
                ? { status: 'denied', reasonCode: 'connection_access_denied' } : { status: 'valid' },
            resolveOptions: async () => [],
        });
        expect(await resolver.resolve({
            ref: { surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' } }, instanceId: 'copy' },
            instance: { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'checks' }, bindings: {
                enabled: { kind: 'value', value: false }, connection: { kind: 'value', value: { service: { pluginId: 'com.acme', localId: 'cloud' }, accountId: 'revoked' } },
            } }, context: {},
        })).toMatchObject({ status: 'denied', fields: [{ path: 'connection', reasonCode: 'connection_access_denied' }] });
    });
    it('rechecks a structured pin and never rebinds it to an available context candidate', async () => {
        const pin = { serverId: 'home', sessionId: 'B' };
        const alternate = { serverId: 'home', sessionId: 'A' };
        let inventory = [pin, alternate];
        const resolver = createWidgetActionInputResolverV1({
            readDescriptor: async () => ({ inputs: { fields: [{ path: 'enabled', title: 'Enabled', widget: 'boolean' },
                { path: 'session', title: 'Session', widget: 'select', required: true, visibleWhen: { op: 'truthy', path: 'enabled' },
                optionsSourceId: 'sessions' }] }, inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' }, session: { type: 'object',
                    properties: { serverId: { type: 'string' }, sessionId: { type: 'string' } }, required: ['serverId', 'sessionId'], additionalProperties: false } },
                    additionalProperties: false } }),
            readContext: async () => ({ session: [alternate] }),
            readViewerValues: async () => ({ values: {} }),
            validateValue: async () => ({ status: 'valid' }),
            // Current host inventory is the external authority boundary; all binder/schema/options logic stays real.
            resolveOptions: async () => inventory.map(value => ({ value })),
        });
        const ref: WidgetInstanceRefV1 = { surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' } }, instanceId: 'copy' };
        const instance: WidgetInstanceV1 = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'checks' },
            bindings: { enabled: { kind: 'value', value: false }, session: { kind: 'value', value: pin } } };
        expect(await resolver.resolve({ ref, instance: { ...instance, bindings: { enabled: instance.bindings.enabled! } }, context: {} }))
            .toEqual({ status: 'ready', input: { enabled: false } });
        expect(await resolver.resolve({ ref, instance, context: {} })).toEqual({ status: 'ready', input: { enabled: false, session: pin } });
        inventory = [alternate];
        expect(await resolver.resolve({ ref, instance, context: {} })).toMatchObject({ status: 'invalid',
            fields: [{ path: 'session', reasonCode: 'widget_input_option_unavailable' }] });
        expect(instance.bindings.session).toEqual({ kind: 'value', value: pin });
    });
});
