import * as React from 'react';
import type { RoleEngineV1 } from '@happier-dev/protocol/prompts/roles/roleArtifactV1';
import { PROVIDER_REASONING_EFFORT_OPTION_ID } from '@happier-dev/protocol/providers/catalog/reasoningEffort';

import { getResolvedBackendCatalogEntries, type ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { resolvePreferredBackendTarget } from '@/agents/backendCatalog/resolvePreferredBackendTarget';
import { useActiveServerAccountScope, useSetting } from '@/sync/domains/state/storage';
import { useLastUsedBackendSelection } from '@/hooks/session/useLastUsedBackendSelection';
import { useAcpCatalog } from '@/sync/store/useAcpCatalog';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { getModelOptionsForAgentType, type ModelOption } from '@/sync/domains/models/modelOptions';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

/**
 * A role's stored engine key in the catalog's canonical form: a role written before the canonical
 * key shape still names the same Agent (`resolveBackendTargetKeyV2` owns that normalization).
 */
export function resolveRoleEngineTargetKey(agentTargetKey: string): string {
    try {
        return resolveBackendTargetKeyV2(agentTargetKey);
    } catch {
        return agentTargetKey;
    }
}
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';

/** The Agent config option a role's `engine.effort` is (the same id `admitAgentStartV1` stamps). */
const ROLE_EFFORT_CONFIG_OPTION_ID = PROVIDER_REASONING_EFFORT_OPTION_ID;

/** The built-in Agent an engine key names, for naming its models before the Agent catalog answers. */
function readRoleEngineAgentId(agentTargetKey: string): string | null {
    try {
        const target = readBackendTargetRefV2(agentTargetKey);
        return target.sourceKind === 'configured' ? null : target.backendId;
    } catch {
        return null;
    }
}

function readEffortName(option: ModelOption | undefined, effort: string): string | null {
    const control = option?.modelOptions?.find((candidate) => candidate.id === ROLE_EFFORT_CONFIG_OPTION_ID);
    return control?.options?.find((choice) => choice.value === effort)?.name ?? null;
}

/**
 * The model and effort of a role's engine in the words the composer's picker uses: the Agent's
 * static model catalog names the model, and that model's effort option names the effort. An id the
 * catalog cannot name stays as it is.
 */
export function describeRoleEngineChoice(
    agentId: string | null,
    engine: RoleEngineV1,
): Readonly<{ model: string | null; effort: string | null }> {
    const resolvedAgentId = agentId ?? readRoleEngineAgentId(engine.agentTargetKey);
    const options = resolvedAgentId ? getModelOptionsForAgentType(resolvedAgentId) : [];
    const model = engine.modelId ? options.find((option) => option.value === engine.modelId) : undefined;
    const effort = engine.effort
        ? readEffortName(model, engine.effort)
            ?? options.map((option) => readEffortName(option, engine.effort!)).find(Boolean)
            ?? engine.effort
        : null;
    return { model: engine.modelId ? model?.label ?? engine.modelId : null, effort };
}

export type RoleEnginePresentation = Readonly<{
    /**
     * "Claude · Opus 5.5 · High". A role that pins no engine follows the Account's preferred agent,
     * so it is named by that agent's title ("Claude"); null only when no agent can be resolved.
     */
    label: string | null;
    /**
     * The same engine beside its own agent mark (a role row, lab `settings-R`): "Opus 5.5 · High".
     * The mark already names the agent, so only the model and effort follow it; without a model, or
     * without a mark to name the agent, it is `label`.
     */
    choiceLabel: string | null;
    icon: React.ReactNode;
    /**
     * The engine names an agent this Account has not enabled: "choose an engine". Said only once the
     * Agent catalog has answered (or cannot be read here); a catalog still loading claims nothing.
     */
    unavailable: boolean;
    /**
     * A role that pins no engine, while the Agent catalog has not yet said which agent it follows:
     * the surface keeps the space and says nothing (never "Default agent" before the real name).
     */
    pending: boolean;
}>;

/**
 * Names a role's engine with the Agent catalog's own identity (title and mark). It reads only the
 * Account's enabled agents — no machine is asked anything — so a picker can name every role at once.
 */
export function useRoleEngineCatalog(serverId?: string | null) {
    const scope = useActiveServerAccountScope(serverId);
    const catalogAvailable = serverId === undefined || scope !== null;
    const { snapshot } = useAcpCatalog(serverId === undefined ? undefined : scope);
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const ready = catalogAvailable && snapshot?.catalog.status === 'ready' && !snapshot.stale;
    const entries = React.useMemo(() => {
        // Bundled and installed identities do not depend on the configured Account row.
        return catalogAvailable ? getResolvedBackendCatalogEntries({
            enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey }),
            acpCatalogSnapshot: snapshot?.catalog,
            backendEnabledByTargetKey,
        }) : [];
    }, [snapshot, backendEnabledByTargetKey, catalogAvailable]);
    return { entries, ready, scope, snapshot };
}

