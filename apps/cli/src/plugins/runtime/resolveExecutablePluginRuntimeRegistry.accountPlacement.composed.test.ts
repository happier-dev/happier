import fastify from 'fastify';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { executeContributedAction } from './invocation/actions/executeContributedAction';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { executeAppliedDaemonPluginActionWithController } from '@/plugins/daemon/controlRoutes';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { manifest } from '@/session/actions/accountSessionMachineSource.testkit';
import * as persistence from '@/persistence';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';

it('retains local Account custody through Machine Actions into an Account Action for a spawned Session', async () => {
    const accountId = 'local-placement-owner';
    const origin = 'http://local-placement.test';
    const credentials = { token: 'e30.' + Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url') + '.signature', encryption: null };
    // Stored sign-in and Home HTTP are the boundaries; control admission,
    // nested SDK dispatch, placement and Account activation stay real.
    const readCredentials = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    const socket = await createRequesterCurrentnessSocketHarness();
    const app = fastify();
    const requests: string[] = [];
    app.addHook('onRequest', async request => { requests.push(`${request.method} ${request.url}`); });
    const features = registerAccountHomeHttp(app, { accountId, serverId: 'placement-home' });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption/currentness') return Response.json(createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
        throw new Error(`Unexpected fixture fetch: ${path}`);
    });
    const authored = await registerAuthoredAccountActionRelease(app, accountId, { primary: {
        manifest, projectRoot: resolve(import.meta.dirname, '../../..'),
        entryPath: resolve(import.meta.dirname, '../../session/actions/accountSessionMachineSource.testkit.ts'),
    } });
    app.get('/v2/sessions/spawned-on-machine', async () => ({ session: {
        id: 'spawned-on-machine', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'session-machine' }), metadataVersion: 1,
        dataEncryptionKey: null, agentState: null, agentStateVersion: 0,
        responsibleAccountId: null, responsibleAccount: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
            capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
    } }));
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin });
    let runtime: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
    try {
        await runWithServerHttpBaseUrl(origin, () => authored.publishArtifacts(credentials));
        const parent = definePlugin({ id: 'acme.machine-placement-parent', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' }, actions: {
            start: { title: 'Start', surfaces: ['cli', 'plugin'], dangerLevel: 'safe', run: async () => null },
            link: { title: 'Link', surfaces: ['cli', 'plugin'], dangerLevel: 'safe', run: async () => null },
        } });
        runtime = await runWithServerHttpBaseUrl(origin, () => createAuthoredAdmittedPluginRuntimeFixture({
            runtimeOptions: { scopedActionRuntime: { credentials, actionsSettingsProvider: createActionSettingsProvider() } },
            plugins: [{ manifest: parent.manifest, files: { 'daemon.mjs': `export function activate(api) {
                api.actions.register('start', (input, context) => context.services.actions.execute({ pluginId: 'acme.machine-placement-parent', localId: 'link' }, input));
                api.actions.register('link', (input, context) => context.services.actions.execute({ pluginId: 'acme.account-session-source', localId: 'account-only' }, input));
            }` } }, { manifest, files: { 'daemon.mjs': 'export function activate() {}' } }],
        }));
        const result = await runWithServerHttpBaseUrl(origin, () => executeAppliedDaemonPluginActionWithController({
            actionId: buildQualifiedPluginContributionKey({ pluginId: 'acme.machine-placement-parent', localId: 'start' }), input: { sessionId: 'spawned-on-machine' },
            surface: 'cli', defaultSessionId: 'spawned-on-machine',
        }, runtime!.controller));
        expect(result, JSON.stringify(requests)).toEqual({ matched: true, result: { ok: true, result: { value: 'account-only' } } });
        // A received request with missing private custody must not borrow the
        // Machine owner's Account, even though the same local runtime is ready.
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'remote-root', binding: {
            serverIdentityId: 'placement-home', accountId: 'remote-requester', custodianAccountId: accountId,
            authentication: { kind: 'account', tokenEpoch: 1 }, machineId: 'session-machine', installationId: 'installation',
            actionId: 'action.invoke', requestId: 'remote-request', requestEnvelopeDigest: 'A'.repeat(43),
            target: { kind: 'machine', machineId: 'session-machine' },
        } });
        const remote = await runWithServerHttpBaseUrl(origin, () => executeContributedAction({
            runtimeRegistry: runtime!.registry,
            actionId: buildQualifiedPluginContributionKey({ pluginId: parent.manifest.id, localId: 'start' }),
            input: { sessionId: 'spawned-on-machine' }, context: { surface: 'cli' },
            approvalContext: { externalActionExecutionAuthorization: authorization },
        }));
        expect(remote).toMatchObject({ matched: true, result: { ok: false,
            errorCode: 'plugin_action_execution_placement_unavailable' } });
        // Session-only RPC authority cannot become the Machine owner's Account
        // authority when the Action invokes another contributed Action.
        const sessionScoped = await runWithServerHttpBaseUrl(origin, () => executeContributedAction({
            runtimeRegistry: runtime!.registry,
            actionId: buildQualifiedPluginContributionKey({ pluginId: parent.manifest.id, localId: 'start' }),
            input: { sessionId: 'spawned-on-machine' }, context: { surface: 'cli' },
            approvalContext: { rpcSessionAuthorization: { kind: 'session.write', sessionId: 'spawned-on-machine' } },
        }));
        expect(sessionScoped).toMatchObject({ matched: true, result: { ok: false,
            errorCode: 'plugin_action_execution_placement_unavailable' } });
        // A guest admitted to the owner's Machine (Manage grant) must not run
        // Account Actions as the Machine owner, even with a current admission.
        const guest = await runWithServerHttpBaseUrl(origin, () => executeContributedAction({
            runtimeRegistry: runtime!.registry,
            actionId: buildQualifiedPluginContributionKey({ pluginId: parent.manifest.id, localId: 'start' }),
            input: { sessionId: 'spawned-on-machine' }, context: { surface: 'cli' },
            approvalContext: { runtimeAccountId: 'machine-guest',
                machineAdmission: { actorAccountId: 'machine-guest', custodianAccountId: accountId, machineId: 'session-machine',
                    installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
                verifyMachineAdmissionCurrent: async () => true },
        }));
        expect(guest).toMatchObject({ matched: true, result: { ok: false,
            errorCode: 'plugin_action_execution_placement_unavailable' } });
    } finally {
        await runtime?.dispose(); await socket.close(); restore(); await app.close(); fetch.mockRestore(); readCredentials.mockRestore(); resetActiveAccountSettingsSnapshotForTests();
    }
});
