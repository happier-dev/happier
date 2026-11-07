import * as React from 'react';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { StorageState } from '@/sync/store/types';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { captureServerProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { areSessionBotFaceFactsEqual } from '@/components/sessions/bots/face/sessionBotFaceFacts';
import { presentSkillMaker, type SkillMaker, type SkillMakerInput } from './skillMaker';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { t } from '@/text';

type MakerSession = Readonly<{ row: SessionListRenderableSession; maker: SkillMaker }>;

function sameMaker(left: SkillMaker | undefined, right: SkillMaker): boolean {
    return Boolean(left && left.kind === right.kind && left.label === right.label
        && left.openSessionId === right.openSessionId && areSessionBotFaceFactsEqual(left.face, right.face)
        && left.filterValues.length === right.filterValues.length
        && left.filterValues.every((value, index) => value === right.filterValues[index]));
}

/** A batch subscription to held identities only. Maker filters never load Sessions or skill bodies. */
export function useSkillMakers(items: readonly SkillMakerInput[], scope: ServerAccountScope | null) {
    const isRecordingVisible = useSessionRecordingVisibility();
    const generation = useServerProfilesGeneration();
    const resolveScopeId = React.useMemo(() => captureServerProfileScopeResolver(), [generation]);
    const creators = React.useMemo(() => new Map(items.flatMap(item =>
        item.creator?.kind === 'agent' && item.creator.sessionId ? [[item.creator.sessionId, item.creator] as const] : [])), [items]);
    const selector = React.useMemo(() => {
        let sourceRows: StorageState['sessionListRowsByServerId'] | undefined;
        let selected = new Map<string, MakerSession>();
        return (state: StorageState) => {
            if (sourceRows === state.sessionListRowsByServerId) return selected;
            sourceRows = state.sessionListRowsByServerId;
            const next = new Map<string, MakerSession>();
            if (scope) for (const [id, creator] of creators) {
                const row = readSessionListRowForServerId(sourceRows, scope.serverId, id, resolveScopeId);
                if (!row) continue;
                const maker = presentSkillMaker({ creator }, scope, row);
                // Retain only the identity consumed below. MCP/runtime/version pushes must not wake maker surfaces.
                const previous = selected.get(id);
                next.set(id, sameMaker(previous?.maker, maker) ? previous! : { row, maker });
            }
            if (next.size !== selected.size || [...next].some(([id, value]) => selected.get(id) !== value)) {
                selected = next;
            }
            return selected;
        };
    }, [creators, scope?.accountId, scope?.serverId, resolveScopeId]);
    const rows = getStorage()(selector);
    return React.useCallback((item: SkillMakerInput) => {
        const id = item.creator?.kind === 'agent' ? item.creator.sessionId : undefined;
        const maker = presentSkillMaker(item, scope, id ? rows.get(id)?.row : undefined);
        return id && !isRecordingVisible({ sessionId: id, serverId: scope?.serverId })
            ? { ...maker, kind: 'session', label: t('capabilities.skills.maker.session'), face: null } satisfies SkillMaker
            : maker;
    }, [rows, scope, isRecordingVisible]);
}