export function useRoleEnginePresentation(serverId?: string | null): (engine: RoleEngineV1 | undefined, iconSize?: number) => RoleEnginePresentation {
    const { entries, ready, scope, snapshot } = useRoleEngineCatalog(serverId);
    const settled = ready || (serverId !== undefined && scope === null)
        || snapshot?.catalog.status === 'unavailable' || snapshot?.catalog.status === 'partial';
    const entriesByTargetKey = React.useMemo(() => new Map<string, ResolvedBackendCatalogEntry>(
        entries.map((entry) => [entry.backendTargetKey, entry]),
    ), [entries]);
    const { lastUsedAgent, lastUsedBackendTarget } = useLastUsedBackendSelection();
    // A role without an engine runs on the agent a new session would start with: the same preference owner.
    const defaultEntry = React.useMemo(() => {
        // Without an explicit preference, configured rows may determine the default.
        if (entries.length === 0 || (!ready && lastUsedBackendTarget == null)) return null;
        const target = resolvePreferredBackendTarget({
            availableBackendTargets: entries.map((entry) => entry.backendTarget),
            lastUsedAgent,
            lastUsedBackendTarget,
        });
        return entriesByTargetKey.get(resolveBackendTargetKeyV2(target)) ?? null;
    }, [entries, entriesByTargetKey, lastUsedAgent, lastUsedBackendTarget, ready]);

    return React.useCallback((engine, iconSize = 12) => {
        if (!engine) {
            return {
                pending: defaultEntry === null && !settled,
                label: defaultEntry?.title ?? null,
                choiceLabel: defaultEntry?.title ?? null,
                icon: defaultEntry ? (
                    <AgentCatalogIdentityIcon entry={defaultEntry.agentCatalogEntry} machineId={null} serverId={null} current={false} size={iconSize} />
                ) : null,
                unavailable: false,
            };
        }
        const entry = entriesByTargetKey.get(resolveRoleEngineTargetKey(engine.agentTargetKey)) ?? null;
        const choice = describeRoleEngineChoice(entry?.agentId ?? null, engine);
        const parts = [entry?.title ?? null, choice.model, choice.effort]
            .filter((part): part is string => Boolean(part));
        const label = parts.length > 0 ? joinHappierFacts(...parts) : null;
        const choiceParts = [choice.model, choice.effort].filter((part): part is string => Boolean(part));
        return {
            label,
            choiceLabel: entry && choice.model ? joinHappierFacts(...choiceParts) : label,
            icon: entry ? (
                <AgentCatalogIdentityIcon entry={entry.agentCatalogEntry} machineId={null} serverId={null} current={false} size={iconSize} />
            ) : null,
            unavailable: entry === null && settled,
            pending: false,
        };
    }, [defaultEntry, entriesByTargetKey, settled]);
}
