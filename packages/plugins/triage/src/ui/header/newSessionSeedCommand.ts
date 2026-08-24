import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type {
    ComposerAttachmentAuthorValueV1,
    PluginUiSessionPlacementCandidateV1,
} from '@happier-dev/plugin-sdk/ui';

/**
 * The one path to "put this on the host's New Session screen and open it".
 *
 * It extends the same literal host arm the draft command asks through:
 * `serverStartDraft` either settles reader choices to this plugin or, when a
 * seed is supplied, hands the screen that seed and returns no draft. After that the
 * screen's canonical snapshot owns every edit and the send, so Triage never
 * holds a competing draft and never learns what the reader did with it.
 *
 * Attachments travel as the AUTHOR half only — `{ attachmentLocalId, value }`,
 * exactly what a live composer transaction carries. The qualified identity, the
 * type label, the cardinality upsert and the instance id are minted by the New
 * Session composer at its own mount, which is the only place they exist.
 *
 * The module owns no state and makes no decision: it does not build the seed,
 * resolve a prompt, choose a directory, or interpret what the reader does next.
 */

const NEW_SESSION_SEED_REQUEST = Object.freeze({
    action: 'session.spawn_new',
    projection: 'serverStartDraft',
} as const);

export type TriageNewSessionSeedV1 = Readonly<{
    prompt?: Readonly<{ text: string; mode: 'replace' | 'append' }>;
    profileId?: string;
    placement?: Readonly<{ serverId?: string; machineId?: string; directory?: string }>;
    /** Exact choices for the New Session owner; never auto-selected by Triage. */
    candidates?: readonly PluginUiSessionPlacementCandidateV1[];
    attachments?: readonly Readonly<{
        attachmentLocalId: string;
        value: ComposerAttachmentAuthorValueV1;
    }>[];
}>;

export type TriageNewSessionSeedHostV1 = Readonly<{
    version(): Readonly<{ methods: readonly string[] }>;
    selectActionInput(
        request: Readonly<{
            hostAction: typeof NEW_SESSION_SEED_REQUEST;
            seed: TriageNewSessionSeedV1;
        }>,
        options?: PluginCancellationOptions,
    ): Promise<unknown>;
}>;

export type TriageNewSessionSeedResultV1 =
    /** The host wrote the seed and opened its own New Session screen. */
    | Readonly<{ status: 'seeded' }>
    /** This mount installs no Action-input selection at all. */
    | Readonly<{ status: 'unsupported' }>
    /** The screen could not be opened, or the host refused the seed. */
    | Readonly<{ status: 'unavailable' }>;

export async function requestTriageNewSessionSeed(
    host: TriageNewSessionSeedHostV1,
    seed: TriageNewSessionSeedV1,
    options?: PluginCancellationOptions,
): Promise<TriageNewSessionSeedResultV1> {
    let installed: readonly string[];
    try {
        installed = host.version().methods;
    } catch {
        return { status: 'unsupported' };
    }
    if (!installed.includes('selectActionInput')) return { status: 'unsupported' };

    let selected: unknown;
    try {
        selected = await host.selectActionInput({ hostAction: NEW_SESSION_SEED_REQUEST, seed }, options);
    } catch {
        return { status: 'unavailable' };
    }
    if (typeof selected !== 'object' || selected === null) return { status: 'unavailable' };
    // The host's own discriminant, not a presence check: a seeded settlement
    // deliberately carries nothing else, so `kind` is all there is to read.
    return (selected as Readonly<{ kind?: unknown }>).kind === 'newSessionSeeded'
        ? { status: 'seeded' }
        : { status: 'unavailable' };
}
