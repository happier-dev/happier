import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { handleActionsCommand } from '@/cli/commands/actions';

import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { writeDaemonState } from '@/persistence';
import { configuration } from '@/configuration';
import { DAEMON_CONTROL_TOKEN_HEADER } from '@/daemon/controlHttp';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';

afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

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
                    if (req.url === '/ping') {
                        expect(req.method).toBe('POST');
                        expect(req.headers[DAEMON_CONTROL_TOKEN_HEADER]).toBe('fixture');
                        res.end(JSON.stringify({ status: 'ok' })); return;
                    }
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
                    let output = '';
                    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
                        output += String(chunk);
                        const callback = args.find(argument => typeof argument === 'function');
                        if (typeof callback === 'function') callback();
                        return true;
                    });
                    await handleActionsCommand(['invoke', actionId, '--input-json', JSON.stringify(input), '--json'], {
                        readCredentialsFn: async () => ({ token, encryption: null, credentialProvenance: 'stored_session' }),
                        getServerProfileFn: async () => { throw new Error('No saved profile in this isolated test Home'); },
                        createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params,
                            serverId: configuration.activeServerId, serverIdentityId: 'srv_home',
                            serverApiUrl: `http://127.0.0.1:${address.port}`,
                            actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } }),
                    });
                    const result = JSON.parse(output);
                    if (scenario === 'own') {
                        expect(result).toMatchObject({ ok: false, kind: 'actions_invoke', error: { code: 'credential_unavailable' } });
                        expect(requests).toEqual([expect.objectContaining({ actionId, input })]);
                        expect(requests[0]).not.toHaveProperty('target');
                    } else {
                        expect(result).toMatchObject({ ok: false, kind: 'actions_invoke', error: { code: 'daemon_unavailable' } });
                        expect(requests).toEqual([]);
                    }
                } finally { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
            });
        });
    }
}
