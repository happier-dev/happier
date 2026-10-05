import { describe, expect, it } from 'vitest';
import { AccountProfileSchema } from '../account/profile.js';
import { createActionExecutor, type ActionExecutorDeps } from '../actions/actionExecutor.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { sameQualifiedConnectedAccountRef } from '../connect/qualifiedConnectedAccountPersistence.js';
import { createWidgetActionInputResolverV1 } from './widgetActionInputResolverV1.js';
import { resolveWidgetViewerPurposeValuesV1 } from './widgetViewerPurposeV1.js';
import type { WidgetInputDescriptorV1 } from './widgetInputAdmissionV1.js';

describe('shared widget publication purpose admission', () => {
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
            serverId: 'home', defaultSessionId: 'shared', actionRequestId: 'publish-widget' };
        expect(await executor.execute('widgets.instance.add', { surface, instance, placement: {} }, context))
            .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
        expect(pending).toMatchObject({ actionArgs: { instance } });
        expect(pending?.actionArgs).not.toHaveProperty('viewerValues');
        expect(JSON.stringify(pending?.actionArgs)).not.toContain('mine');
        pending = undefined;
        expect(await executor.execute('widgets.instance.add', { surface, instance, viewerValues: { connection: { ...selected, accountId: 'other' } }, placement: {} }, context))
            .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(pending).toBeUndefined();
    });
});
