import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginUiTranslationRuntime } from '@/sync/domains/plugins/ui/i18n';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { PluginUiExecutionOriginCandidateFacts } from '@/sync/domains/plugins/ui/projectionUnion';

import type { PluginUiClientActionAdmissionSource } from '@/components/plugins/reactNative/clientActionAdmission';

export type AppShellPluginUiProjectionRead = Readonly<{ scope: ServerAccountScope; declarationsOnly: true }>;

// The app shell's committed plugin UI projection, readable outside React (Actions, settings normalization).
// AppShellPluginUiProjectionValueProvider publishes it. This module imports nothing at runtime, so declaration
// and Action modules can read the projection without importing the app shell.
type CommittedProjectionBinding = Readonly<{
    read(input?: AppShellPluginUiProjectionRead): PluginUiProjectionModel | null;
    readCandidates?: (pluginId: string, input?: AppShellPluginUiProjectionRead) => PluginUiExecutionOriginCandidateFacts | null;
    acquireCandidates?: (pluginId: string) => () => void;
    translationRuntime?: PluginUiTranslationRuntime;
    getVoiceProviderActivation?: (providerId: string) => Promise<void> | null;
    readDeclarationsPending?: (input: AppShellPluginUiProjectionRead) => boolean;
    readRegistrySourcesPending?: (input?: AppShellPluginUiProjectionRead) => boolean;
    readExecutionOriginSelectionPending?: (pluginId: string, input: AppShellPluginUiProjectionRead) => boolean;
    clientActionAdmission?: PluginUiClientActionAdmissionSource;
    disposeSource(): void;
}>;
let committed: CommittedProjectionBinding | null = null;
const listeners = new Set<() => void>();
export const EMPTY_PLUGIN_UI_EXECUTION_ORIGIN_CANDIDATES: PluginUiExecutionOriginCandidateFacts = Object.freeze({
    establishingTargets: Object.freeze([]), sourceCandidates: Object.freeze([]),
    declaredDefaultOrigins: Object.freeze([]), machineRejections: Object.freeze([]), autoPick: true,
});

/** Descriptive facts only: the invocation owner still re-admits their exact origin on every access. */
export function readCurrentAppShellPluginUiExecutionOriginCandidates(pluginId: string, input?: AppShellPluginUiProjectionRead): PluginUiExecutionOriginCandidateFacts {
    return committed?.readCandidates?.(pluginId, input) ?? EMPTY_PLUGIN_UI_EXECUTION_ORIGIN_CANDIDATES;
}

export function subscribeCommittedAppShellPluginUiProjection(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** A mounted reader follows only its plugin's facts and holds its demand for this binding. */
export function subscribeCommittedAppShellPluginUiExecutionOriginCandidates(pluginId: string, listener: () => void): () => void {
    let binding: CommittedProjectionBinding | null = null;
    let release: (() => void) | undefined;
    let facts = readCurrentAppShellPluginUiExecutionOriginCandidates(pluginId);
    const update = () => {
        if (binding !== committed) {
            binding = committed;
            release?.();
            release = binding?.acquireCandidates?.(pluginId);
        }
        const next = readCurrentAppShellPluginUiExecutionOriginCandidates(pluginId);
        if (facts === next) return;
        facts = next;
        listener();
    };
    listeners.add(update);
    update();
    return () => {
        if (listeners.delete(update)) release?.();
    };
}

export function readCurrentAppShellPluginUiProjection(input?: AppShellPluginUiProjectionRead): PluginUiProjectionModel | null {
    return committed?.read(input) ?? null;
}

/** Administration owns whether this plugin's selected source is still being discovered. */
export function readCurrentAppShellPluginUiExecutionOriginSelectionPending(pluginId: string, input: AppShellPluginUiProjectionRead): boolean {
    return committed?.readExecutionOriginSelectionPending?.(pluginId, input) ?? false;
}

/** Whether the current Account is still establishing its contributed UI declarations. */
export function readCurrentAppShellDeclarationsPending(input: AppShellPluginUiProjectionRead): boolean {
    return committed?.readDeclarationsPending?.(input) ?? false;
}

/** The publication's fact that a registry source may still arrive; without a published app shell nothing will. */
export function readCurrentAppShellRegistrySourcesPending(input?: AppShellPluginUiProjectionRead): boolean {
    return committed?.readRegistrySourcesPending?.(input) ?? false;
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

/** Borrow the same readiness source as the mounted Action port. */
export function readCommittedAppShellClientActionAdmission(): PluginUiClientActionAdmissionSource | undefined {
    return committed?.clientActionAdmission;
}

/** Publishes the committed reader; the returned cleanup clears it only if it is still the current one. */
export function publishCommittedAppShellPluginUiProjection(
    read: (input?: AppShellPluginUiProjectionRead) => PluginUiProjectionModel | null,
    readCandidates?: (pluginId: string, input?: AppShellPluginUiProjectionRead) => PluginUiExecutionOriginCandidateFacts | null,
    subscribe?: (listener: () => void) => () => void,
    translationRuntime?: PluginUiTranslationRuntime,
    getVoiceProviderActivation?: (providerId: string) => Promise<void> | null,
    readRegistrySourcesPending?: (input?: AppShellPluginUiProjectionRead) => boolean,
    acquireCandidates?: (pluginId: string) => () => void,
    readExecutionOriginSelectionPending?: (pluginId: string, input: AppShellPluginUiProjectionRead) => boolean,
    readDeclarationsPending?: (input: AppShellPluginUiProjectionRead) => boolean,
    clientActionAdmission?: PluginUiClientActionAdmissionSource,
): () => void {
    let unsubscribe: (() => void) | undefined;
    const binding: CommittedProjectionBinding = {
        read,
        readCandidates,
        acquireCandidates,
        translationRuntime,
        getVoiceProviderActivation,
        readDeclarationsPending,
        readRegistrySourcesPending,
        readExecutionOriginSelectionPending,
        clientActionAdmission,
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
