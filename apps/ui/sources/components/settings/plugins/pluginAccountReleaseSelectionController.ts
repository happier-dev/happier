import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginAccountAdministrationActionOutputSchemas as outputs,
    type PluginAccountAdministrationActionId } from '@happier-dev/protocol/actions/pluginAccountAdministrationActionFamily';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import {
    readActivePluginAccountRelease,
} from '@/sync/api/plugins/availability/activePluginAccountReleaseRead';
import { setActivePluginAccountAvailabilityIntent } from '@/sync/api/plugins/availability/setActivePluginAccountAvailabilityIntent';
import { removeActivePluginAccountHostedArtifact } from '@/sync/api/plugins/availability/removeActivePluginAccountHostedArtifact';
import { removeActivePluginAccountPackageAssets } from '@/sync/api/plugins/availability/removeActivePluginAccountPackageAssets';
import { getInstalledPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import {
    createBundledPluginUiAppExactArtifactSource,
} from '@/sync/domains/plugins/availability/bundledAppExactArtifactSource';
import {
    resolveCandidatePluginCollectionMigrationArtifactAccountHostedTarget,
} from '@/sync/domains/plugins/availability/candidateCollectionMigrationArtifact';
import {
    resolveCandidateCollectionReleaseExecution,
} from '@/sync/domains/plugins/availability/candidateCollectionReleaseExecution';
import {
    createDaemonCandidateCollectionReleasePreparation,
} from '@/sync/domains/plugins/availability/daemonCandidateCollectionPreparation';
import {
    selectCandidateCollectionRelease,
    type CandidateCollectionReleaseSelectionResult,
    type CandidateCollectionReleaseSelectionTarget,
} from '@/sync/domains/plugins/availability/candidateCollectionReleaseSelection';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    classifyPluginAccountHostedArtifactStatus,
    type PluginAccountHostedArtifactStatus,
} from './pluginAccountHostedArtifactStatus';

export type PluginAccountReleaseSelectionControllerDependencies = Readonly<{
    captureLifetime: () => ActiveServerAccountScopeLifetime | null;
    readRelease: typeof readActivePluginAccountRelease;
    resolveExecution: typeof resolveCandidateCollectionReleaseExecution;
    resolveAccountHostedTarget: typeof resolveCandidatePluginCollectionMigrationArtifactAccountHostedTarget;
    createAppExactSource: typeof createBundledPluginUiAppExactArtifactSource;
    select: typeof selectCandidateCollectionRelease;
    setIntent: typeof setActivePluginAccountAvailabilityIntent;
    removeHostedArtifact: typeof removeActivePluginAccountHostedArtifact;
    removePackageAssets: typeof removeActivePluginAccountPackageAssets;
    removeCachedArtifact: ReturnType<typeof getInstalledPluginReactNativeBundleCache>['removePersistentArtifact'];
}>;

export type PluginAccountReleaseSelectionControllerResult =
    | CandidateCollectionReleaseSelectionResult
    | Readonly<{
        kind: 'unavailable';
        code: 'target_release_unavailable';
    }>;

export type PluginAccountReleaseSelectionController = Readonly<{
    select: (input: Readonly<{
        pluginId: string;
        /** UI coordinate only; Availability validates and returns exact release facts. */
        version: string;
        reader: PluginAccountAvailabilityReader | null;
        /** Current raw daemon projection, never marketplace metadata. */
        projection: PluginProjectionV2 | null;
        daemon: Readonly<{
            serverId: string | null;
            serverIdentityId: string | null;
            machineId: string | null;
        }>;
        /** Component-owned presentation lifetime, distinct from Account lifetime. */
        isCurrent?: () => boolean;
    }>) => Promise<PluginAccountReleaseSelectionControllerResult>;
    readHostedArtifactStatus: (input: Readonly<{
        pluginId: string;
        reader: PluginAccountAvailabilityReader | null;
    }>) => PluginAccountHostedArtifactStatus;
    setHostedArtifactsEnabled: (input: Readonly<{
        pluginId: string;
        reader: PluginAccountAvailabilityReader | null;
        enabled: boolean;
    }>) => Promise<Readonly<{ kind: 'updated' | 'conflict' | 'unavailable' }>>;
    disableAndRemoveHostedArtifacts: (input: Readonly<{
        pluginId: string;
        reader: PluginAccountAvailabilityReader | null;
    }>) => Promise<Readonly<{ kind: 'updated' | 'conflict' | 'unavailable' }>>;
    clearHostedArtifactCache: (input: Readonly<{
        pluginId: string;
        reader: PluginAccountAvailabilityReader | null;
    }>) => Promise<Readonly<{ kind: 'updated' | 'unavailable' }>>;
    retire: () => void;
    isPending: () => boolean;
}>;

