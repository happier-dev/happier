import * as React from 'react';

import type { SessionSpawnSourceContextV1 } from '@happier-dev/protocol';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { createSessionSourceContextActionChip } from '@/components/sessions/agentInput/definitions/createSessionSourceContextActionChip';
import { storage } from '@/sync/domains/state/storage';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import type { NewSessionData } from '@/utils/sessions/tempDataStore';

export type NewSessionSourceContextState = Readonly<{
    /** The continuation recipe the spawn must carry, or null for an ordinary new Session. */
    sourceContext: SessionSpawnSourceContextV1 | null;
    /** The removable composer chip, or null when there is no source context. */
    chip: AgentInputExtraActionChip | null;
    /**
     * True when the chosen target server is not the source Session's server.
     * V1 requires them to match, so authoring must say so rather than silently
     * dropping the recipe at submit.
     */
    serverMismatch: boolean;
    remove: () => void;
}>;

function normalize(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * Owns the one-shot source-context intent for the New Session screen.
 *
 * It is deliberately screen state rather than a field on the persisted authoring
 * draft: continuing from a specific Session is an authoring intent for this
 * attempt, not a configuration the user expects to find again next week. Removal
 * clears only this value, so the Agent, model, machine, folder, permissions and
 * MCP selections the user already made are untouched.
 */
export function useNewSessionSourceContext(params: Readonly<{
    /** The one-shot navigation payload; already read once by the screen model. */
    seed: Pick<NewSessionData, 'sourceContext' | 'sourceContextServerId'> | null | undefined;
    targetServerId: string | null;
}>): NewSessionSourceContextState {
    const seededSourceContext = params.seed?.sourceContext ?? null;
    const seededServerId = normalize(params.seed?.sourceContextServerId);

    const [removed, setRemoved] = React.useState(false);
    const remove = React.useCallback(() => { setRemoved(true); }, []);

    // A new one-shot seed is a new authoring intent, so a previous removal must
    // not suppress it.
    const lastSeedRef = React.useRef(seededSourceContext);
    if (lastSeedRef.current !== seededSourceContext) {
        lastSeedRef.current = seededSourceContext;
        if (removed) setRemoved(false);
    }

    const sourceContext = removed ? null : seededSourceContext;

    const sourceSessionTitle = React.useMemo(() => {
        if (!sourceContext) return null;
        const session = storage.getState().sessions[sourceContext.sourceSessionId] ?? null;
        return session ? normalize(getSessionName(session)) : null;
    }, [sourceContext]);

    const targetServerId = normalize(params.targetServerId);
    const serverMismatch = Boolean(
        sourceContext && seededServerId && targetServerId && seededServerId !== targetServerId,
    );

    const chip = React.useMemo(() => {
        if (!sourceContext) return null;
        return createSessionSourceContextActionChip({
            sourceSessionTitle,
            isMessageCutoff: sourceContext.forkPoint.type === 'seq',
            serverMismatch,
            onRemove: remove,
        });
    }, [remove, serverMismatch, sourceContext, sourceSessionTitle]);

    return { sourceContext, chip, serverMismatch, remove };
}
