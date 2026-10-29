import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import type { AccountEncryptionIdentity } from '@happier-dev/sync-client';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { acquireRequesterAccountEncryptionCurrentness, waitForObservation,
  sameRequesterAccountEncryptionCurrentness, type RequesterAccountSettingsObservation } from '@/api/client/accountEncryptionCurrentnessObservation';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { applyAccountSettingsV2Update, bootstrapAccountSettingsContext } from './bootstrapAccountSettingsContext';
import { normalizeAccountSettingsVersionHint } from './accountSettingsVersion';

/** Settings belongs to the captured Account/Home lifetime, independently of catalog demand. */
export function createRequesterAccountSettingsPublication(input: Readonly<{
  observation: ReturnType<typeof acquireRequesterAccountEncryptionCurrentness>;
  currentness: AccountEncryptionIdentity;
  operationContext: SavedSecretOperationContextV1;
}>) {
  const context = input.operationContext;
  const listeners = new Set<() => void>();
  const retirement = new AbortController();
  let publication = new AbortController();
  let highestVersion = context.readSnapshot()?.settingsVersion ?? 0;
  let needsFreshSettingsWitness = false;
  let ready = true;
  let pending: Promise<boolean | Readonly<{ error: unknown }>> | null = null;
  const invalidate = () => { publication.abort(); publication = new AbortController(); ready = false; pending = null; };
  const observe = (event: RequesterAccountSettingsObservation, reobserve = false) => {
    if (retirement.signal.aborted) return;
    if (event.kind === 'disconnected') { needsFreshSettingsWitness = true; invalidate(); return; }
    const update = event.kind === 'settings' ? AccountSettingsV2GetResponseSchema.safeParse(event.update) : null;
    highestVersion = Math.max(highestVersion, context.readSnapshot()?.settingsVersion ?? 0);
    const version = normalizeAccountSettingsVersionHint(update?.success ? update.data.version
      : event.kind === 'hint' ? event.version : undefined);
    if (version !== null) {
      if (version < highestVersion || !reobserve && ready && version === highestVersion) return;
      highestVersion = version;
    } else if (event.kind !== 'reconnected') { needsFreshSettingsWitness = true; invalidate(); return; }
    if (event.kind === 'reconnected') needsFreshSettingsWitness = true;
    invalidate();
    if (update && !update.success) return;
    const captured = publication;
    const current = () => !retirement.signal.aborted && !captured.signal.aborted && publication === captured;
    pending = (async () => {
      const fact = await input.observation.read(captured.signal);
      if (!current()) return false;
      if (!update?.success && needsFreshSettingsWitness) {
        // Missing Settings publication is recovered from a fresh Home witness,
        // never from the cursor of an otherwise unchanged socket identity.
        const witness = await fetchAccountEncryptionCurrentness({ token: context.credentials.token,
          serverBaseUrl: context.serverHttpBaseUrl, signal: captured.signal });
        if (!current() || !sameRequesterAccountEncryptionCurrentness(witness, fact)) return false;
        highestVersion = Math.max(highestVersion, witness.settingsVersion ?? highestVersion);
      }
      const next = await runWithServerHttpBaseUrl(context.serverHttpBaseUrl, () => update?.success
        ? applyAccountSettingsV2Update({ credentials: context.credentials, update: update.data,
          publication: 'invocation', expectedAccountEncryptionMode: fact.mode, shouldCommit: current })
        : bootstrapAccountSettingsContext({ credentials: context.credentials, mode: 'blocking', refresh: 'force',
          caller: 'requester_settings_recovery',
          publication: 'invocation', expectedAccountEncryptionMode: fact.mode, honorAccountSettingsModeEnv: false, signal: captured.signal,
          minSettingsVersion: highestVersion, shouldCommit: current }));
      if (!current() || next.source !== 'network' || next.settingsVersion < highestVersion
        || !await context.replaceAccountSettings(next) || !current()) return false;
      highestVersion = next.settingsVersion;
      needsFreshSettingsWitness = false;
      ready = true;
      for (const listener of listeners) listener();
      return true;
    })().catch(error => ({ error }));
  };
  const unsubscribe = input.observation.subscribeAccountSettings(observe);
  const ensureCurrent = async (signal?: AbortSignal): Promise<boolean> => {
    if (signal?.aborted || retirement.signal.aborted) return false;
    const readerSignal = signal ? AbortSignal.any([signal, retirement.signal]) : retirement.signal;
    try {
      if (!ready && !pending) observe({ kind: 'hint', version: highestVersion }, true);
      let observed: typeof pending;
      let outcome: Awaited<NonNullable<typeof pending>> | undefined;
      do {
        observed = pending;
        outcome = observed ? await waitForObservation(observed, readerSignal) : undefined;
      } while (observed !== pending);
      if (outcome && typeof outcome === 'object') {
        if (pending === observed) pending = null;
        throw outcome.error;
      }
      // This fence owns Settings publication, not fresh Session/Machine
      // admission. Warm readers consume the already observed Account fact;
      // effects retain their distinct requester authority guard.
      const current = input.observation.isCurrent(input.currentness)
        || sameRequesterAccountEncryptionCurrentness(await input.observation.read(readerSignal), input.currentness);
      return !readerSignal.aborted && ready && context.readSnapshot() !== null && current;
    } catch (error) { if (readerSignal.aborted) return false; throw error; }
  };
  return Object.freeze({
    ensureCurrent,
    async refresh(minSettingsVersion?: number, signal?: AbortSignal): Promise<boolean> {
      const minimum = normalizeAccountSettingsVersionHint(minSettingsVersion) ?? 0;
      if (await ensureCurrent(signal) && (context.readSnapshot()?.settingsVersion ?? -1) >= minimum) return true;
      if (signal?.aborted || retirement.signal.aborted || !context.readSnapshot()) return false;
      observe({ kind: 'hint', version: Math.max(highestVersion, minimum) }, true);
      return await ensureCurrent(signal);
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { retirement.abort(); invalidate(); unsubscribe(); listeners.clear(); },
  });
}
