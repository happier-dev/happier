import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ExternalActionRequestEnvelopeSchema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveManagedMachineWakeStateV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { configuration } from '@/configuration';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('retains the canonical selector refusal when an explicit spawn Machine conflicts with the envelope', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-cli-spawn-selection-' }, async () => {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 4,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const executor = createCliActionExecutorFromCredentials({
            credentials: { token, encryption: null, credentialProvenance: 'stored_session' }, externalActionClient: true,
            serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
            actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) },
        });
        const result = await executor.execute('session.spawn_new', {
            creationKey: 'selector-conflict',
            executionTarget: { serverId: configuration.activeServerId, machineId: 'selected-machine' },
            directory: { kind: 'path', path: '/workspace' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        }, { surface: 'cli', externalActionTarget: { kind: 'machine', machineId: 'envelope-machine' } });
        expect(result).toEqual({ ok: false, errorCode: 'target_not_local', error: 'target_not_local',
            details: { phase: 'target_machine_selection' } });
    });
});

it.each(['stored_session', 'api_token'] as const)('forwards an asleep CLI original to Home admission without a local wake or refusal (%s)', async credentialProvenance => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-cli-asleep-original-' }, async () => {
        const machineId = 'sleeping-guest';
        const token = credentialProvenance === 'api_token' ? 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43)
            : `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 4,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const credentials = { token, encryption: null, credentialProvenance };
        const managed = ManagedMachineV1Schema.parse({ id: 'managed-sleeping', homeId: 'srv_home', custodianAccountId: 'owner',
            enrolledMachineId: machineId, allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 4,
            launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            resource: { contributionRef: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { availability: 'present', power: 'stopped', storage: 'retained', observedAt: 1 },
        });
        const requests: string[] = [];
        const queries: unknown[] = [];
        expect(resolveManagedMachineWakeStateV1(managed, machineId)).toBe('asleep');
        // Only HTTP and the local daemon transport are substituted; the CLI owner and its parsers stay real.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (url.endsWith('/v1/machines')) return { status: 200, data: [{ id: machineId, active: false, kind: 'persistent',
                revokedAt: null, replacedByMachineId: null,
                managedMachineRef: { homeId: managed.homeId, managedId: managed.id },
                access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } }] };
            throw new Error(`Unexpected HTTP read: ${url}`);
        });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            requests.push(String(request.url));
            queries.push(request.data);
            return { status: 200, data: { machines: [managed] } };
        });
        const forwarded: unknown[] = [];
        const response = (body: unknown) => {
            const envelope = ExternalActionRequestEnvelopeSchema.parse(body);
            forwarded.push(envelope);
            return ExternalActionResponseEnvelopeV1Schema.parse({ v: 1,
                actionId: 'daemon.filesystem.readFile', requestId: envelope.requestId,
                execution: { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' } });
        };
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            requests.push(String(url));
            return { status: 200, data: response(body) };
        });
        const local = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            if (String(url) === 'https://home.test/v1/actions/daemon.filesystem.readFile') {
                requests.push(String(url));
                return Response.json(response(JSON.parse(String(init?.body))));
            }
            return Response.json({ ok: false, errorCode: 'target_not_local', error: 'target_not_local' });
        });
        vi.stubGlobal('fetch', local);
        const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true, machineId,
            serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
            resolveServerFeaturesSnapshot: async () => ({ status: 'unsupported', reason: 'endpoint_missing' }),
            actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
        const result = await executor.execute('daemon.filesystem.readFile', { rootPath: '/workspace', path: 'README.md' }, {
            surface: 'cli', externalActionTarget: { kind: 'machine', machineId },
        });
        expect(result).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
        expect(queries).toEqual([]);
        expect(requests).toEqual(['https://home.test/v1/actions/daemon.filesystem.readFile']);
        expect(forwarded).toEqual([expect.objectContaining({ target: { kind: 'machine', machineId },
            input: { rootPath: '/workspace', path: 'README.md' } })]);
    });
});
