import { readBackendTargetRefV2, type BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { getAgentCore, getAgentStaticModels } from '@happier-dev/agents';
import { isRecoveredHistoryTranscriptObservation, type Message } from '@happier-dev/session-core/messages';

import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { buildScmDiffSummaryModelProfiles } from '@/settings/scmDiffSummary/models';
import { readCachedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { deriveTurnChangeSetsFromMessages } from '@/sync/domains/session/changes/derivation/deriveTurnChangeSetsFromMessages';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getAcpCatalogSnapshot } from '@/sync/store/settings/acpCatalogSnapshot';
import { refreshAcpCatalog } from '@/sync/engine/settings/acpCatalogEngine';
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
    let catalog = getAcpCatalogSnapshot(params.lifetime.scope);
    if (!catalog || catalog.stale) {
        await refreshAcpCatalog(params.lifetime.scope);
        if (!current()) return;
        catalog = getAcpCatalogSnapshot(params.lifetime.scope);
    }
    if (catalog?.catalog.status !== 'ready' || catalog.stale) return;
    const projection = readCachedDaemonMergedProjectionCacheEntry({ machineId: metadata?.machineId, serverId: params.lifetime.scope.serverId,
        sections: ['agentsById'] });
    const inputs = projection && 'inputs' in projection ? projection.inputs : null;
    const entries = getResolvedBackendCatalogEntries({ enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey: params.settings.backendEnabledByTargetKey }),
        acpCatalogSnapshot: catalog.catalog, backendEnabledByTargetKey: params.settings.backendEnabledByTargetKey,
        mergedProviderProjectionById: inputs?.mergedProviderProjectionById,
        mergedBackendProjectionById: inputs?.mergedBackendProjectionById, discoveredBackendIds: inputs?.discoveredBackendIds });
    const defaults = resolveSessionActionDefaultBackend({ session: params.session });
    let defaultBackendTarget: BackendTargetRefV2 | null = defaults?.backendTarget ?? null;
    if (!defaultBackendTarget && defaults?.agentTarget) {
        try { defaultBackendTarget = readBackendTargetRefV2(defaults.agentTarget); }
        catch {
            // Only the existing exact machine catalog can map an installed Agent carrier.
            const identity = defaults.agentTarget.identity;
            const entry = entries.find((candidate) => candidate.agentCatalogEntry.identity?.pluginId === identity.pluginId
                && candidate.agentCatalogEntry.identity.localId === identity.localId);
            defaultBackendTarget = entry?.backendTarget.kind === 'backend' ? entry.backendTarget : entry?.compatibilityBackendTargets?.[0] ?? null;
        }
    }
    const storedValue = params.settings['scm.diffSummary.modelProfileOverride'] ?? '';
    const selection = storedValue.trim() ? resolveScmDiffSummaryModelSelection({
        storedValue, defaultBackendTarget,
        catalogProfiles: entries.flatMap(entry => buildScmDiffSummaryModelProfiles({
            backendTarget: readBackendTargetRefV2(entry.backendTarget), models: getAgentStaticModels(entry.agentId, { catalogOnly: true }),
            agentFormats: entry.kind === 'builtInAgent' ? getAgentCore(entry.agentId)?.structuredOutput?.formats : null,
        })),
    }) : null;
    if (selection && !selection.success) return;
    const backendTarget = selection?.backendTarget ?? defaultBackendTarget;
    if (!backendTarget || !current()) return;
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
                backendTarget, turnChangeSet: turn, settings: params.settings,
                input: { cwd, source: { kind: 'turnCheckpoint', sessionId: params.session.id, turnId: turn.turnId,
                    checkpointReceiptId: receipt.id, evidenceMode: 'checkpoint' },
                    ...(selection ? { modelSelector: selection.modelSelector } : {}), outputs: ['walkthrough'],
                },
            });
        }));
    } finally { retirement.dispose(); }
}
