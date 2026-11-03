import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowserProfileV1Schema, BrowserProfileLoginsImportResultV1Schema } from '@happier-dev/protocol/browser/profile/v1';
import type { SavedSecretPasskeySourceV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import type { BrowserSidecarContextCaptureSurface } from '../sidecar/controlAdapter';
import { createBrowserProfilePasskeyAuthenticator } from './passkeys';
import { createBrowserDaemonControlBroker } from '../control/broker';
import { createBrowserDaemonControlRoutes } from '../control/routes';
import { createBrowserSidecarCdpControlAdapter, type BrowserSidecarCdpEventSubscriber } from '../sidecar/controlAdapter';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerDaemonBrowserControlHandler } from '@/rpc/handlers/daemonBrowserControl';
import { createBrowserProfileStore } from './store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';

const view = { browserSessionId: 'session', viewId: 'view' };
const profile = BrowserProfileV1Schema.parse({ profileId: 'profile', owner: { kind: 'session', id: 'session' }, storageMode: 'ephemeral', lifecycleState: 'active' });
const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const credential: SavedSecretPasskeySourceV1 = { kind: 'passkey', rpId: 'example.com', credentialId: 'AQID', userHandle: 'BAUG', privateKey: key,
  algorithm: -7, signCount: 0, backupEligibility: true, backupState: true };

function nativeBoundary() {
  const commands: { method: string; params?: Record<string, unknown> }[] = [];
  const credentialIds = new Set<string>();
  const capture: BrowserSidecarContextCaptureSurface = {
    resolvePageHandle: input => input.browserSessionId === view.browserSessionId && input.viewId === view.viewId ? { targetId: 'page', sessionId: 'cdp' } : null,
    resolveProfile: input => input.browserSessionId === view.browserSessionId ? profile : null,
    // CDP is the native system boundary; profile binding and activation stay real.
    transport: { dispatchPageCommand: async command => {
      commands.push(command);
      if (command.method === 'WebAuthn.addCredential') {
        const material = command.params?.credential;
        const id = material && typeof material === 'object' && 'credentialId' in material ? String(material.credentialId) : '';
        // Chromium InjectResidentKey refuses an existing id; this is the native CDP boundary.
        if (credentialIds.has(id)) throw new Error('Native duplicate credential');
        credentialIds.add(id);
      }
      if (command.method === 'WebAuthn.removeCredential') credentialIds.delete(String(command.params?.credentialId));
      if (command.method === 'WebAuthn.removeVirtualAuthenticator') credentialIds.clear();
      return command.method === 'WebAuthn.addVirtualAuthenticator' ? { authenticatorId: 'auth' } : {};
    } },
  };
  return { capture, commands };
}

