import { describe, expect, it } from 'vitest';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createClientActionMachineRpcExecutor } from '@/plugins/runtime/invocation/actions/clientActionMachineRpc';
import { createBrowserAutomationReverseDispatcher } from '@/daemon/browser/automation/reverseDispatch';
import { createClientActionReverseDispatcher } from '@/session/actions/clientActionReverseDispatch';
import { registerDaemonBrowserControlHandler } from '@/rpc/handlers/daemonBrowserControl';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { ApiMachineClient } from './apiMachine';
import type { Machine } from './types';

const plainMachine: Machine = { id: 'machine-plain-1', encryptionMode: 'plain', metadata: null, metadataVersion: 0,
  daemonState: null, daemonStateVersion: 0 };

describe('ApiMachineClient reverse client RPC principal', () => {
  it('sends no reverse client RPC for another Account through any daemon route into its own Apps', async () => {
    // MACH-PRINCIPAL-AUDIT-1116 A-R4 / SEC 1116C: the Machine socket reaches the daemon
    // Account's Apps; a hosted member's client, plugin or App-view Action never uses them.
    const emitted: string[] = [];
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: async (_event, payload) => {
      emitted.push(String((payload as { method?: unknown }).method));
      return { ok: true, result: { v: 1, execution: { ok: true, result: {} } } };
    } });
    // Boundary fixture: a JWT-shaped daemon token whose subject is the Machine owner.
    const ownerToken = `h.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.s`;
    const client = new ApiMachineClient(ownerToken, plainMachine);
    Reflect.set(client, 'socket', socket);
    const plugin = createClientActionMachineRpcExecutor(() => client);
    const browser = createBrowserAutomationReverseDispatcher({ getMachineClient: () => client });
    const presenter = createClientActionReverseDispatcher(() => client);
    const contributed = { v: 1 as const, action: { pluginId: 'example.plugin', localId: 'open' }, input: null, surface: 'agent' as const };
    const context = (accountId: string) => ({ surface: 'agent' as const, authority: 'account_automation' as const,
      runtimeAccountId: accountId, defaultSessionId: 'hosted-session' });
    const view = { browserSessionId: 'browser', viewId: 'app-view', actionKind: 'snapshot' };
    expect(await client.callConnectedClientRpc('ui.navigation', {}, { principalAccountId: 'member' }))
      .toEqual({ ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE' });
    expect(await plugin(contributed, { principalAccountId: 'member' })).toMatchObject({ ok: false, actionHandlerInvocation: 'notStarted' });
    expect(await browser({ actionId: 'browser.automation.snapshot', input: view, context: context('member') } as never)).toMatchObject({ ok: false });
    // Typed client absence (inbox.get settles as status 'unavailable'), never a delivery.
    expect(await presenter({ actionId: 'inbox.get', input: {}, context: context('member') })).toEqual({ ok: true, result: { status: 'unavailable' } });
    expect(emitted).toEqual([]);
    await plugin(contributed, { principalAccountId: 'owner' });
    await browser({ actionId: 'browser.automation.snapshot', input: view, context: context('owner') } as never);
    await presenter({ actionId: 'inbox.get', input: {}, context: context('owner') });
    expect(emitted).toHaveLength(3);
  });

  it('refuses a reverse call without an Account and keeps a manage-grantee login import out of the owner Apps', async () => {
    // P03 SEC-RPC: Machine manage admits the private login exchange; its native continuation must
    // carry the admitted actor, and an unattributed reverse call is refused at the send owner.
    const emitted: string[] = [];
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: async (_event, payload) => {
      emitted.push(String((payload as { method?: unknown }).method));
      return { ok: true, result: { status: 'completed', records: [] } };
    } });
    const ownerToken = `h.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.s`;
    const client = new ApiMachineClient(ownerToken, plainMachine);
    Reflect.set(client, 'socket', socket);
    const handlers = new Map<string, (raw: unknown, context?: RpcHandlerContext) => unknown>();
    registerDaemonBrowserControlHandler({ registerHandler: (method, handler) => {
      handlers.set(method, handler as (raw: unknown, context?: RpcHandlerContext) => unknown);
    } }, { getNativeClient: () => client });
    const signal = new AbortController().signal;
    const admission = (actorAccountId: string): RpcHandlerContext => ({ signal, machineAdmission: { actorAccountId,
      custodianAccountId: 'owner', machineId: plainMachine.id, installationId: 'installation', role: 'manage', encryptionMode: 'plain' } });
    const view = { browserSessionId: 'browser', viewId: 'app-view', profileId: 'profile' };
    const cookies = { ...view, cookies: [{ name: 'sid', value: 'v', domain: 'example.test', path: '/', secure: true, httpOnly: true }] };
    const passkeys = { ...view, credentials: [] };
    const applyCookies = handlers.get(RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIES_APPLY)!;
    const applyPasskeys = handlers.get(RPC_METHODS.DAEMON_BROWSER_PROFILE_PASSKEYS_APPLY)!;

    await applyCookies(cookies, admission('owner'));
    await applyPasskeys(passkeys, admission('owner'));
    expect(emitted).toHaveLength(2);
    emitted.length = 0;

    await applyCookies(cookies, admission('member'));
    await applyPasskeys(passkeys, admission('member'));
    await applyCookies(cookies, { signal });
    await applyPasskeys(passkeys, { signal });
    expect.soft(emitted).toEqual([]);
    expect(await client.callConnectedClientRpc('ui.navigation', {}, {} as never))
      .toEqual({ ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE' });
  });
});
