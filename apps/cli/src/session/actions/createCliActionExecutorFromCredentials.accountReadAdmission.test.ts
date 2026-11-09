import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveAccountMachineKeyFromRecoverySecret, FeaturesResponseSchema } from '@happier-dev/protocol';
import { ExternalActionRequestEnvelopeV2Schema, openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { AccessibleMachineAccessV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { configuration } from '@/configuration';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

describe('original CLI Account admission', () => {
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    it.each([
        { actionId: 'workflow.run.get', input: { runId: '46d53d20-11a7-4a49-93a8-cbf56381e2dc' } },
        { actionId: 'workflow.run.invocations.list', input: { runId: '46d53d20-11a7-4a49-93a8-cbf56381e2dc' } },
        { actionId: 'deployments.receipts.list', input: { serverId: 'srv_home', environmentId: 'environment' } },
        { actionId: 'approval.request.create', input: { actionId: 'session.title.set', actionArgs: { sessionId: 'session', title: 'Reviewed' },
            summary: 'Review title', createdBy: { surface: 'cli' } } },
    ] as const)('delivers $actionId with authenticated Home identity and the original terminal Account', async ({ actionId, input }) => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-account-read-admission-' }, async () => {
            const accountId = 'reader';
            const machineId = 'owned-offline-machine';
            const token = `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 4,
                provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
            const secret = new Uint8Array(32).fill(17);
            const material = { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) };
            const machine = { id: machineId, kind: 'persistent', active: false, revokedAt: null, replacedByMachineId: null,
                access: AccessibleMachineAccessV1Schema.parse({ custodian: { accountId, displayName: 'Reader' },
                    role: 'manage', resourceMode: 'e2ee', accessState: 'ready' }) };
            vi.spyOn(axios, 'request').mockImplementation(async request => {
                expect(request.url).toBe('https://home.test/v1/machines/managed/actions/list');
                return { status: 200, data: { machines: [] } };
            });
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
                if (url.endsWith('/v1/machines')) return { status: 200, data: [machine] };
                throw new Error(`Unexpected admission read ${new URL(url).pathname}`);
            });
            let delivered = false;
            // HTTP is the boundary: routing, provenance, target admission and
            // E2EE request/response binding remain the real production owners.
            vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
                expect(url).toBe(`https://home.test/v1/actions/${actionId}`);
                expect(options?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
                const envelope = ExternalActionRequestEnvelopeV2Schema.parse(body);
                const binding = { serverIdentityId: 'srv_home', accountId,
                    authentication: { kind: 'terminal' as const, tokenEpoch: 4 }, actionId,
                    requestId: envelope.requestId, target: { kind: 'machine' as const, machineId } };
                expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding, material })?.input).toEqual(input);
                delivered = true;
                return { status: 200, data: prepareExternalActionResponseV2({ request: envelope, binding, material,
                    executedMachineId: machineId, randomBytes: length => new Uint8Array(length).fill(6),
                    execution: { ok: false, errorCode: 'action_forbidden', error: 'action_forbidden' } }).response };
            });
            const executor = createCliActionExecutorFromCredentials({
                credentials: { token, credentialProvenance: 'stored_session', encryption: { type: 'legacy', secret } },
                serverId: configuration.activeServerId, serverApiUrl: 'https://home.test', machineId, externalActionClient: true,
                resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'authenticated',
                    features: FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } } }) }),
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) },
            });
            expect(getActionSpec(actionId).inputSchema.safeParse(input).success).toBe(true);
            expect(await executor.execute(actionId, input, { surface: 'cli', actionRequestId: 'account-read' }))
                .toEqual({ ok: false, errorCode: 'action_forbidden', error: 'action_forbidden' });
            expect(delivered).toBe(true);
        });
    });
});