describe('profile-scoped passkey activation', () => {
  it('transfers selected keys into a native authenticator after admission and preserves synced zero counters', async () => {
    const { capture, commands } = nativeBoundary();
    const owner = createBrowserProfilePasskeyAuthenticator({ capture });
    expect(commands).toEqual([]);
    expect(await owner.activate({ ...view, profileId: profile.profileId, credentials: [credential] })).toEqual({ status: 'completed',
      records: [{ domain: 'example.com', name: 'AQID', status: 'imported' }] });
    const added = commands.find(command => command.method === 'WebAuthn.addCredential');
    expect(added?.params).toMatchObject({ authenticatorId: 'auth', credential: { credentialId: 'AQID', rpId: 'example.com',
      privateKey: key, userHandle: 'BAUG', signCount: -1, backupEligibility: true, backupState: true } });
    expect(commands.find(command => command.method === 'WebAuthn.addVirtualAuthenticator')?.params).toMatchObject({ options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
    } });
    await owner.dispose();
    expect(commands.at(-1)).toMatchObject({ method: 'WebAuthn.removeVirtualAuthenticator', params: { authenticatorId: 'auth' } });
    expect(await owner.activate({ ...view, profileId: profile.profileId, credentials: [credential] })).toMatchObject({ status: 'unavailable' });
  });

  it('refuses wrong profile, missing view, and cancellation before any native effect', async () => {
    const { capture, commands } = nativeBoundary();
    const owner = createBrowserProfilePasskeyAuthenticator({ capture });
    expect(await owner.activate({ ...view, profileId: 'other', credentials: [credential] })).toMatchObject({ status: 'unavailable', code: 'profile_mismatch' });
    expect(await owner.activate({ ...view, viewId: 'other', profileId: profile.profileId, credentials: [credential] })).toMatchObject({ status: 'unavailable' });
    expect(await owner.activate({ ...view, profileId: profile.profileId, credentials: [credential], signal: AbortSignal.abort() })).toMatchObject({ status: 'unavailable', code: 'canceled' });
    expect(commands).toEqual([]);
  });

  it('reports unsupported usage counters with a visible reason before native effects', async () => {
    const { capture, commands } = nativeBoundary();
    const owner = createBrowserProfilePasskeyAuthenticator({ capture });
    const result = BrowserProfileLoginsImportResultV1Schema.parse(await owner.activate({
      ...view, profileId: profile.profileId, credentials: [{ ...credential, signCount: 8 }],
    }));
    expect(result).toMatchObject({ status: 'completed', records: [{ status: 'failed', code: 'source_format_unsupported',
      reason: 'this passkey tracks a usage counter' }] });
    expect(commands).toEqual([]);
    await owner.dispose();
  });

  it('reactivates a known credential and preserves the native key when replacement material is invalid', async () => {
    const { capture, commands } = nativeBoundary();
    const owner = createBrowserProfilePasskeyAuthenticator({ capture });
    const request = { ...view, profileId: profile.profileId, credentials: [credential] };
    expect(await owner.activate(request)).toMatchObject({ records: [{ status: 'imported' }] });
    expect(await owner.activate(request)).toMatchObject({ records: [{ status: 'imported' }] });
    const beforeInvalid = commands.length;
    expect(await owner.activate({ ...request, credentials: [{ ...credential, privateKey: 'aW52YWxpZA==' }] }))
      .toMatchObject({ records: [{ status: 'failed', code: 'source_format_unsupported' }] });
    expect(commands.length).toBe(beforeInvalid);
    await owner.dispose();
  });

  it('reports an unsupported native engine without returning its exception or key material', async () => {
    const { capture } = nativeBoundary();
    const owner = createBrowserProfilePasskeyAuthenticator({ capture: { ...capture, transport: {
      dispatchPageCommand: async () => { throw new Error(`NATIVE_SENTINEL ${key}`); },
    } } });
    const result = await owner.activate({ ...view, profileId: profile.profileId, credentials: [credential] });
    expect(result).toMatchObject({ records: [{ status: 'failed', code: 'engine_unsupported' }] });
    expect(JSON.stringify(result)).not.toContain('NATIVE_SENTINEL');
    expect(JSON.stringify(result)).not.toContain(key);
    await owner.dispose();
  });

  it('reports an unknown outcome when cancellation loses an in-flight native credential response', async () => {
    const { capture } = nativeBoundary();
    const cancellation = new AbortController();
    const owner = createBrowserProfilePasskeyAuthenticator({ capture: { ...capture, transport: {
      dispatchPageCommand: async command => {
        if (command.method === 'WebAuthn.addCredential') {
          cancellation.abort();
          throw new Error('Native response lost after insertion');
        }
        return capture.transport.dispatchPageCommand(command);
      },
    } } });
    expect(await owner.activate({ ...view, profileId: profile.profileId, credentials: [credential], signal: cancellation.signal }))
      .toMatchObject({ records: [{ status: 'failed', code: 'import_unknown' }] });
    await owner.dispose();
  });

  it('uses the shared private route, activates sibling and new views, and retires keys with native views', async () => {
    const commands: { method: string; targetId: string; params?: Record<string, unknown> }[] = [];
    const nativeCredentials = new Map<string, unknown[]>();
    let nextPage = 0;
    let nextAuth = 0;
    let notify: BrowserSidecarCdpEventSubscriber = () => {};
    const transport = {
      openPage: async () => ({ targetId: `page-${++nextPage}`, sessionId: `cdp-${nextPage}` }),
      dispatchBrowserCommand: async () => ({}),
      subscribeCdpEvents: (listener: BrowserSidecarCdpEventSubscriber) => { notify = listener; return () => {}; },
      dispatchPageCommand: async (command: { method: string; targetId: string; params?: Record<string, unknown> }) => {
        commands.push(command);
        if (command.method === 'WebAuthn.addVirtualAuthenticator') {
          const authenticatorId = `auth-${++nextAuth}`;
          nativeCredentials.set(authenticatorId, []);
          return { authenticatorId };
        }
        const authId = String(command.params?.authenticatorId);
        if (command.method === 'WebAuthn.addCredential') nativeCredentials.get(authId)?.push(command.params?.credential);
        if (command.method === 'WebAuthn.getCredentials') return { credentials: nativeCredentials.get(authId) ?? [] };
        if (command.method === 'WebAuthn.removeVirtualAuthenticator') nativeCredentials.delete(authId);
        return {};
      },
    };
    const adapter = createBrowserSidecarCdpControlAdapter({ ...view, sidecarId: 'sidecar', transport });
    const storageRootDirectory = await mkdtemp(join(tmpdir(), 'happier-passkey-profile-'));
    const profileStore = createBrowserProfileStore({ storageRootDirectory,
      partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory }) });
    profileStore.register({ profileId: profile.profileId, storageMode: 'ephemeral', owner: profile.owner,
      beforePurge: async () => { adapter.dispose(); } });
    const broker = createBrowserDaemonControlBroker();
    broker.registerAdapter(adapter);
    const capture: BrowserSidecarContextCaptureSurface = { transport, resolvePageHandle: adapter.resolvePageHandle,
      resolveProfile: target => adapter.resolvePageHandle(target) ? profileStore.getProfile(profile.profileId) : null,
      subscribeViewLifecycle: adapter.subscribeViewLifecycle,
      subscribeCdpEvents: transport.subscribeCdpEvents };
    const owner = createBrowserProfilePasskeyAuthenticator({ capture, listViews: broker.listViews });
    const routes = createBrowserDaemonControlRoutes({ broker, importPasskeys: owner.activate });
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {} });
    registerDaemonBrowserControlHandler(rpc, { browserControl: routes });
    const open = (viewId: string) => routes.dispatchCommand({ ...view, viewId, kind: 'openView', commandId: `open-${viewId}`,
      platform: 'web', target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.com/' } });
    try {
      await open(view.viewId);
      await open('sibling');
      const result = await rpc.handleRequest({ method: `machine:${RPC_METHODS.DAEMON_BROWSER_PROFILE_PASSKEYS_APPLY}`,
        params: { ...view, profileId: profile.profileId, credentials: [credential] } });
      expect(result)
        .toMatchObject({ status: 'completed', records: [{ status: 'imported' }] });
      expect(JSON.stringify(result)).not.toContain(key);
      expect(commands.filter(command => command.method === 'WebAuthn.addCredential').map(command => command.targetId))
        .toEqual(['page-1', 'page-2']);
      await open('later');
      await expect.poll(() => nativeCredentials.size).toBe(3);
      await expect.poll(() => commands.filter(command => command.method === 'WebAuthn.addCredential').length).toBe(3);
      // A raw native event contains the key; the activation owner must never publish it.
      notify({ method: 'WebAuthn.credentialAsserted', sessionId: 'cdp-1', params: { authenticatorId: 'auth-1',
        credential: { ...credential, signCount: 0 } } });
      expect(await profileStore.purgeForSessionDeleted({ sessionId: view.browserSessionId }))
        .toMatchObject({ purgedProfileIds: [profile.profileId] });
      await owner.dispose();
      expect(nativeCredentials.size).toBe(0);
      expect(await owner.activate({ ...view, profileId: profile.profileId, credentials: [credential] }))
        .toMatchObject({ status: 'unavailable' });
    } finally { await owner.dispose(); adapter.dispose(); await rm(storageRootDirectory, { recursive: true, force: true }); }
  });
});
