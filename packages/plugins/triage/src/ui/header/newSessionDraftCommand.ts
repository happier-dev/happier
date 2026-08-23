import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';

/**
 * The header's one path to the host's own New Session surface.
 *
 * Ask and Fix start a Session, and a Session needs an Agent. Triage cannot name
 * one: `agentTarget.identity` is the host's backend-target vocabulary, and a
 * plugin that reconstructed it would be inventing a catalog it does not own. So
 * the reader is taken to the surface that already owns that choice — the same
 * New Session fields they use for every other Session — through the one
 * no-invoke settlement a plugin may ask the host for
 * (`packages/protocol/src/plugins/ui/hostApiRequests.ts`, `serverStartDraft`).
 *
 * Nothing is created here. The settlement is a draft: the host opens its own
 * authoring surface, settles what the reader chose, and invokes nothing. The
 * creation, the link and the open all still happen in one place, behind this
 * plugin's own start Action.
 *
 * The module owns no state and makes no decision. It does not read the draft,
 * pick a directory, mint a key or interpret an outcome.
 */

/** The literal host selection this header is allowed to ask for, and no other. */
const NEW_SESSION_DRAFT_REQUEST = Object.freeze({
    action: 'session.spawn_new',
    projection: 'serverStartDraft',
} as const);

/**
 * What a draft request needs from a mount.
 *
 * `version()` is part of the capability rather than an afterthought: the list
 * page deliberately does not declare `selectActionInput` among its required
 * host methods, because requiring it would refuse the whole page — rows,
 * filters and all — on a host that cannot select an Action input. The press
 * asks instead, and reports its own typed refusal.
 */
export type TriageNewSessionDraftHostV1 = Readonly<{
    version(): Readonly<{ methods: readonly string[] }>;
    selectActionInput(
        request: Readonly<{
            hostAction: typeof NEW_SESSION_DRAFT_REQUEST;
            draft?: Readonly<Record<string, string>>;
        }>,
        options?: PluginCancellationOptions,
    ): Promise<unknown>;
}>;

export type TriageNewSessionDraftResultV1 =
    /** The reader settled the host's New Session fields. Unread on purpose. */
    | Readonly<{ status: 'settled'; settlement: unknown }>
    /** The reader closed the surface. Nothing was chosen and nothing failed. */
    | Readonly<{ status: 'cancelled' }>
    /** This mount installs no Action-input selection at all. */
    | Readonly<{ status: 'unsupported' }>
    /** The surface could not be opened or did not answer in the host's shape. */
    | Readonly<{ status: 'unavailable' }>;

export async function requestTriageNewSessionDraft(
    host: TriageNewSessionDraftHostV1,
    seed: Readonly<Record<string, string>> | null,
    options?: PluginCancellationOptions,
): Promise<TriageNewSessionDraftResultV1> {
    let installed: readonly string[];
    try {
        installed = host.version().methods;
    } catch {
        return { status: 'unsupported' };
    }
    if (!installed.includes('selectActionInput')) return { status: 'unsupported' };

    let selected: unknown;
    try {
        selected = await host.selectActionInput({
            hostAction: NEW_SESSION_DRAFT_REQUEST,
            ...(seed ? { draft: seed } : {}),
        }, options);
    } catch {
        return { status: 'unavailable' };
    }
    // `kind`, not a member of the settled draft, is what says which arm this is
    // — the same discrimination the host's own result schema makes.
    if (typeof selected !== 'object' || selected === null) return { status: 'unavailable' };
    const kind = (selected as Readonly<{ kind?: unknown }>).kind;
    if (kind === 'cancelled') return { status: 'cancelled' };
    if (kind !== 'serverStartDraft') return { status: 'unavailable' };
    return { status: 'settled', settlement: (selected as Readonly<{ draft?: unknown }>).draft };
}
