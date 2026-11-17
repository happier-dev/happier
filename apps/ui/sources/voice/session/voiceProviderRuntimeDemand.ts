import { getCurrentAppShellVoiceProviderActivation } from '@/components/appShell/plugins/committedPluginUiProjection';
import {
  getExternalVoiceProviderRegistration,
  subscribeExternalVoiceProviderRegistrations,
} from '@/voice/registry/externalVoiceProviderRegistrations';

type RuntimeDemand = Readonly<{
  providerId: string;
  observe(completion: Promise<void>): void;
  reject(error: unknown): void;
}>;

const demands = new Set<RuntimeDemand>();
const listeners = new Set<() => void>();
let providerIds: ReadonlySet<string> = new Set();

function publishProviderIds(): void {
  const next = new Set([...demands].map(demand => demand.providerId));
  if (next.size === providerIds.size && [...next].every(id => providerIds.has(id))) return;
  providerIds = next;
  for (const listener of listeners) listener();
}

export function getVoiceProviderSettingsRuntimeDemand(): ReadonlySet<string> {
  return providerIds;
}

export function subscribeVoiceProviderSettingsRuntimeDemand(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Settings borrow AppShell's exact executable activation and the existing runtime host. */
export function acquireVoiceProviderRuntimeDemand(providerId: string, signal: AbortSignal): Readonly<{
  ready: Promise<void>;
  release(): void;
}> {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const ready = new Promise<void>((accept, refuse) => { resolve = accept; reject = refuse; });
  // Cancellation can happen before the admitting Action starts awaiting readiness.
  void ready.catch(() => {});
  let settled = false;
  let released = false;
  let unsubscribe: (() => void) | undefined;
  const settle = (error?: unknown) => {
    if (settled) return;
    settled = true;
    unsubscribe?.();
    if (error === undefined) resolve();
    else reject(error);
  };
  const readReady = () => {
    const registration = getExternalVoiceProviderRegistration(providerId);
    if (registration?.occurrenceId && (registration.settingsActions || registration.settingsOperations?.listCatalog)) {
      settle();
      return true;
    }
    return false;
  };
  const demand: RuntimeDemand = {
    providerId,
    observe(completion) {
      void completion.then(() => {
        if (!readReady()) settle(Object.assign(new Error('provider_unavailable'), {
          code: 'provider_unavailable',
        }));
      }, settle);
    },
    reject: settle,
  };
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener('abort', abort);
    unsubscribe?.();
    demands.delete(demand);
    publishProviderIds();
    settle(Object.assign(new Error('plugin_settings_action_cancelled'), {
      name: 'AbortError', code: 'plugin_settings_action_cancelled',
    }));
  };
  const abort = () => release();
  demands.add(demand);
  unsubscribe = subscribeExternalVoiceProviderRegistrations(readReady);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) release();
  else {
    readReady();
    const completion = getCurrentAppShellVoiceProviderActivation(providerId);
    if (completion) demand.observe(completion);
    publishProviderIds();
  }
  return { ready, release };
}

/** AppShell lends its existing completion; this owner never activates a module. */
export function bindVoiceProviderRuntimeDemandActivation(ids: ReadonlySet<string>, completion: Promise<void>): void {
  for (const demand of demands) if (ids.has(demand.providerId)) demand.observe(completion);
}

export function rejectVoiceProviderRuntimeDemands(error: unknown, ids?: ReadonlySet<string>): void {
  for (const demand of demands) if (!ids || ids.has(demand.providerId)) demand.reject(error);
}
