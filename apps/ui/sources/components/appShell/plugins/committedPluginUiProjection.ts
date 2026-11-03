import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginUiTranslationRuntime } from '@/sync/domains/plugins/ui/i18n';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { PluginUiExecutionOriginCandidateFacts } from '@/sync/domains/plugins/ui/projectionUnion';

export type AppShellPluginUiProjectionRead = Readonly<{ scope: ServerAccountScope; declarationsOnly: true }>;

// The app shell's committed plugin UI projection, readable outside React (Actions, settings normalization).
// AppShellPluginUiProjectionValueProvider publishes it. This module imports nothing at runtime, so declaration
// and Action modules can read the projection without importing the app shell.
type CommittedProjectionBinding = Readonly<{
    read(input?: AppShellPluginUiProjectionRead): PluginUiProjectionModel | null;
    readCandidates?: (pluginId: string, input?: AppShellPluginUiProjectionRead) => PluginUiExecutionOriginCandidateFacts | null;
    translationRuntime?: PluginUiTranslationRuntime;
    getVoiceProviderActivation?: (providerId: string) => Promise<void> | null;
    disposeSource(): void;
}>;
let committed: CommittedProjectionBinding | null = null;
const listeners = new Set<() => void>();
const EMPTY_CANDIDATES: PluginUiExecutionOriginCandidateFacts = Object.freeze({
    establishingTargets: Object.freeze([]), sourceCandidates: Object.freeze([]),
    declaredDefaultOrigins: Object.freeze([]), machineRejections: Object.freeze([]), autoPick: true,
});

/** Descriptive facts only: the invocation owner still re-admits their exact origin on every access. */
export function readCurrentAppShellPluginUiExecutionOriginCandidates(pluginId: string, input?: AppShellPluginUiProjectionRead): PluginUiExecutionOriginCandidateFacts {
    return committed?.readCandidates?.(pluginId, input) ?? EMPTY_CANDIDATES;
}

export function subscribeCommittedAppShellPluginUiProjection(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function readCurrentAppShellPluginUiProjection(input?: AppShellPluginUiProjectionRead): PluginUiProjectionModel | null {
    return committed?.read(input) ?? null;
}

/** Imperative consumers borrow the current Account's copy owner; each runtime still checks its exact source. */
export function readCurrentAppShellPluginUiTranslationRuntime(projection: PluginUiProjectionModel | null | undefined,
    input?: AppShellPluginUiProjectionRead): PluginUiTranslationRuntime | null {
    return projection && committed?.read(input) ? committed.translationRuntime ?? null : null;
}

/** Borrows the activation owner's completion; reading it never starts another activation. */
export function getCurrentAppShellVoiceProviderActivation(providerId: string): Promise<void> | null {
    return committed?.getVoiceProviderActivation?.(providerId) ?? null;
}

/** Publishes the committed reader; the returned cleanup clears it only if it is still the current one. */
export function publishCommittedAppShellPluginUiProjection(
    read: (input?: AppShellPluginUiProjectionRead) => PluginUiProjectionModel | null,
    readCandidates?: (pluginId: string, input?: AppShellPluginUiProjectionRead) => PluginUiExecutionOriginCandidateFacts | null,
    subscribe?: (listener: () => void) => () => void,
    translationRuntime?: PluginUiTranslationRuntime,
    getVoiceProviderActivation?: (providerId: string) => Promise<void> | null,
): () => void {
    let unsubscribe: (() => void) | undefined;
    const binding: CommittedProjectionBinding = {
        read,
        readCandidates,
        translationRuntime,
        getVoiceProviderActivation,
        disposeSource() { unsubscribe?.(); unsubscribe = undefined; },
    };
    committed?.disposeSource();
    committed = binding;
    unsubscribe = subscribe?.(() => {
        if (committed !== binding) return;
        for (const listener of listeners) listener();
    });
    for (const listener of listeners) listener();
    return () => {
        binding.disposeSource();
        if (committed !== binding) return;
        committed = null;
        for (const listener of listeners) listener();
    };
}
