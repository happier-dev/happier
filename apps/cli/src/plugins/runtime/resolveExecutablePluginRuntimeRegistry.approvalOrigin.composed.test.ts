import axios, { AxiosHeaders, type AxiosResponse } from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountProfileSchema, FeaturesResponseSchema, decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { artifactListResponse, artifactReadResponse } from '@/testkit/http/artifactHome';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';

function response<T>(data: T): AxiosResponse<T> {
    return { data, status: 200, statusText: 'OK', headers: new AxiosHeaders(), config: { headers: new AxiosHeaders() } };
}

afterEach(() => vi.restoreAllMocks());

it('attributes an automation background Action approval to its host Machine through Artifact creation and list projection', async () => {
    const pluginId = 'example.approval-origin';
    const machineId = 'machine-approval-origin';
    const serverIdentityId = 'srv_approval_origin';
    const accountId = 'account-approval-origin';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
        encryption: null, credentialProvenance: 'stored_session' as const };
    const artifacts = new Map<string, { id: string; header: string; body: string; headerVersion: number; bodyVersion: number;
        dataEncryptionKey: string; ownerAccountId: string; access: 'owner'; encryptionMode: 'plain'; seq: number; createdAt: number; updatedAt: number }>();
    // Only Home HTTP is replaced; admission, SDK context, approval policy,
    // serialization, Account encryption mode and Artifact consumers stay real.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
        if (!['/v1/features', '/v1/features/authenticated'].includes(new URL(String(url)).pathname)) throw new Error('Unexpected feature request');
        return new Response(JSON.stringify(FeaturesResponseSchema.parse({ features: {},
            capabilities: { serverIdentity: { serverIdentityId } } })), { status: 200 });
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/profile') return response(AccountProfileSchema.parse({ id: accountId }));
        if (path === '/v1/account/encryption') return response({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') return response({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
        if (path === '/v1/artifacts') return response(artifactListResponse(String(url), [...artifacts.values()]));
        const artifact = artifacts.get(path.split('/').at(-1)!);
        if (artifact) return response(artifact);
        throw new Error(`Unexpected GET ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/artifacts/read') return response(artifactReadResponse(body, id => artifacts.get(id) ?? null).data);
        if (path !== '/v1/artifacts') throw new Error(`Unexpected POST ${path}`);
        const value = body as { id: string; header: string; body: string };
        artifacts.set(value.id, { ...value, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            headerVersion: 1, bodyVersion: 1, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
            seq: 1, createdAt: 1, updatedAt: 1 });
        return response({ id: value.id, headerVersion: 1, bodyVersion: 1 });
    });
    const plugin = definePlugin({ id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
        backgroundServices: [{ declaration: { id: 'automation-observer', title: 'Automation observer' }, runner: async context => {
            await context.services.actions.execute('automation.event.sources.list', { transport: { kind: 'checkpointedPull' } });
        } }],
    });
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: plugin.manifest,
        files: { 'daemon.mjs': 'export function activate() {}' }, instantiateCommittedModule: () => ({ activate: plugin.activate }) }],
        async resolveContributes(happyHomeDir) { return createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })); },
        runtimeOptions: { scopedActionRuntime: { credentials,
            actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => accountSettingsParse({ actionsSettingsV1: {
                v: 1, actions: { 'automation.event.sources.list': { approvalRequiredSurfaces: ['plugin'] } },
            } }), allowEnvironmentOverride: false }) }, resolveCurrentMachineId: () => machineId,
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId, machineId }) },
    });
    try {
        fixture.registry.startAdoptedBackgroundServices?.();
        await vi.waitFor(() => expect(artifacts.size).toBe(1));
        const artifact = [...artifacts.values()][0]!;
        const header = decodePlainArtifactStoredContent(artifact.header);
        expect(header).toMatchObject({ actionId: 'automation.event.sources.list', machineId, serverIdentityId });
        const approvals = createCliApprovalsArtifactStore({ credentials });
        const request = ApprovalRequestV2Schema.parse(await approvals.approvalsGet({ artifactId: artifact.id }));
        expect(request.executionOriginV1).toMatchObject({ machineId, serverIdentityId, accountId,
            authority: 'account_automation', surface: 'plugin', caller: { kind: 'plugin', pluginId } });
        const listed = await approvals.approvalsList({ status: 'open' });
        expect(listed.items).toContainEqual(expect.objectContaining({ artifactId: artifact.id,
            actionId: 'automation.event.sources.list' }));
    } finally {
        for (const artifactId of artifacts.keys()) getSharedBlockingApprovalCoordinator().cancelApproval(artifactId);
        await fixture.lease.release();
        await fixture.controller.shutdown();
        await fixture.dispose();
    }
});
