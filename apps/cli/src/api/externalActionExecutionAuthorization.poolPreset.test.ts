import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { MachinePoolResolveInputV1Schema } from '@happier-dev/protocol/machines/pools';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { buildManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { ManagedMachinePresetV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { MachineProvisionerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema,
    ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createExternalMcpServer } from '@/mcp/createExternalMcpServer';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each(['ready', 'account-ready', 'mcp-ready', 'unavailable', 'bound', 'denied'] as const)('originates a pool preset through the real host entry (%s)', async status => {
    const homeId = 'srv_pool_preset';
    const poolId = '4d783830-8626-4da8-8fde-a6da516025e1';
    const controller = { machineId: 'company-controller', installationId: 'company-installation' };
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    const custodianAccountId = status === 'account-ready' ? 'requester' : 'company';
    const controllerAccess = { installationPublicKey: encodeBase64(installation.publicKey, 'base64url'), custodian: { accountId: custodianAccountId } };
    const provisioner = MachineProvisionerContributionV1Schema.parse({ id: 'vm', title: 'VM', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
        enrollmentRole: 'sandbox', launchSchema: { type: 'object', properties: {}, additionalProperties: false },
        resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
        billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['delete'] },
        actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' } });
    const launch = { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Team VM', choices: {} };
    const facts = buildManagedConfigurationFactsV1({ choicesSchema: PluginJsonValueV2Schema, launch,
        optionStatus: 'current', prerequisites: [], billing: provisioner.billing, retentionCapabilities: provisioner.retention,
        preset: { id: 'team-preset', revision: 4, name: 'Team VM' } });
    const preset = ManagedMachinePresetV1Schema.parse({ id: 'team-preset', homeId, revision: 4, name: 'Team VM',
        owner: status === 'account-ready' ? { kind: 'account', accountId: 'requester' } : { kind: 'team', teamId: 'company-team' }, launch, controllerPoolId: poolId,
        ...(status === 'account-ready' ? {} : { teamAcquireDelegated: true }), delegatedAcquire: { kind: 'ready', provisioner, reviewedFacts: facts } });
    const input = ManagedAcquireInputV1Schema.parse({ selection: { kind: 'preset', homeId, id: preset.id, revision: preset.revision },
        retention: facts.retention, wakeOnAcceptedMessage: facts.wakeOnAcceptedMessage,
        enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, reviewedFacts: facts,
        ...(status === 'bound' ? { controller } : {}) });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 1,
        provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
    let requestId = 'pool-acquire';
    const requests: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        requests.push(path);
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        throw new Error(`Unexpected private read: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        const path = new URL(String(url)).pathname;
        requests.push(path);
        if (path === '/v1/machines/presets/get') return { status: 200, data: { kind: 'found', preset } };
        if (path === '/v1/machines/pools/resolve') {
            if (status === 'mcp-ready') requestId = MachinePoolResolveInputV1Schema.parse(body).requestKey;
            expect(body).toEqual({ poolId, requestKey: requestId, purpose: 'managed-preset',
                preset: { homeId, id: preset.id, revision: preset.revision } });
            return { status: status === 'denied' ? 404 : 200, data: status === 'denied' ? { code: 'pool_not_found' } : status === 'unavailable'
                ? { kind: 'unavailable', poolId, reason: 'managed_preset_unavailable', code: 'controller_unavailable' }
                : { kind: 'resolved', poolId, machineId: controller.machineId, priorityTier: 0,
                    managedPreset: { controller, controllerAccess, provisioner, reviewedFacts: { ...facts, controller } } } };
        }
        if (path.endsWith('/execution-authorization')) {
            const envelope = ExternalActionRequestEnvelopeSchema.parse((body as { envelope: unknown }).envelope);
            expect(envelope).toMatchObject({ target: { kind: 'machine', machineId: controller.machineId },
                input: { controller, reviewedFacts: { controller } } });
            return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-root', binding: {
                accountId: 'requester', custodianAccountId, authentication: { kind: 'terminal', tokenEpoch: 1 },
                accountEncryptionMode: 'plain', serverIdentityId: homeId, machineId: controller.machineId,
                installationId: controller.installationId, actionId: 'machines.managed.acquire', requestId,
                target: envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            } }) };
        }
        if (path === '/v1/actions/machines.managed.acquire') return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({
            v: 1, actionId: 'machines.managed.acquire', requestId,
            execution: { ok: true, result: { kind: 'approval_request_created', artifactId: 'approval', actionId: 'machines.managed.acquire' } },
        }) };
        throw new Error(`Unexpected request: ${path}`);
    });
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
    const executor = createCliActionExecutorFromCredentials({ credentials,
        externalActionClient: true, serverId: 'home', serverApiUrl: 'https://pool-home.example.test', serverIdentityId: homeId,
        actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }),
            getAccountSettings: () => accountSettingsParse({}) } });
    const result = status === 'mcp-ready' ? await (async () => {
        vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify({ v: 1 }));
        const { mcp } = runWithServerHttpBaseUrl('https://pool-home.example.test', () => createExternalMcpServer({
            credentials, daemonControlTarget: null,
            serverFeaturesSnapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: {},
                capabilities: { serverIdentity: { serverIdentityId: homeId } } }) },
        }));
        const client = new Client({ name: 'pool-preset-origin-test', version: '1' });
        const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
        try {
            await mcp.connect(serverTransport); await client.connect(clientTransport);
            const response = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
                arguments: { actionId: 'machines.managed.acquire', input } }));
            const content = response.content.find(item => item.type === 'text');
            expect(response.isError, content?.type === 'text' ? content.text : undefined).not.toBe(true);
            return { ok: true, result: content?.type === 'text' ? JSON.parse(content.text) : null };
        } finally { await client.close(); await mcp.close(); }
    })() : await executor.execute('machines.managed.acquire', input, { surface: 'cli', actionRequestId: requestId });
    const ready = status === 'ready' || status === 'account-ready' || status === 'mcp-ready';
    expect(result, JSON.stringify(result)).toMatchObject(ready ? { ok: true, result: { kind: 'approval_request_created' } }
        : { ok: false, errorCode: status === 'denied' ? 'pool_not_found' : 'controller_unavailable' });
    expect(requests.filter(path => path === '/v1/machines/pools/resolve')).toHaveLength(status === 'bound' ? 0 : 1);
    expect(requests.filter(path => path === '/v1/actions/machines.managed.acquire')).toHaveLength(ready ? 1 : 0);
});
