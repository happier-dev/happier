import { describe, expect, it } from 'vitest';
import { AccountProfileSchema, QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol';
import { type WidgetInstanceRefV1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import { admitWidgetViewerSelectionMetadataV1 } from './widgetViewerSelectionAdmission';

describe('Widget viewer selection metadata admission', () => {
    it('admits existing Resource purpose selections and current personal pins', async () => {
        const viewer = { serverId: 'home', accountId: 'viewer' };
        const surface = { pluginId: 'com.acme.metrics', localId: 'widget' };
        const consumer = { pluginId: surface.pluginId, localId: 'metrics' };
        const value = { service: { pluginId: surface.pluginId, localId: 'cloud' }, accountId: 'mine' };
        const instance: WidgetInstanceV1 = { v: 1, id: 'copy', definition: { kind: 'installed', surface }, bindings: { connection: { kind: 'viewer', purpose: 'read' } } };
        const profile = AccountProfileSchema.parse({ id: viewer.accountId, connectedAccountsV4: [{ ref: value, status: 'connected', authenticationModeId: 'token',
            configurationReady: true, configurationRevision: null, revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [] }] });
        const descriptor = { surface, resources: [consumer], connectedAccountPurposeBindings: [{ path: 'connection', purpose: 'read', consumer }],
            inputs: { fields: [{ path: 'connection', title: 'Connection', widget: 'select' as const, connectedAccountOptions: true as const }] },
            inputSchema: { type: 'object' as const, properties: { connection: { type: 'object' as const, properties: { service: { type: 'object' as const,
                properties: { pluginId: { type: 'string' as const }, localId: { type: 'string' as const } }, required: ['pluginId', 'localId'], additionalProperties: false },
                accountId: { type: 'string' as const } }, required: ['service', 'accountId'], additionalProperties: false } }, additionalProperties: false } };
        const admitted = { viewer, ref: { surface: { ...viewer, owner: { kind: 'home' as const } }, instanceId: 'copy' }, instance, descriptor, profile, now: 1,
            purposeBindings: { v: 1 as const, bindings: [{ purpose: { consumer, purpose: 'read' }, target: { kind: 'account' as const, account: value } }] },
            resources: [{ id: consumer.localId, pluginId: consumer.pluginId, resourceKind: 'config' as const, scope: 'global' as const,
                connectedAccountPurposes: [{ purpose: 'read', serviceRefs: [value.service] }] }] };
        expect(admitWidgetViewerSelectionMetadataV1({ ...admitted, values: { connection: value } })).toBeNull();
        expect(admitWidgetViewerSelectionMetadataV1({ ...admitted, values: { connection: { ...value, accountId: 'other-active' } } })).not.toBeNull();
        expect(admitWidgetViewerSelectionMetadataV1({ ...admitted, purposeBindings: { v: 1, bindings: [] }, values: { connection: value } })).not.toBeNull();
        expect(admitWidgetViewerSelectionMetadataV1({ ...admitted, resources: [], values: { connection: value } })).not.toBeNull();
        const pinned = { ...instance, bindings: { connection: { kind: 'value' as const, value } } };
        expect(admitWidgetViewerSelectionMetadataV1({ ...admitted, instance: pinned, purposeBindings: { v: 1, bindings: [] }, values: { connection: value } })).toBeNull();
        expect(admitWidgetViewerSelectionMetadataV1({ ...admitted, instance: pinned,
            values: { connection: { ...value, accountId: 'foreign' } } })).not.toBeNull();
        expect(admitWidgetViewerSelectionMetadataV1({ ...admitted, instance: pinned,
            ref: { ...admitted.ref, surface: { ...admitted.ref.surface, owner: { kind: 'sessionBoard', sessionId: 'shared' } } },
            values: { connection: value } })).not.toBeNull();
        expect(admitWidgetViewerSelectionMetadataV1({ ...admitted, instance: pinned,
            profile: AccountProfileSchema.parse({ ...profile, connectedAccountsV4: [{ ...profile.connectedAccountsV4[0], status: 'needs_reauth' }] }),
            values: { connection: value } })).not.toBeNull();
    });
    it('refuses arbitrary own refs without admitted existing-purpose correlation or current Account scope', async () => {
        const viewer = { serverId: 'home', accountId: 'viewer' };
        const ref: WidgetInstanceRefV1 = { surface: { ...viewer, owner: { kind: 'home' } }, instanceId: 'copy' };
        const surface = { pluginId: 'com.acme.metrics', localId: 'widget' };
        const instance: WidgetInstanceV1 = { v: 1, id: 'copy', definition: { kind: 'installed', surface },
            bindings: { connection: { kind: 'viewer', purpose: 'metrics-read' } } };
        const value = { service: { pluginId: 'com.acme.metrics', localId: 'cloud' }, accountId: 'my-connection' };
        const account = QualifiedConnectedAccountProfileV4Schema.parse({ ref: value, status: 'connected', authenticationModeId: 'token',
            configurationReady: true, configurationRevision: null, revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [] });
        let profile = AccountProfileSchema.parse({ id: viewer.accountId, connectedAccountsV4: [account] });
        const descriptor = { surface, inputs: { fields: [{ path: 'connection', title: 'Connection', widget: 'select' as const, connectedAccountOptions: true as const }] },
            inputSchema: { type: 'object' as const, additionalProperties: false, properties: { connection: { type: 'object' as const, additionalProperties: false,
                required: ['service', 'accountId'], properties: { service: { type: 'object' as const, additionalProperties: false, required: ['pluginId', 'localId'],
                    properties: { pluginId: { type: 'string' as const }, localId: { type: 'string' as const } } }, accountId: { type: 'string' as const } } } } },
            connectedAccountPurposeBindings: [{ path: 'connection', purpose: 'metrics-read', consumer: { pluginId: surface.pluginId, localId: 'metrics' } }] };
        const validate = (values: Readonly<Record<string, typeof value>>, draft = instance) => admitWidgetViewerSelectionMetadataV1({ viewer, ref, instance: draft, descriptor, profile, values, now: 1 });
        expect(validate({ connection: value })).toMatchObject({ ok: false, errorCode: 'widget_viewer_purpose_undeclared' });
        expect(validate({ connection: { ...value, accountId: 'someone-elses' } })).toMatchObject({ ok: false, errorCode: 'widget_viewer_purpose_undeclared' });
        expect(validate({ connection: value }, { ...instance, bindings: { connection: { kind: 'viewer', purpose: 'invented' } } })).toMatchObject({ ok: false, errorCode: 'widgets_viewer_field_invalid' });
        profile = AccountProfileSchema.parse({ ...profile, id: 'other-viewer', connectedAccountsV4: [account] });
        expect(validate({ connection: value })).toMatchObject({ ok: false, errorCode: 'widgets_viewer_scope_mismatch' });
    });
});
