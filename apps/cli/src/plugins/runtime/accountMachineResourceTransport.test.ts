import { afterEach, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { DaemonPluginTargetedSourceDeclarationV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { DaemonPluginStructuredMessageActionExecuteRequestSchema } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { invokeAccountMachineSourceAction } from './invocation/actions/accountMachineActionTransport';
import { manifest as accountManifest } from '../../../../../packages/plugin-sdk/fixtures/account-actions/src/index';

const { callExactMachineRpc } = vi.hoisted(() => ({ callExactMachineRpc: vi.fn() }));
// Machine RPC is the external network boundary; manifest production, caller
// provenance and the transport's request/response schemas remain real.
vi.mock('@/session/transport/rpc/machineRpc', async importOriginal => ({
    ...await importOriginal<typeof import('@/session/transport/rpc/machineRpc')>(), callExactMachineRpc,
}));
afterEach(() => vi.restoreAllMocks());

it('lets the selected Machine decide an Account Resource source read', async () => {
    const callerManifest = normalizePluginManifestV2(accountManifest);
    const callerSourceCustody = { kind: 'account_release' as const, pluginId: callerManifest.id,
        version: callerManifest.version, archiveDigestSha256: `sha256:${'a'.repeat(64)}` };
    const provider = definePlugin({ id: 'acme.resource-source', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
        actions: { read: { title: 'Read source', scopes: ['global'], surfaces: ['plugin'], dangerLevel: 'safe', readOnly: true,
            run: () => ({ value: 'machine source' }) } } });
    const manifest = normalizePluginManifestV2(provider.manifest);
    const source = DaemonPluginTargetedSourceDeclarationV1Schema.parse({ manifest: { id: manifest.id, contributes: {
        actions: manifest.contributes.actions, pluginContributionPoints: [],
        targetedPluginContributions: manifest.contributes.targetedPluginContributions, ui: { renderers: [] },
    } }, occurrenceId: 'source-occurrence', sourceCustody: {
        kind: 'managed', immutableGenerationId: 'source-generation', installSource: 'archive',
    } });
    callExactMachineRpc.mockImplementation(async ({ request }) => {
        const parsed = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(request);
        expect(parsed).toMatchObject({ machineId: 'selected-machine', requiredReadOnly: true,
            qualifiedActionId: `${manifest.id}/read`, expectedContributorOccurrenceId: source.occurrenceId });
        return { ok: true, result: { value: 'machine source' } };
    });
    const result = await invokeAccountMachineSourceAction({ credentials: { token: 'requester-token', encryption: null },
        serverUrl: 'http://requester-home.test', machineId: 'selected-machine', callerManifest,
        callerSourceCustody, source,
        request: { action: { pluginId: manifest.id, localId: 'read' }, input: {}, requiredReadOnly: true, surface: 'plugin',
            caller: { kind: 'plugin', pluginId: callerManifest.id, occurrenceId: 'resource-occurrence', sourceCustody: callerSourceCustody,
                contribution: { id: 'personal-context', qualifiedId: `${callerManifest.id}/resources/personal-context` } },
            signal: new AbortController().signal } });
    expect(result).toEqual({ status: 'executed', value: { value: 'machine source' } });
});