type DirectUiTargetPreparationInput = Parameters<Extract<
    NonNullable<CandidateCollectionReleaseSelectionTarget['preparation']>,
    Readonly<{ kind: 'direct-ui-target' }>
>['resolve']>[0];

const defaultDependencies: PluginAccountReleaseSelectionControllerDependencies = Object.freeze({
    captureLifetime: captureActiveServerAccountScopeLifetime,
    readRelease: readActivePluginAccountRelease,
    resolveExecution: resolveCandidateCollectionReleaseExecution,
    resolveAccountHostedTarget: resolveCandidatePluginCollectionMigrationArtifactAccountHostedTarget,
    createAppExactSource: createBundledPluginUiAppExactArtifactSource,
    select: selectCandidateCollectionRelease,
    setIntent: setActivePluginAccountAvailabilityIntent,
    removeHostedArtifact: removeActivePluginAccountHostedArtifact,
    removePackageAssets: removeActivePluginAccountPackageAssets,
    removeCachedArtifact: (identity, isCurrent) => getInstalledPluginReactNativeBundleCache().removePersistentArtifact(identity, isCurrent),
});

function readHostedAdministration(input: Readonly<{
    reader: PluginAccountAvailabilityReader | null;
    pluginId: string;
}>) {
    if (!input.reader) return null;
    try {
        const selected = input.reader.readCurrentHostedArtifactAdministration({ pluginId: input.pluginId });
        return selected.kind === 'available' ? selected : null;
    } catch {
        return null;
    }
}

function currentIntent(input: Readonly<{
    reader: PluginAccountAvailabilityReader | null;
    pluginId: string;
}>): Readonly<{
    expectedRevision: string | null;
    offlineUiHosting: 'enabled' | 'disabled';
}> {
    if (!input.reader) {
        return Object.freeze({ expectedRevision: null, offlineUiHosting: 'disabled' as const });
    }
    try {
        // Selecting a release also replaces retained unselected intents. Their
        // CAS revision is Account administration state, not release admission.
        const census = input.reader.readMaterializations();
        const reads = census.kind === 'available'
            ? census.intentReads.filter(read => read.pluginId === input.pluginId) : [];
        const intent = reads.length === 1 ? reads[0]!.response.intent : null;
        if (intent?.pluginId !== input.pluginId) {
            return Object.freeze({ expectedRevision: null, offlineUiHosting: 'disabled' as const });
        }
        return Object.freeze({
            expectedRevision: intent.revision,
            offlineUiHosting: intent.offlineUiHosting,
        });
    } catch {
        return Object.freeze({ expectedRevision: null, offlineUiHosting: 'disabled' as const });
    }
}

/**
 * Present-user Account release-selection adapter. Availability remains the
 * release and CAS owner; Artifact/Data preparation remains downstream and is
 * passed only as a lazy, exact source for its typed preparation-required path.
 */
