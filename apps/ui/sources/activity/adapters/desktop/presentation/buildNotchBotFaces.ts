import type { OrderedBot } from '@/components/sessions/bots/botActivity';
import { isNotchBotFaceMember } from '@/components/sessions/bots/notchBotFaces';
import { readSessionListIdentityFacts } from '@/components/sessions/shell/SessionListIdentity';
import type { resolveActivitySurfaceDeliveryAdmission } from '@/activity/delivery/resolveActivitySurfaceDeliveryAdmission';
import type { ActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { buildActivitySurfaceViewModel, type ActivitySurfaceCandidatePrivacyModeResolver } from '@/activity/presentation/buildActivitySurfaceViewModel';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { DesktopOverlayVisibilityMode } from '../runtime/resolveDesktopOverlayPolicy';
import type { BotFaceSnapshot, NotchBotFaces } from './notchBotTypes';

/** Filter the shared Bot order; admission and activity classification have already been decided. */
export function buildNotchBotFaces(params: Readonly<{
    orderedBots: readonly OrderedBot[];
    admission: ReturnType<typeof resolveActivitySurfaceDeliveryAdmission>;
    railPinnedByServerId: Readonly<Record<string, readonly string[]>>;
    mode: DesktopOverlayVisibilityMode;
    activityPolicy: ActivitySurfacePolicy;
    resolveCandidatePrivacyMode: ActivitySurfaceCandidatePrivacyModeResolver;
}>, previous?: NotchBotFaces): NotchBotFaces {
    const candidates = new Map(params.admission.candidates.flatMap(candidate => candidate.address
        ? [[sessionAddressKey(candidate.address), candidate] as const] : []));
    const prior = new Map(previous?.faces.map(face => [sessionAddressKey(face), face]));
    const faces: BotFaceSnapshot[] = [];
    for (const bot of params.orderedBots) {
        const candidate = candidates.get(sessionAddressKey(bot));
        if (!candidate || !isNotchBotFaceMember(bot, params.mode,
            params.railPinnedByServerId[bot.serverId]?.includes(bot.sessionId) === true)) continue;
        const view = buildActivitySurfaceViewModel({ candidate, policy: params.activityPolicy,
            showMachinePath: false, showPreviewText: true, isPrimary: false,
            resolveCandidatePrivacyMode: params.resolveCandidatePrivacyMode });
        const face: BotFaceSnapshot = {
            serverId: bot.serverId, sessionId: bot.sessionId, face: bot.face,
            name: view.title, activity: bot.activity, currentLine: view.previewText ?? view.statusText ?? null,
            meaningfulActivityAt: bot.meaningfulActivityAt,
            live: (candidate.presentationSource?.lifecycle.active ?? candidate.session.active) === true,
            ...readSessionListIdentityFacts(candidate.session, candidate.presentationSource),
        };
        const old = prior.get(sessionAddressKey(bot));
        faces.push(old && Object.keys(face).every(key => old[key as keyof BotFaceSnapshot] === face[key as keyof BotFaceSnapshot]) ? old : face);
    }
    if (previous && faces.length === previous.faces.length && faces.every((face, index) => face === previous.faces[index])) return previous;
    return { faces, overflowCount: Math.max(0, faces.length - 4) };
}
