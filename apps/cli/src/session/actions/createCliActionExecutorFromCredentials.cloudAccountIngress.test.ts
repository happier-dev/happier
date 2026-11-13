import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { writeDaemonState } from '@/persistence';
import { configuration } from '@/configuration';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';

for (const provider of ['agent37', 'boat']) {
    for (const actionId of ['machines.provisioners.options', 'machines.managed.acquire'] as const) {
        it.each(['absent', 'own', 'foreign'] as const)(`${provider} ${actionId} uses the native Account executor (%s)`, async scenario => {
            await withConfiguredDaemonTestHome({ prefix: 'cloud-account-runtime-' }, async () => {
                const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
                    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
                const contribution = { pluginId: `happier.machine.${provider}`, localId: provider };
                const input = actionId === 'machines.provisioners.options'
                    ? { homeId: 'srv_home', contribution, selectors: {} }
                    : { enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, selection: {
                        kind: 'one-off', homeId: 'srv_home', launch: { provider: contribution, schemaVersion: 1,
                            name: `cloud-a-owner-${provider}`, choices: {} },
                        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
                const requests: unknown[] = [];
                // Real HTTP is the only substituted system: both Action factories and Home transport stay real.
                const http = createServer(async (req, res) => {
                    res.setHeader('content-type', 'application/json');
                    if (req.url === '/actions/root/execute') {
                        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
                        requests.push(JSON.parse(Buffer.concat(chunks).toString()));
                        res.end(JSON.stringify({ ok: false, errorCode: 'credential_unavailable', error: 'Select a connected account.', details: { phase: 'connected_account_admission', remedy: 'Select an account.' } })); return;
                    }
                    if (req.url === '/v1/features/authenticated' || req.url === '/v1/features') {
                        res.end(JSON.stringify({ features: {}, capabilities: {} })); return;
                    }
                    expect(req.url).toBe(managedMachineActionEndpointPathV1(actionId));
                    expect(req.headers.authorization).toBe(`Bearer ${token}`);
                    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
                    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
                    res.statusCode = 404; res.end(JSON.stringify({ error: 'Not Found' }));
                });
                http.listen(0, '127.0.0.1'); await once(http, 'listening');
                const address = http.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
                if (scenario !== 'absent') writeDaemonState({ pid: process.pid, httpPort: address.port, startedAt: Date.now(), startedWithCliVersion: 'test', controlToken: 'fixture', machineId: 'own-machine', accountId: scenario === 'own' ? 'owner' : 'another-account' });
                try {
                    const executor = createCliActionExecutorFromCredentials({ credentials: { token, encryption: null,
                        credentialProvenance: 'stored_session' }, serverId: configuration.activeServerId,
                        serverIdentityId: 'srv_home',
                        serverApiUrl: `http://127.0.0.1:${address.port}`,
                        actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
                    const result = await executor.execute(actionId, input, { surface: 'cli', presentUserConfirmation: { actionId } });
                    if (scenario === 'own') {
                        expect(result).toEqual({ ok: false, errorCode: 'credential_unavailable', error: 'Select a connected account.',
                            details: { phase: 'connected_account_admission', remedy: 'Select an account.' } });
                        expect(requests).toEqual([expect.objectContaining({ actionId, input })]);
                        expect(requests[0]).not.toHaveProperty('target');
                    } else {
                        expect(result).toMatchObject({ ok: false, errorCode: 'daemon_unavailable', effectAttempted: false,
                            details: { phase: 'managed_machine_daemon_ingress', remedy: expect.any(String) } });
                        expect(requests).toEqual([]);
                    }
                } finally { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
            });
        });
    }
}
