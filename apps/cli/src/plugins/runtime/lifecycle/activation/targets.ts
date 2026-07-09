import type { PluginSourceSpecV1 } from '@happier-dev/protocol';

import type {
    ResolvedContributionRegistry,
    ResolvedContributionProvenance,
    ResolvedContributionSource,
} from '../../../projection/registry/types';

/**
 * Activation targets: the deduplicated set of (plugin, daemon entry) pairs
 * derived from a resolved contribution registry, plus the helpers used to
 * collect them and decide when they should activate.
 */

export type ActivationTarget = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    activationEvents?: readonly string[];
}>;

export function addActivationTarget(targets: Map<string, ActivationTarget>, raw: Readonly<{
    provenance?: ResolvedContributionProvenance;
    source?: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    activationEvents?: readonly string[];
}>): void {
    if (!raw.pluginId || !raw.manifestPath || !raw.manifestDigest || !raw.daemonEntryPath) {
        return;
    }
    const key = `${raw.pluginId}::${raw.daemonEntryPath}`;
    if (targets.has(key)) {
        return;
    }
    targets.set(key, {
        provenance: raw.provenance ?? 'external',
        source: raw.source ?? { kind: raw.sourceSpec?.kind ?? 'path' },
        pluginId: raw.pluginId,
        manifestPath: raw.manifestPath,
        manifestDigest: raw.manifestDigest,
        daemonEntryPath: raw.daemonEntryPath,
        devDaemonEntryPath: raw.devDaemonEntryPath ?? null,
        sourceSpec: raw.sourceSpec,
        ...(raw.activationEvents ? { activationEvents: raw.activationEvents } : {}),
    });
}

export function collectActivationTargets(contributes: ResolvedContributionRegistry): readonly ActivationTarget[] {
    const targets = new Map<string, ActivationTarget>();
    for (const target of contributes.activationTargets) {
        addActivationTarget(targets, target);
    }
    for (const provider of contributes.agents) {
        addActivationTarget(targets, provider);
    }
    for (const backend of contributes.agentRuntimes) {
        addActivationTarget(targets, backend);
    }
    for (const action of contributes.actions) {
        addActivationTarget(targets, action);
    }
    for (const tool of contributes.tools ?? []) {
        addActivationTarget(targets, tool);
    }
    for (const command of contributes.commands ?? []) {
        addActivationTarget(targets, command);
    }
    for (const hookRegistration of contributes.hookRegistrations) {
        addActivationTarget(targets, hookRegistration);
    }
    for (const lifecycleHandler of contributes.lifecycleHandlers ?? []) {
        addActivationTarget(targets, lifecycleHandler);
    }
    return Object.freeze([...targets.values()]);
}

export function shouldActivateTargetAtStartup(target: ActivationTarget): boolean {
    return target.activationEvents === undefined || target.activationEvents.includes('startup');
}

export function activationTargetMatchesEvent(target: ActivationTarget, activationEvent: string): boolean {
    return target.activationEvents?.includes(activationEvent) === true;
}