export function createPluginAccountReleaseAdministration(
    overrides: Partial<PluginAccountReleaseSelectionControllerDependencies> = {},
): PluginAccountReleaseSelectionController {
    const dependencies = { ...defaultDependencies, ...overrides };
    let retired = false;
    let activeAction: object | null = null;

    const select = async (
        input: Parameters<PluginAccountReleaseSelectionController['select']>[0],
    ): Promise<PluginAccountReleaseSelectionControllerResult> => {
        if (retired || activeAction) return Object.freeze({ kind: 'cancelled' as const });
        const accountLifetime = dependencies.captureLifetime();
        if (!accountLifetime?.isCurrent()) {
            return Object.freeze({ kind: 'unavailable' as const, code: 'target_release_unavailable' as const });
        }
        const action = {};
        activeAction = action;
        const actionIsCurrent = (): boolean => {
            try {
                return !retired
                    && activeAction === action
                    && accountLifetime.isCurrent()
                    && (input.isCurrent?.() ?? true);
            } catch {
                return false;
            }
        };

        try {
            if (!actionIsCurrent()) return Object.freeze({ kind: 'cancelled' as const });
            const targetRelease = await dependencies.readRelease({
                release: { pluginId: input.pluginId, version: input.version },
            });
            if (!actionIsCurrent()) return Object.freeze({ kind: 'cancelled' as const });
            if (targetRelease.kind !== 'available') {
                return Object.freeze({ kind: 'unavailable' as const, code: 'target_release_unavailable' as const });
            }

            const execution = dependencies.resolveExecution({
                target: {
                    availabilityCursor: targetRelease.availabilityCursor,
                    facts: targetRelease.facts,
                },
                projection: input.projection,
                reader: input.reader,
                accountLifetime,
                daemon: input.daemon,
                isCurrent: actionIsCurrent,
            });
            if (!actionIsCurrent()) return Object.freeze({ kind: 'cancelled' as const });

            const priorIntent = currentIntent({ reader: input.reader, pluginId: input.pluginId });
            const target: CandidateCollectionReleaseSelectionTarget = Object.freeze({
                release: targetRelease.facts.ref,
                collectionContracts: targetRelease.facts.collectionContracts,
                intent: Object.freeze({
                    enabled: true,
                    offlineUiHosting: priorIntent.offlineUiHosting,
                    expectedRevision: priorIntent.expectedRevision,
                }),
                ...(execution.kind === 'available'
                    ? {
                        // The verified daemon owns candidate callback execution
                        // and stage retirement. The UI only supplies its exact
                        // execution fact to the selector's existing CAS seam.
                        preparation: createDaemonCandidateCollectionReleasePreparation({
                            execution: execution.source,
                        }),
                    }
                    : {
                        // Do not fetch a prospective Account-hosted Artifact
                        // until Availability's typed refusal authorizes one
                        // preparation pass. This supports the exact target
                        // when no trusted daemon execution is available.
                        preparation: Object.freeze({
                            kind: 'direct-ui-target' as const,
                            resolve: async ({ accountLifetime, isCurrent }: DirectUiTargetPreparationInput) => {
                                const resolved = await dependencies.resolveAccountHostedTarget({
                                    accountLifetime,
                                    isCurrent,
                                    facts: targetRelease.facts,
                                });
                                if (resolved.kind !== 'available') {
                                    return Object.freeze({ kind: 'unavailable' as const });
                                }
                                return Object.freeze({
                                    kind: 'available' as const,
                                    candidateTarget: resolved.candidateTarget,
                                    artifact: Object.freeze({
                                        ...resolved.artifact,
                                        appExact: dependencies.createAppExactSource(),
                                    }),
                                });
                            },
                        }),
                    }),
            });
            const result = await dependencies.select({
                reader: input.reader ?? undefined,
                accountLifetime,
                target,
                isCurrent: actionIsCurrent,
            });
            return actionIsCurrent()
                ? result
                : Object.freeze({ kind: 'cancelled' as const });
        } finally {
            if (activeAction === action) activeAction = null;
        }
    };

    const updateHostingIntent: PluginAccountReleaseSelectionController['setHostedArtifactsEnabled'] = async (input) => {
        const selected = readHostedAdministration(input);
        if (!selected
            || (selected.release.uiSlots.length === 0 && selected.release.packageAssetArchive.resources.length === 0)
            || (input.enabled && !selected.hostingCapability.enabled)) {
            return Object.freeze({ kind: 'unavailable' as const });
        }
        const result = await dependencies.setIntent({
            pluginId: input.pluginId,
            desiredVersion: selected.intent.desiredVersion,
            enabled: selected.intent.enabled,
            offlineUiHosting: input.enabled ? 'enabled' : 'disabled',
            writableCollections: selected.intent.writableCollections,
            expectedRevision: selected.intent.revision,
        });
        return Object.freeze({
            kind: result.kind === 'updated' ? 'updated' as const : result.kind === 'conflict' ? 'conflict' as const : 'unavailable' as const,
        });
    };

    const setHostedArtifactsEnabled: PluginAccountReleaseSelectionController['setHostedArtifactsEnabled'] = async (input) => {
        if (retired || activeAction) return Object.freeze({ kind: 'unavailable' as const });
        const action = {};
        activeAction = action;
        try {
            return await updateHostingIntent(input);
        } finally {
            if (activeAction === action) activeAction = null;
        }
    };

    const disableAndRemoveHostedArtifacts: PluginAccountReleaseSelectionController['disableAndRemoveHostedArtifacts'] = async (input) => {
        if (retired || activeAction) return Object.freeze({ kind: 'unavailable' as const });
        const action = {};
        activeAction = action;
        const selected = readHostedAdministration(input);
        const lifetime = dependencies.captureLifetime();
        try {
            if (!selected || !lifetime?.isCurrent()) return Object.freeze({ kind: 'unavailable' as const });
            const disabled = await updateHostingIntent({ ...input, enabled: false });
            if (disabled.kind !== 'updated') return disabled;
            for (const link of selected.uiArtifacts) {
                const removed = await dependencies.removeHostedArtifact({
                    accountLifetime: lifetime,
                    target: {
                        release: selected.release.ref,
                        contributionId: link.contributionId,
                        artifactId: link.artifactId,
                        tier: link.tier,
                        platform: link.platform,
                    },
                });
                if (removed.kind !== 'removed') return Object.freeze({ kind: 'unavailable' as const });
            }
            if (selected.packageAssets.length > 0) {
                const removed = await dependencies.removePackageAssets({
                    accountLifetime: lifetime,
                    target: { release: selected.release.ref },
                });
                if (removed.kind !== 'removed') return Object.freeze({ kind: 'unavailable' as const });
            }
            return Object.freeze({ kind: 'updated' as const });
        } finally {
            if (activeAction === action) activeAction = null;
        }
    };

    const clearHostedArtifactCache: PluginAccountReleaseSelectionController['clearHostedArtifactCache'] = async (input) => {
        if (retired || activeAction) return Object.freeze({ kind: 'unavailable' as const });
        const action = {};
        activeAction = action;
        const selected = readHostedAdministration(input);
        const lifetime = dependencies.captureLifetime();
        try {
            if (!selected || !lifetime?.isCurrent()) return Object.freeze({ kind: 'unavailable' as const });
            for (const slot of selected.release.uiSlots) {
                await dependencies.removeCachedArtifact({
                    accountScope: lifetime.scope,
                    artifactDigest: slot.artifactDigest,
                }, lifetime.isCurrent);
                if (!lifetime.isCurrent()) return Object.freeze({ kind: 'unavailable' as const });
            }
            return Object.freeze({ kind: 'updated' as const });
        } finally {
            if (activeAction === action) activeAction = null;
        }
    };

    return Object.freeze({
        select,
        readHostedArtifactStatus: (input) => {
            const selected = readHostedAdministration(input);
            return selected
                ? classifyPluginAccountHostedArtifactStatus(selected)
                : 'unavailable';
        },
        setHostedArtifactsEnabled,
        disableAndRemoveHostedArtifacts,
        clearHostedArtifactCache,
        retire: () => {
            retired = true;
        },
        isPending: () => activeAction !== null,
    });
}

