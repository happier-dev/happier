import { describe, expect, it } from 'vitest';
import { AccountProfileSchema} from '@happier-dev/protocol/account/profile';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { type WidgetInstanceRefV1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import { admitWidgetViewerSelectionMetadataV1 } from './widgetViewerSelectionAdmission';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import '@/sync/syncEngine';

describe('Widget viewer selection metadata admission', () => {
    it('admits portable layout identity for its current local viewer without borrowing another Home or Account', async () => {
        const serverIdentityId = 'srv_0123456789abcdefghijklmnopqrstuv';
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://widget-viewer-alias.test', serverIdentityId, accountId: 'viewer' });
        try {
            const viewer = { serverId: connection.home.id, accountId: 'viewer' };
            const instance: WidgetInstanceV1 = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'project_about' }, bindings: {} };
            const ref: WidgetInstanceRefV1 = { surface: { serverId: serverIdentityId, accountId: 'owner',
                owner: { kind: 'project', projectId: 'project' }, artifactId: 'attached-layout' }, instanceId: instance.id };
            const input = { viewer, admittedViewer: viewer, ref, instance, descriptor: { definition: instance.definition },
                profile: AccountProfileSchema.parse({ id: viewer.accountId }), values: {}, now: 1 };
            expect(admitWidgetViewerSelectionMetadataV1(input)).toBeNull();
            expect(admitWidgetViewerSelectionMetadataV1({ ...input, admittedViewer: { ...viewer, accountId: 'other' } }))
                .toMatchObject({ ok: false, errorCode: 'widgets_viewer_scope_mismatch' });
            expect(admitWidgetViewerSelectionMetadataV1({ ...input, ref: { ...ref, surface: { ...ref.surface, serverId: 'other-home' } } }))
                .toMatchObject({ ok: false, errorCode: 'widgets_viewer_scope_mismatch' });
            expect(admitWidgetViewerSelectionMetadataV1({ ...input, admittedViewer: undefined,
                ref: { ...ref, surface: { ...ref.surface, accountId: viewer.accountId } } })).toBeNull();
        } finally { await connection.dispose(); }
    });
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
        const shared = { ...admitted.ref, surface: { ...admitted.ref.surface, accountId: 'stored-owner',
            owner: { kind: 'project' as const, projectId: 'stable-project' }, artifactId: 'attached-layout' } };
        expect(admitWidgetViewerSelectionMetadataV1({ ...admitted, ref: shared, values: { connection: value } }))
            .toMatchObject({ ok: false, errorCode: 'widgets_viewer_scope_mismatch' });
        expect(admitWidgetViewerSelectionMetadataV1({ ...admitted, ref: shared, admittedViewer: viewer, values: { connection: value } })).toBeNull();
        expect(admitWidgetViewerSelectionMetadataV1({ ...admitted, ref: shared, admittedViewer: { ...viewer, accountId: 'old-viewer' }, values: { connection: value } }))
            .toMatchObject({ ok: false, errorCode: 'widgets_viewer_scope_mismatch' });
        expect(admitWidgetViewerSelectionMetadataV1({ ...admitted, values: { connection: { ...value, accountId: 'other-active' } } })).not.toBeNull();
        expect(admitWidgetViewerSelectionMetadataV1({ ...admitted, purposeBindings: { v: 1, bindings: [] }, values: { connection: value } })).not.toBeNull();
        expect(admitWidgetViewerSelectionMetadataV1({ ...admitted, resources: [], values: { connection: value } })).not.toBeNull();
        const pinned = { ...instance, bindings: { connection: { kind: 'value' as const, value } } };
        expect(admitWidgetViewerSelectionMetadataV1({ ...admitted, instance: pinned, purposeBindings: { v: 1, bindings: [] }, values: { connection: value } })).toBeNull();
        const retainedPinValue = { ...value, retired: true, service: { ...value.service, retired: true } };
        const retainedPin = { ...pinned, bindings: { connection: { kind: 'value' as const, value: retainedPinValue } } };
        expect(admitWidgetViewerSelectionMetadataV1({ ...admitted, instance: retainedPin,
            purposeBindings: { v: 1, bindings: [] }, values: { connection: value } })).toBeNull();
        expect(admitWidgetViewerSelectionMetadataV1({ ...admitted, instance: retainedPin,
            purposeBindings: { v: 1, bindings: [] }, values: { connection: retainedPinValue } }))
            .toMatchObject({ ok: false, errorCode: 'widgets_viewer_selection_unavailable' });
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
