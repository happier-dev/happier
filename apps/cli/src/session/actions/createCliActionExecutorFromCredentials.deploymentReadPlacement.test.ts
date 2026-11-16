import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { configuration } from '@/configuration';
import { writeDaemonState } from '@/persistence';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

vi.mock('undici', async importOriginal => {
    const actual = await importOriginal<typeof import('undici')>();
    return { ...actual, fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
        default: { ...actual.default, fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) } };
});

describe('deployment read placement from a CLI on another Machine', () => {
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
    it.each(['terminal', 'account'] as const)('dispatches current health to the controller the read names, not this CLI Machine (%s)', async kind => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-health-probe-' }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
                provenance: kind === 'terminal' ? { v: 1, kind: 'terminal', authority: 'account_automation' }
                    : { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
            writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
                controlToken: 'fixture-control-token', machineId: 'own-machine', accountId: 'owner' });
            const calls: string[] = [];
            vi.stubGlobal('fetch', vi.fn(async (url: unknown, options: RequestInit) => {
                calls.push(`fetch ${String(url)} ${String(options?.body).slice(0, 300)}`);
                return Response.json({ ok: false, errorCode: 'probe', error: 'probe' });
            }));
            const record = (method: string) => vi.spyOn(axios, method as 'get').mockImplementation(async (url: unknown, body?: unknown) => {
                calls.push(`axios.${method} ${String(url)} ${JSON.stringify(body)?.slice(0, 300)}`);
                return { status: 418, data: { ok: false, error: 'probe' } };
            });
            record('get'); record('post'); record('request');
            const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                machineId: 'own-machine',
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            const result = await executor.execute('deployments.health.current', { serverId: 'srv_home', environmentId: 'env',
                targetLinkId: 'link', machineId: 'controller-machine' }, { surface: 'cli' });
            // Dispatch first reads the receiving Machine it will ask Home to mint for.
            // It must be the controller the read names, never this CLI's own Machine.
            const evidence = `${JSON.stringify(result)}\n${calls.join('\n')}`;
            expect(calls.some(call => call.includes('/v1/machines/controller-machine')), evidence).toBe(true);
            expect(calls.some(call => call.includes('/v1/machines/own-machine')
                || call.includes('/actions/root/execute')), evidence).toBe(false);
        });
    });
});
