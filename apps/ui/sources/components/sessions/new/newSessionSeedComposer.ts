import {
    PluginUiNewSessionSeedV1Schema,
    type PluginUiNewSessionSeedV1,
} from '@happier-dev/protocol/plugins/ui';

import { randomUUID } from '@/platform/randomUUID';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    writeNewSessionComposerAttachmentSeeds,
    type NewSessionComposerAttachmentSeedV1,
} from './attachments/newSessionComposerAttachmentSeedStore';

import {
    getTempData,
    storeTempData,
    type NewSessionData,
} from '@/utils/sessions/tempDataStore';

/**
 * The Session-owned settlement behind the semantic `openNewSession` method.
 *
 * It deliberately settles with nothing but an acknowledgement. Handing the
 * caller a draft back is what no-invoke input selection is for; here the
 * screen's own canonical snapshot owns every subsequent edit and the send, and a
 * copy in the caller's hands would be the second competing draft this
 * operation exists to avoid.
 *
 * It creates no Session, dispatches nothing, and holds no Action handle.
 */
export type SessionNewSessionSeedOutcome =
    | Readonly<{ kind: 'opened'; dataId: string }>
    | Readonly<{
        kind: 'invalid';
        reason: 'seed_invalid' | 'seed_empty' | 'seed_attachments_uncredited';
    }>
    | Readonly<{
        kind: 'unavailable';
        reason: 'aborted' | 'navigation_unavailable' | 'prepared_review_workspace_unavailable';
    }>
    | Readonly<{ kind: 'stale'; reason: 'host_retired' }>;

/** Parses the plugin-authored seed at its one boundary. */
export function readPluginNewSessionSeedV1(value: unknown): PluginUiNewSessionSeedV1 | null {
    const parsed = PluginUiNewSessionSeedV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

type NewSessionCheckoutIntentSettlement =
    | Readonly<{ kind: 'routed'; worktree?: 'new' }>
    | Readonly<{
        kind: 'unavailable';
        reason: 'prepared_review_workspace_unavailable';
    }>;

/**
 * The router already owns the only generic handoff for a checkout question.
 * A New Session seed does not know a worktree name or base ref, so it cannot
 * truthfully manufacture `checkoutCreationDraft`; `worktree=new` opens the
 * existing picker, whose mounted owner collects those concrete facts.
 *
 * A prepared review workspace is settled earlier, by the mounted Host API
 * handler that executes the caller's exact selected source operation and
 * rewrites the seed to `reuseWorkspace` plus the materialized directory. A
 * `preparedReviewWorkspace` intent reaching this router therefore bypassed
 * that settlement and carries no prepared directory; accepting it would
 * launch an unprepared flow, so it is refused here before any handoff or
 * navigation write.
 */
function settleNewSessionCheckoutIntent(
    checkoutIntent: PluginUiNewSessionSeedV1['checkoutIntent'],
): NewSessionCheckoutIntentSettlement {
    switch (checkoutIntent) {
        case undefined:
        case 'none':
        case 'reuseWorkspace':
            return { kind: 'routed' };
        case 'createWorktree':
        case 'ask':
            return { kind: 'routed', worktree: 'new' };
        case 'preparedReviewWorkspace':
            return {
                kind: 'unavailable',
                reason: 'prepared_review_workspace_unavailable',
            };
    }
    const unhandledIntent: never = checkoutIntent;
    return unhandledIntent;
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
    scope: ServerAccountScope;
    signal?: AbortSignal;
    isCurrent: () => boolean;
    navigateToNewSession: (input: Readonly<{
        dataId: string | null;
        draftId: string;
        worktree?: 'new';
        spawnServerId?: string;
        machineId?: string;
        directory?: string;
    }>) => void;
    createDraftId?: () => string;
    storeTempData?: typeof storeTempData;
    retireTempData?: typeof getTempData;
    writeAttachmentSeeds?: typeof writeNewSessionComposerAttachmentSeeds;
}>): SessionNewSessionSeedOutcome {
    const seed = readPluginNewSessionSeedV1(params.seed);
    if (!seed) return { kind: 'invalid', reason: 'seed_invalid' };
    // A seed that declares nothing must not navigate: it would drop the reader
    // onto the New Session screen having asked for nothing at all.
    if (
        seed.prompt === undefined
        && seed.profileId === undefined
        && seed.checkoutIntent === undefined
        && seed.placement === undefined
        && seed.candidates === undefined
        && seed.attachments === undefined
    ) return { kind: 'invalid', reason: 'seed_empty' };
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
    const checkoutSettlement = settleNewSessionCheckoutIntent(seed.checkoutIntent);
    if (checkoutSettlement.kind === 'unavailable') return checkoutSettlement;

    const draftId = (params.createDraftId ?? randomUUID)();

    // Only the mounted composer can resolve attachment contribution authority,
    // generation, presentation and the host-minted instance id. Their author
    // requests therefore wait in the Account + draft keyed pre-admission owner;
    // they never enter destructively consumed route data.
    const attachmentSeeds: readonly NewSessionComposerAttachmentSeedV1[] = (seed.attachments ?? [])
        .map((attachment) => ({
            pluginId: pluginId ?? '',
            attachmentLocalId: attachment.attachmentLocalId,
            value: attachment.value,
        }));
    const placementCandidates = seed.candidates ?? [];
    // Ordinary fields and unresolved placement candidates remain a one-shot
    // route handoff. Nothing becomes a canonical draft until the incumbent
    // mounted New Session owner accepts this navigation.
    const dataId = (params.storeTempData ?? storeTempData)({
        ...(seed.prompt === undefined ? {} : { prompt: seed.prompt }),
        ...(seed.profileId === undefined ? {} : { selectedProfileId: seed.profileId }),
        ...(seed.placement?.machineId === undefined ? {} : { machineId: seed.placement.machineId }),
        ...(seed.placement?.directory === undefined ? {} : { directory: seed.placement.directory }),
        ...(placementCandidates.length === 0
            ? {}
            : { pluginNewSessionSeed: { placementCandidates } }),
    } satisfies NewSessionData);
    const attachmentSeedAddress = { scope: params.scope, draftId } as const;
    if (attachmentSeeds.length > 0) {
        (params.writeAttachmentSeeds ?? writeNewSessionComposerAttachmentSeeds)(
            attachmentSeedAddress,
            attachmentSeeds,
        );
    }

    try {
        params.navigateToNewSession({
            dataId,
            draftId,
            ...(checkoutSettlement.worktree === undefined ? {} : { worktree: checkoutSettlement.worktree }),
            ...(seed.placement?.serverId === undefined ? {} : { spawnServerId: seed.placement.serverId }),
            ...(seed.placement?.machineId === undefined ? {} : { machineId: seed.placement.machineId }),
            ...(seed.placement?.directory === undefined ? {} : { directory: seed.placement.directory }),
        });
    } catch {
        // Navigation was refused synchronously. Retire the exact one-shot
        // handoff and leave no durable draft for a retry to duplicate.
        (params.retireTempData ?? getTempData)(dataId);
        if (attachmentSeeds.length > 0) {
            (params.writeAttachmentSeeds ?? writeNewSessionComposerAttachmentSeeds)(
                attachmentSeedAddress,
                [],
            );
        }
        return { kind: 'unavailable', reason: 'navigation_unavailable' };
    }
    return { kind: 'opened', dataId };
}