/** Present-user admission only. The executor invokes the unchanged domain
 * controller above after policy and approval settle; it never re-enters here. */
export function createPluginAccountReleaseSelectionController(options: Readonly<{
    onBlockingApprovalPending?: (input: Readonly<{
        artifactId: string;
        scope: ServerAccountScope;
        signal: AbortSignal;
    }>) => void;
}> = {}): PluginAccountReleaseSelectionController {
    const administration = createPluginAccountReleaseAdministration();
    let retired = false;
    let active: AbortController | null = null;
    const execute = async (actionId: PluginAccountAdministrationActionId, input: unknown,
        intentIsCurrent: () => boolean = () => true,
        readProjection?: () => PluginProjectionV2 | null): Promise<unknown> => {
        const cancelled = () => actionId === 'plugins.account.release.select'
            ? { kind: 'cancelled' as const } : { kind: 'unavailable' as const };
        if (retired || active || !intentIsCurrent()) return cancelled();
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime?.isCurrent()) return actionId === 'plugins.account.release.select'
            ? { kind: 'unavailable', code: 'target_release_unavailable' } : { kind: 'unavailable' };
        const cancellation = new AbortController();
        active = cancellation;
        const current = () => !retired && active === cancellation && !cancellation.signal.aborted
            && lifetime.isCurrent() && intentIsCurrent();
        const retirement = lifetime.onRetire(() => cancellation.abort());
        try {
            const frontDoor = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
            const requireActionSuccess: typeof frontDoor.requireActionSuccess = frontDoor.requireActionSuccess;
            if (!current()) return cancelled();
            const result: ActionExecuteResult = await frontDoor.createFrontDoorActionExecute(undefined, {
                hostActionApprovalLifetime: { actionId, signal: cancellation.signal, surface: 'ui' },
                pluginAccountAdministrationIsCurrent: current,
                pluginAccountAdministrationProjection: readProjection,
                onBlockingApprovalPending: ({ artifactId }) => {
                    if (current()) options.onBlockingApprovalPending?.({
                        artifactId, scope: lifetime.scope, signal: cancellation.signal,
                    });
                },
            })(actionId, input, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId, signal: cancellation.signal });
            if (!current()) return cancelled();
            requireActionSuccess(result);
            return outputs[actionId].parse(result.result);
        } finally {
            retirement.dispose();
            if (active === cancellation) active = null;
        }
    };
    return Object.freeze({
        select: async input => outputs['plugins.account.release.select'].parse(await execute('plugins.account.release.select', {
            pluginId: input.pluginId, version: input.version, daemon: input.daemon,
        }, input.isCurrent, () => input.projection)),
        readHostedArtifactStatus: administration.readHostedArtifactStatus,
        setHostedArtifactsEnabled: async input => outputs['plugins.account.hosting.set'].parse(await execute('plugins.account.hosting.set', {
            pluginId: input.pluginId, enabled: input.enabled,
        })),
        disableAndRemoveHostedArtifacts: async input => outputs['plugins.account.hosting.remove'].parse(await execute('plugins.account.hosting.remove', {
            pluginId: input.pluginId,
        })),
        clearHostedArtifactCache: async input => outputs['plugins.account.cache.clear'].parse(await execute('plugins.account.cache.clear', {
            pluginId: input.pluginId,
        })),
        retire: () => { retired = true; active?.abort(); administration.retire(); },
        isPending: () => active !== null,
    });
}
