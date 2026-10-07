import { readBackendTargetRefV2, type BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { isRecoveredHistoryTranscriptObservation, type Message } from '@happier-dev/session-core/messages';

import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { readCachedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { deriveTurnChangeSetsFromMessages } from '@/sync/domains/session/changes/derivation/deriveTurnChangeSetsFromMessages';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveScmDiffSummaryModelSelection, resolveScmDiffSummarySettings } from '@/settings/scmDiffSummary/settings';
import { prefetchScmDiffSummary, readCompletedScmDiffSummaryCheckpointReceipt, retireScmDiffSummaryScope } from './generate';

/** Consume committed transcript changes; the prefetch operation owns eligibility and dedupe. */
export async function prefetchCompletedCheckpointMessages(params: Readonly<{
    session: Session;
    messages: readonly Message[];
    settings: Partial<Settings>;
    lifetime: ServerAccountScopeLifetime;
    shouldContinue?: () => boolean;
}>): Promise<void> {
    const current = () => params.lifetime.isCurrent() && params.shouldContinue?.() !== false;
    const settings = resolveScmDiffSummarySettings({ storedSettings: params.settings, catalogProfiles: [] });
    if (!settings.enabled || !settings.prefetch || !current()
        || !areServerProfileIdentifiersEquivalent(params.session.serverId, params.lifetime.scope.serverId)) return;
    const turns = deriveTurnChangeSetsFromMessages(params.messages.filter((message) => !isRecoveredHistoryTranscriptObservation(message)))
        .filter((turn) => turn.sessionId === params.session.id && turn.turnId === params.session.latestTurnId
            && readCompletedScmDiffSummaryCheckpointReceipt(turn));
    if (turns.length === 0) return;
    const metadata = readSessionOwnerMetadataView(params.session);
    const cwd = metadata?.path?.trim();
    if (!cwd) return;
    const defaults = resolveSessionActionDefaultBackend({ session: params.session });
    let defaultBackendTarget: BackendTargetRefV2 | null = defaults?.backendTarget ?? null;
    if (!defaultBackendTarget && defaults?.agentTarget) {
        try { defaultBackendTarget = readBackendTargetRefV2(defaults.agentTarget); }
        catch {
            // Only the existing exact machine catalog can map an installed Agent carrier.
            const projection = readCachedDaemonMergedProjectionCacheEntry({ machineId: metadata?.machineId, serverId: params.lifetime.scope.serverId });
            const inputs = projection && 'inputs' in projection ? projection.inputs : null;
            const entries = getResolvedBackendCatalogEntries({ enabledAgentIds: [],
                acpCatalogSettingsV1: params.settings.acpCatalogSettingsV1 ?? { v: 2, backends: [] },
                backendEnabledByTargetKey: params.settings.backendEnabledByTargetKey,
                mergedProviderProjectionById: inputs?.mergedProviderProjectionById,
                mergedBackendProjectionById: inputs?.mergedBackendProjectionById,
                discoveredBackendIds: inputs?.discoveredBackendIds,
            });
            const identity = defaults.agentTarget.identity;
            const entry = entries.find((candidate) => candidate.agentCatalogEntry.identity?.pluginId === identity.pluginId
                && candidate.agentCatalogEntry.identity.localId === identity.localId);
            defaultBackendTarget = entry?.backendTarget.kind === 'backend' ? entry.backendTarget : entry?.compatibilityBackendTargets?.[0] ?? null;
        }
    }
    const selection = resolveScmDiffSummaryModelSelection({
        storedValue: params.settings['scm.diffSummary.modelProfileOverride'] ?? '', defaultBackendTarget,
    });
    if (!selection.success || !current()) return;
    const controller = new AbortController();
    const retirement = params.lifetime.onRetire(() => {
        controller.abort();
        retireScmDiffSummaryScope(params.lifetime.scope);
    });
    try {
        await Promise.all(turns.map((turn) => {
            const receipt = readCompletedScmDiffSummaryCheckpointReceipt(turn);
            if (!receipt || !current()) return;
            return prefetchScmDiffSummary({ sessionId: params.session.id, scope: params.lifetime.scope,
                serverId: params.lifetime.scope.serverId, signal: controller.signal, shouldContinue: current,
                backendTarget: selection.backendTarget, turnChangeSet: turn, settings: params.settings,
                input: { cwd, source: { kind: 'turnCheckpoint', sessionId: params.session.id, turnId: turn.turnId,
                    checkpointReceiptId: receipt.id, evidenceMode: 'checkpoint' },
                    modelSelector: selection.modelSelector, outputs: ['walkthrough'],
                },
            });
        }));
    } finally { retirement.dispose(); }
}
