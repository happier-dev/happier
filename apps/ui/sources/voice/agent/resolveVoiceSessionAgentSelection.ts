import type { Metadata } from '@happier-dev/session-core/state';
import { convertBackendTargetRefV2ToV1 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { BackendTargetRefV1 } from '@happier-dev/protocol/backends/targets/backendTargetRef';
import { resolveSessionActionDefaultBackend, resolveSessionActionDefaultTarget } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { resolveOperationalBackendTargetForAgentSelection } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';

export type VoiceSessionAgentSelection = Readonly<
    | { ok: true; backendTarget: BackendTargetRefV1 }
    | { ok: false; code: 'VOICE_AGENT_SELECTION_UNAVAILABLE'; reason: 'voice_agent_selection_unavailable' }
>;

/** Adapt the Session Agent owner's result for Voice; never substitute the saved Voice Agent. */
export function resolveVoiceSessionAgentSelection(metadata: Metadata | null): VoiceSessionAgentSelection {
    const selected = resolveSessionActionDefaultBackend({ session: { metadata } });
    const target = resolveSessionActionDefaultTarget(selected);
    const operational = target ? resolveOperationalBackendTargetForAgentSelection({
        backendTarget: target,
        selectedEntry: selected?.defaultAgentId ? { agentId: selected.defaultAgentId } : null,
    }) : null;
    return operational
        ? { ok: true, backendTarget: convertBackendTargetRefV2ToV1(operational) }
        : { ok: false, code: 'VOICE_AGENT_SELECTION_UNAVAILABLE', reason: 'voice_agent_selection_unavailable' };
}

export function requireVoiceSessionAgentSelection(selection: VoiceSessionAgentSelection): BackendTargetRefV1 {
    if (!selection.ok) throw Object.assign(new Error(selection.reason), { code: selection.code });
    return selection.backendTarget;
}
