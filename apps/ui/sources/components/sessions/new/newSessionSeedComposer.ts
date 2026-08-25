import {
    PluginUiNewSessionSeedV1Schema,
    type PluginUiNewSessionSeedV1,
} from '@happier-dev/protocol/plugins/ui';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import {
    storeTempData,
    type NewSessionData,
    type NewSessionPluginAttachmentSeedV1,
} from '@/utils/sessions/tempDataStore';
import {
    newSessionDraftSeedDeclaresChangeV1,
    seedNewSessionDraftV1,
    type NewSessionDraftSeedV1,
} from './newSessionDraftSeed';

/**
 * The literal host arm that seeds the real New Session screen and opens it.
 *
 * It deliberately settles with nothing but an acknowledgement. Handing the
 * caller a draft back is what the `serverStartDraft` projection is for; here the
 * screen's own canonical snapshot owns every subsequent edit and the send, and a
 * copy in the caller's hands would be the second competing draft this
 * projection exists to avoid.
 *
 * It creates no Session, dispatches nothing, and holds no Action handle.
 */
export type SessionNewSessionSeedOutcome =
    | Readonly<{ kind: 'seeded'; dataId?: string }>
    | Readonly<{
        kind: 'invalid';
        reason: 'seed_invalid' | 'seed_empty' | 'seed_attachments_uncredited';
    }>
    | Readonly<{ kind: 'unavailable'; reason: 'aborted' | 'navigation_unavailable' }>
    | Readonly<{ kind: 'stale'; reason: 'host_retired' }>;

/** Parses the plugin-authored seed at its one boundary. */
export function readPluginNewSessionSeedV1(value: unknown): NewSessionDraftSeedV1 | null {
    const parsed = PluginUiNewSessionSeedV1Schema.safeParse(value);
    if (!parsed.success) return null;
    return projectPluginNewSessionSeedV1(parsed.data);
}

function projectPluginNewSessionSeedV1(seed: PluginUiNewSessionSeedV1): NewSessionDraftSeedV1 {
    return {
        ...(seed.prompt === undefined ? {} : { prompt: seed.prompt }),
        ...(seed.profileId === undefined ? {} : { profileId: seed.profileId }),
        ...(seed.placement === undefined ? {} : { placement: seed.placement }),
        ...(seed.candidates === undefined ? {} : { candidates: seed.candidates }),
        ...(seed.attachments === undefined ? {} : { attachments: seed.attachments }),
    };
}

function readIsCurrent(isCurrent: () => boolean): boolean {
    try {
        return isCurrent();
    } catch {
        return false;
    }
}

export function seedAndOpenNewSession(params: Readonly<{
    seed: unknown;
    /**
     * The plugin whose surface asked for the seed. It is the caller identity
     * the composer mount qualifies a seeded attachment's local id against —
     * the same qualification a live `attachment.add` from that plugin gets —
     * so a seed with attachments and no caller identity places nothing.
     */
    pluginId?: string;
    scope?: ServerAccountScope | null;
    signal?: AbortSignal;
    isCurrent: () => boolean;
    navigateToNewSession: (input: Readonly<{ dataId: string | null; draftId: string }>) => void;
    nowMs?: () => number;
    createDraftId?: Parameters<typeof seedNewSessionDraftV1>[0]['createDraftId'];
    writeDraft?: Parameters<typeof seedNewSessionDraftV1>[0]['writeDraft'];
    storeTempData?: typeof storeTempData;
}>): SessionNewSessionSeedOutcome {
    const seed = readPluginNewSessionSeedV1(params.seed);
    if (!seed) return { kind: 'invalid', reason: 'seed_invalid' };
    // A seed that declares nothing must not navigate: it would drop the reader
    // onto the New Session screen having asked for nothing at all.
    if (!newSessionDraftSeedDeclaresChangeV1(seed)) return { kind: 'invalid', reason: 'seed_empty' };
    // A seed that asks for attachments and names no caller cannot place any of
    // them, and opening the screen anyway would show the reader a New Session
    // that quietly lost every entry they chose. It is refused before anything
    // is written or navigated.
    const pluginId = params.pluginId?.trim();
    if ((seed.attachments?.length ?? 0) > 0 && !pluginId) {
        return { kind: 'invalid', reason: 'seed_attachments_uncredited' };
    }
    if (params.signal?.aborted === true) return { kind: 'unavailable', reason: 'aborted' };
    if (!readIsCurrent(params.isCurrent)) return { kind: 'stale', reason: 'host_retired' };

    const draftId = seedNewSessionDraftV1({
        seed,
        scope: params.scope ?? null,
        ...(params.nowMs ? { nowMs: params.nowMs } : {}),
        ...(params.createDraftId ? { createDraftId: params.createDraftId } : {}),
        ...(params.writeDraft ? { writeDraft: params.writeDraft } : {}),
    });
    if (!draftId) return { kind: 'unavailable', reason: 'navigation_unavailable' };

    // Requests that cannot become a persisted draft field travel through the
    // incumbent one-shot New Session handoff. Only its mounted composer can
    // resolve their qualified contribution, generation, presentation label and
    // minted instance id; candidate placement is likewise not selected until
    // the reader uses the normal route controls.
    const attachmentSeeds: readonly NewSessionPluginAttachmentSeedV1[] = (seed.attachments ?? [])
        .map((attachment) => ({
            pluginId: pluginId ?? '',
            attachmentLocalId: attachment.attachmentLocalId,
            value: attachment.value,
        }));
    const placementCandidates = seed.candidates ?? [];
    const handoff: NewSessionData['pluginNewSessionSeed'] = {
        ...(attachmentSeeds.length === 0 ? {} : { attachments: attachmentSeeds }),
        ...(placementCandidates.length === 0 ? {} : { placementCandidates }),
    };
    const dataId = attachmentSeeds.length === 0 && placementCandidates.length === 0
        ? null
        : (params.storeTempData ?? storeTempData)({ pluginNewSessionSeed: handoff });

    try {
        params.navigateToNewSession({ dataId, draftId });
    } catch {
        // The draft is already written, so the reader can still reach it by
        // opening New Session themselves. Reporting success would claim a
        // navigation that did not happen.
        return { kind: 'unavailable', reason: 'navigation_unavailable' };
    }
    return { kind: 'seeded', ...(dataId ? { dataId } : {}) };
}
