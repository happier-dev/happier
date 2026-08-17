import type { PluginProjectionV2 } from '@happier-dev/protocol';

import {
    readActivePluginAccountRelease,
} from '@/sync/api/plugins/availability/activePluginAccountReleaseRead';
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

export type PluginAccountReleaseSelectionControllerDependencies = Readonly<{
    captureLifetime: () => ActiveServerAccountScopeLifetime | null;
    readRelease: typeof readActivePluginAccountRelease;
    resolveExecution: typeof resolveCandidateCollectionReleaseExecution;
    resolveAccountHostedTarget: typeof resolveCandidatePluginCollectionMigrationArtifactAccountHostedTarget;
    createAppExactSource: typeof createBundledPluginUiAppExactArtifactSource;
    select: typeof selectCandidateCollectionRelease;
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
});

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
        const selected = input.reader.readCurrentReleaseSelection({ pluginId: input.pluginId });
        if (selected.kind !== 'available') {
            return Object.freeze({ expectedRevision: null, offlineUiHosting: 'disabled' as const });
        }
        return Object.freeze({
            expectedRevision: selected.intent.revision,
            offlineUiHosting: selected.intent.offlineUiHosting,
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
export function createPluginAccountReleaseSelectionController(
    dependencies: PluginAccountReleaseSelectionControllerDependencies = defaultDependencies,
): PluginAccountReleaseSelectionController {
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
                                    availabilityCursor: targetRelease.availabilityCursor,
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

    return Object.freeze({
        select,
        retire: () => {
            retired = true;
        },
        isPending: () => activeAction !== null,
    });
}
