import { createPrivateKey } from 'node:crypto';
import type { BrowserProfileLoginsImportResultV1, BrowserLoginImportFailureCodeV1 } from '@happier-dev/protocol/browser/profile/v1';
import type { SavedSecretPasskeySourceV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import type { BrowserSidecarContextCaptureSurface, BrowserSidecarCdpPageHandle } from '../sidecar/controlAdapter';

type View = Readonly<{ browserSessionId: string; viewId: string }>;
type Authenticator = Readonly<{ page: BrowserSidecarCdpPageHandle; view: View; profileId: string;
  authenticatorId: string; credentialIds: Set<string> }>;
export type BrowserProfilePasskeyActivation = View & Readonly<{ profileId: string;
  credentials: readonly SavedSecretPasskeySourceV1[]; signal?: AbortSignal }>;

export function createBrowserProfilePasskeyAuthenticator(input: Readonly<{
  capture: BrowserSidecarContextCaptureSurface;
  listViews?: (browserSessionId: string) => readonly View[];
}>) {
  // Only native handles and public selection metadata survive an operation. Chromium owns keys.
  const authenticators = new Map<string, Authenticator>();
  let disposed = false;
  const dispatch = (page: BrowserSidecarCdpPageHandle, method: string, params?: Record<string, unknown>, signal?: AbortSignal) =>
    input.capture.transport.dispatchPageCommand({ ...page, method, params, ...(signal ? { signal } : {}) });

  async function ensureAuthenticator(view: View, profileId: string, page: BrowserSidecarCdpPageHandle, signal?: AbortSignal) {
    const existing = authenticators.get(page.targetId);
    if (existing) return existing;
    await dispatch(page, 'WebAuthn.enable', { enableUI: false }, signal);
    const response = await dispatch(page, 'WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true,
      // Q-PASSKEY: shared Action admission carries the person's confirmation or Allow policy.
      // This software presence/verification is never a biometric assertion.
      automaticPresenceSimulation: true, isUserVerified: true,
    } }, signal);
    if (!response || typeof response !== 'object' || !('authenticatorId' in response) || typeof response.authenticatorId !== 'string') {
      throw new Error('Native authenticator unavailable');
    }
    const authenticator: Authenticator = { page, view: { browserSessionId: view.browserSessionId, viewId: view.viewId },
      profileId, authenticatorId: response.authenticatorId, credentialIds: new Set() };
    if (disposed || input.capture.resolvePageHandle(view)?.targetId !== page.targetId) {
      await dispatch(page, 'WebAuthn.removeVirtualAuthenticator', { authenticatorId: authenticator.authenticatorId });
      throw new Error('Browser view closed');
    }
    authenticators.set(page.targetId, authenticator);
    return authenticator;
  }

  async function copyToBoundView(view: View): Promise<void> {
    const page = input.capture.resolvePageHandle(view);
    const profile = input.capture.resolveProfile?.(view);
    if (disposed || !page || !profile || profile.lifecycleState !== 'active' || authenticators.has(page.targetId)) return;
    const source = [...authenticators.values()].find(candidate => candidate.profileId === profile.profileId && candidate.credentialIds.size > 0);
    if (!source) return;
    const response = await dispatch(source.page, 'WebAuthn.getCredentials', { authenticatorId: source.authenticatorId });
    if (!response || typeof response !== 'object' || !('credentials' in response) || !Array.isArray(response.credentials)) return;
    const selected = response.credentials.filter((value: unknown): value is Record<string, unknown> =>
      !!value && typeof value === 'object' && 'credentialId' in value && typeof value.credentialId === 'string'
      && source.credentialIds.has(value.credentialId));
    if (!selected.length) return;
    const destination = await ensureAuthenticator(view, profile.profileId, page);
    for (const credential of selected) {
      // Native key material goes straight back into the same profile's native boundary. It is
      // never retained in a JS store, emitted as an event, logged or returned.
      await dispatch(page, 'WebAuthn.addCredential', { authenticatorId: destination.authenticatorId,
        credential: { ...credential, signCount: -1 } });
      destination.credentialIds.add(String(credential.credentialId));
    }
  }
  const unsubscribe = input.capture.subscribeViewLifecycle?.(event => {
    if (event.type === 'bound') {
      // Native clone failure is recoverable through explicit import in the affected view.
      void copyToBoundView(event).catch(() => {});
    } else {
      for (const [targetId, authenticator] of authenticators) {
        if (authenticator.view.browserSessionId === event.browserSessionId && authenticator.view.viewId === event.viewId) {
          authenticators.delete(targetId);
          void dispatch(authenticator.page, 'WebAuthn.removeVirtualAuthenticator', { authenticatorId: authenticator.authenticatorId }).catch(() => {});
        }
      }
    }
  });

  return {
    async activate(request: BrowserProfilePasskeyActivation): Promise<BrowserProfileLoginsImportResultV1> {
      if (request.signal?.aborted) return { status: 'unavailable', code: 'canceled' };
      if (disposed) return { status: 'unavailable', code: 'destination_unavailable' };
      const profile = input.capture.resolveProfile?.(request);
      if (profile?.profileId !== request.profileId || profile.lifecycleState !== 'active') return { status: 'unavailable', code: 'profile_mismatch' };
      const page = input.capture.resolvePageHandle(request);
      if (!page) return { status: 'unavailable', code: 'destination_unavailable' };
      const targets = new Map<string, Readonly<{ view: View; page: BrowserSidecarCdpPageHandle }>>([[page.targetId, { view: request, page }]]);
      for (const view of input.listViews?.(request.browserSessionId) ?? []) {
        const candidate = input.capture.resolvePageHandle(view);
        if (candidate && input.capture.resolveProfile?.(view)?.profileId === request.profileId) targets.set(candidate.targetId, { view, page: candidate });
      }
      const records: Extract<BrowserProfileLoginsImportResultV1, { status: 'completed' }>['records'] = [];
      for (const credential of request.credentials) {
        const metadata = { domain: credential.rpId, name: credential.credentialId };
        if (request.signal?.aborted) {
          records.push({ ...metadata, status: 'skipped', code: 'canceled' });
          continue;
        }
        // RU2 accepted limitation: counter-tracking credentials remain usable through normal
        // sign-in. Never reset their counter or create native activation as a partial fallback.
        if (credential.signCount !== 0) {
          records.push({ ...metadata, status: 'failed', code: 'source_format_unsupported',
            reason: 'this passkey tracks a usage counter' });
          continue;
        }
        try {
          const key = createPrivateKey({ key: Buffer.from(credential.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
          if (credential.algorithm !== -7 || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('unsupported');
        } catch {
          records.push({ ...metadata, status: 'failed', code: 'source_format_unsupported' });
          continue;
        }
        let failureCode: BrowserLoginImportFailureCodeV1 | undefined;
        try {
          for (const target of targets.values()) {
            const authenticator = await ensureAuthenticator(target.view, request.profileId, target.page, request.signal).catch(() => null);
            if (!authenticator) {
              failureCode = request.signal?.aborted ? 'canceled' : 'engine_unsupported';
              break;
            }
            if (authenticator.credentialIds.has(credential.credentialId)) {
              await dispatch(target.page, 'WebAuthn.removeCredential', { authenticatorId: authenticator.authenticatorId,
                credentialId: credential.credentialId }, request.signal);
              authenticator.credentialIds.delete(credential.credentialId);
            }
            const { kind: _kind, algorithm: _algorithm, ...material } = credential;
            await dispatch(target.page, 'WebAuthn.addCredential', { authenticatorId: authenticator.authenticatorId,
              credential: { ...material, isResidentCredential: true, signCount: -1 } }, request.signal);
            authenticator.credentialIds.add(credential.credentialId);
          }
        } catch {
          // A canceled/dropped CDP reply cannot prove whether a native key mutation happened.
          failureCode = 'import_unknown';
        }
        records.push(failureCode ? { ...metadata, status: 'failed', code: failureCode } : { ...metadata, status: 'imported' });
      }
      return { status: 'completed', records };
    },
    async dispose(): Promise<void> {
      disposed = true;
      unsubscribe?.();
      const active = [...authenticators.values()];
      authenticators.clear();
      // A removal failure cannot skip other views; the containing adapter then closes Chromium.
      await Promise.allSettled(active.map(({ page, authenticatorId }) => dispatch(page,
        'WebAuthn.removeVirtualAuthenticator', { authenticatorId })));
    },
  };
}
