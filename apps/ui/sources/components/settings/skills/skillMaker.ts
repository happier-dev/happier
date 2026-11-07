import type { ArtifactSavedByV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import type { SkillProvenanceV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { readSessionBotFaceFacts, type SessionBotFaceFacts } from '@/components/sessions/bots/face/sessionBotFaceFacts';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';

export type SkillMakerInput = Readonly<{ creator?: ArtifactSavedByV1; provenance?: SkillProvenanceV1 }>;
export type SkillMaker = Readonly<{
    kind: 'you' | 'person' | 'bot' | 'session' | 'registry' | 'unknown';
    label: string;
    filterValues: readonly string[];
    openSessionId: string | null;
    face: SessionBotFaceFacts | null;
}>;

/** Private creator evidence and the existing accessible Session identity decide maker presentation once. */
export function presentSkillMaker(
    item: SkillMakerInput,
    scope: ServerAccountScope | null,
    session?: SessionListRenderableSession,
): SkillMaker {
    const base = { filterValues: ['anyone'], openSessionId: null, face: null } as const;
    const provenance = item.provenance;
    if (provenance?.kind === 'registry' || provenance?.kind === 'wellKnown'
        || provenance?.kind === 'link' && provenance.ref.kind === 'wellKnown') {
        return { ...base, kind: 'registry', label: t('capabilities.skills.maker.registries'), filterValues: ['anyone', 'registries'] };
    }
    const creator = item.creator;
    if (!creator) return { ...base, kind: 'unknown', label: t('capabilities.skills.maker.unknown') };
    if (creator.kind === 'person') {
        return creator.accountId === scope?.accountId
            ? { ...base, kind: 'you', label: t('capabilities.skills.maker.you'), filterValues: ['anyone', 'you'] }
            : { ...base, kind: 'person', label: t('capabilities.skills.maker.person') };
    }
    // Recorded ids are attribution, never a grant or a substitute for the Session's content-availability fact.
    if (!scope || !creator.sessionId || session?.id !== creator.sessionId
        || session.access?.capabilities.readTranscript !== true
        || !isSessionContentReadable(readSessionContentAvailability(session))) {
        return { ...base, kind: 'session', label: t('capabilities.skills.maker.session') };
    }
    const face = readSessionBotFaceFacts(session, scope.serverId);
    return { kind: face ? 'bot' : 'session', label: getSessionName(session, scope.serverId),
        filterValues: face ? ['anyone', 'any-bot', `session:${creator.sessionId}`] : base.filterValues,
        openSessionId: creator.sessionId, face };
}

/** Labels retained creator tokens honestly when a Bot disappears or is no longer accessible. */
export function skillMakerFilterLabel(value: string): string {
    switch (value) {
        case 'anyone': return t('capabilities.skills.maker.anyone');
        case 'you': return t('capabilities.skills.maker.you');
        case 'any-bot': return t('capabilities.skills.maker.anyBot');
        case 'registries': return t('capabilities.skills.maker.registries');
        default: return t('capabilities.skills.maker.session');
    }
}
