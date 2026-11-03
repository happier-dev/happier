import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { uiBrowserAutomationDispatchMethod } from '@happier-dev/protocol/browser/automation/reverseDispatchV1';
import type { BrowserSidecarContextCaptureSurface } from '../sidecar/controlAdapter';
import { createBrowserProfilePasskeyAuthenticator } from './passkeys';
import { createBrowserProfilePasskeyImporter } from './importPasskeys';

const credential = { kind: 'passkey' as const, rpId: 'example.test', credentialId: 'AQID', userHandle: 'BAUG',
  privateKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  algorithm: -7 as const, signCount: 0, backupEligibility: true, backupState: true };
const request = { browserSessionId: 'session', viewId: 'view', profileId: 'profile', credentials: [credential] };

describe('managed and native profile passkey routing', () => {
  it.each(['passkey_import_unavailable', 'engine_unsupported', 'profile_mismatch', 'destination_unavailable'] as const)(
    'preserves native %s without sending key material to the native renderer', async code => {
      const nativeRequests: unknown[] = [];
      const apply = createBrowserProfilePasskeyImporter(undefined, { getNativeClient: () => ({
        callConnectedClientRpc: async (method, input, options) => {
          expect(method).toBe(uiBrowserAutomationDispatchMethod(request));
          expect(options?.answeringClient).toEqual({ requireSingle: true });
          expect(options?.timeoutMs).toBeNull();
          nativeRequests.push(input);
          return { ok: true, result: { status: 'unavailable', code } };
        },
      }) });
      expect(await apply(request)).toEqual({ status: 'unavailable', code });
      expect(nativeRequests).toEqual([{ ...request, credentials: [] }]);
      expect(JSON.stringify(nativeRequests)).not.toContain(credential.privateKey);
    },
  );

  it('keeps managed import and profile rejection with the managed authenticator', async () => {
    const commands: { method: string; params?: Record<string, unknown> }[] = [];
    const capture: BrowserSidecarContextCaptureSurface = {
      resolvePageHandle: () => ({ targetId: 'target', sessionId: 'cdp' }),
      resolveProfile: () => ({ profileId: 'profile', storageMode: 'ephemeral', lifecycleState: 'active',
        owner: { kind: 'session', id: 'session' }, cleanupOnSessionClose: true }),
      transport: { dispatchPageCommand: async command => {
        commands.push(command);
        return command.method === 'WebAuthn.addVirtualAuthenticator' ? { authenticatorId: 'auth' } : {};
      } },
    };
    const owner = createBrowserProfilePasskeyAuthenticator({ capture });
    let nativeCalls = 0;
    const apply = createBrowserProfilePasskeyImporter(capture, { activateManaged: owner.activate,
      getNativeClient: () => ({ callConnectedClientRpc: async () => { nativeCalls++; return { ok: false }; } }) });
    expect(await apply({ ...request, credentials: [] })).toEqual({ status: 'completed', records: [] });
    expect(commands).toEqual([]);
    expect(await apply({ ...request, profileId: 'other' })).toEqual({ status: 'unavailable', code: 'profile_mismatch' });
    expect(await apply(request)).toMatchObject({ status: 'completed', records: [{ status: 'imported' }] });
    expect(commands.find(command => command.method === 'WebAuthn.addCredential')?.params)
      .toMatchObject({ credential: { privateKey: credential.privateKey } });
    expect(nativeCalls).toBe(0);
    await owner.dispose();
  });

  it('settles unavailable, canceled and malformed native responses without retry or key disclosure', async () => {
    expect(await createBrowserProfilePasskeyImporter(undefined)(request))
      .toEqual({ status: 'unavailable', code: 'destination_unavailable' });
    let calls = 0;
    const apply = createBrowserProfilePasskeyImporter(undefined, { getNativeClient: () => ({
      callConnectedClientRpc: async () => { calls++; throw new Error(credential.privateKey); },
    }) });
    const canceled = new AbortController(); canceled.abort();
    expect(await apply(request, canceled.signal)).toEqual({ status: 'unavailable', code: 'canceled' });
    expect(calls).toBe(0);
    expect(await apply(request)).toEqual({ status: 'unavailable', code: 'destination_unavailable' });
    expect(calls).toBe(1);
    const completed = createBrowserProfilePasskeyImporter(undefined, { getNativeClient: () => ({
      callConnectedClientRpc: async () => ({ ok: true, result: { status: 'completed', records: [] } }),
    }) });
    expect(await completed(request)).toEqual({ status: 'unavailable', code: 'passkey_import_unavailable' });
  });
});
