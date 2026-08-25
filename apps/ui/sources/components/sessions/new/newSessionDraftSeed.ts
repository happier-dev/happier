import type { ComposerAttachmentAuthorValueV1 } from '@happier-dev/protocol';
import type { PluginUiSessionPlacementCandidateV1 } from '@happier-dev/protocol/plugins/ui';

import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import { writeNewSessionDraftToRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { randomUUID } from '@/platform/randomUUID';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';

/**
 * The ONE way anything outside the New Session screen puts something into that
 * screen's draft before opening it.
 *
 * The screen's persisted scoped draft is already the surface that survives the
 * navigation: it carries the composer text, the selected profile, the machine,
 * the directory and the canonical contentless composer attachments. Seeding is
 * therefore a merge into that draft, not a second parallel draft that the real
 * composer would then have to reconcile with — after this write the screen's own
 * canonical snapshot owns every subsequent edit and the send.
 *
 * A seed declares only what it means to set. An ABSENT member is "not seeded"
 * and leaves the reader's existing value alone; it never reads as "seeded
 * empty", because a caller that only wants to add a prompt must not silently
 * clear a directory the reader had already picked.
 *
 * Composer ATTACHMENTS are deliberately not written into the draft here. The
 * persisted draft carries finished `ComposerAttachmentDraftV1` records —
 * host-minted instance id, host-qualified contribution identity, host-resolved
 * type label — and only a mounted composer target resolves those. A seeder that
 * wrote them would be a second, unauthoritative attachment owner. A seed
 * therefore carries the author-shaped REQUEST, which the existing one-shot
 * `tempDataStore` handoff holds until the real composer mounts and applies it
 * through the one attachment authority.
 */

export type NewSessionDraftPromptSeedV1 = Readonly<{
    text: string;
    /**
     * `append` is what a caller that may fire repeatedly needs — a second
     * transcript selection joins the first rather than erasing it. `replace` is
     * what a caller resolving one authoritative prompt needs.
     */
    mode: 'replace' | 'append';
}>;

export type NewSessionDraftPlacementSeedV1 = Readonly<{
    serverId?: string;
    machineId?: string;
    directory?: string;
}>;

/**
 * One author-shaped composer attachment request, exactly as a live
 * `attachment.add` carries it. The seeding plugin is recorded beside it because
 * the mount qualifies the local id against that plugin, the same way the live
 * transaction path does.
 */
export type NewSessionDraftAttachmentSeedV1 = Readonly<{
    attachmentLocalId: string;
    value: ComposerAttachmentAuthorValueV1;
}>;

export type NewSessionDraftSeedV1 = Readonly<{
    prompt?: NewSessionDraftPromptSeedV1;
    profileId?: string;
    placement?: NewSessionDraftPlacementSeedV1;
    /**
     * An unresolved placement stays outside the persisted New Session draft.
     * The screen's mounted placement chooser consumes it before it writes a
     * concrete server/machine/path selection through the existing owner.
     */
    candidates?: readonly PluginUiSessionPlacementCandidateV1[];
    attachments?: readonly NewSessionDraftAttachmentSeedV1[];
}>;

function normalizedNonEmpty(value: string | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function joinDraftInput(existingInput: string, promptText: string): string {
    if (existingInput.trim().length === 0) return promptText;
    return `${existingInput.trimEnd()}\n\n${promptText.trimStart()}`;
}

/**
 * Whether this seed asks for any change at all.
 *
 * A seed that declares nothing must not be written: the write would stamp
 * `updatedAt` and force `entryIntent` on a draft the reader is still editing.
 */
export function newSessionDraftSeedDeclaresChangeV1(seed: NewSessionDraftSeedV1): boolean {
    return normalizedNonEmpty(seed.prompt?.text) !== null
        || normalizedNonEmpty(seed.profileId) !== null
        || normalizedNonEmpty(seed.placement?.serverId) !== null
        || normalizedNonEmpty(seed.placement?.machineId) !== null
        || normalizedNonEmpty(seed.placement?.directory) !== null
        // Candidate placement is a real user-visible request even though it
        // cannot become a persisted selection until the reader picks one.
        || (seed.candidates?.length ?? 0) > 0
        // Attaching a selection and nothing else is a whole intent: "open New
        // Session with these entries on it" carries no prompt of its own, and
        // reading it as an empty seed would refuse the destination outright.
        || (seed.attachments?.length ?? 0) > 0;
}

/**
 * The fresh-draft shape a seed lands on when the scope holds none. It exists
 * once, here, so a second seeding caller cannot declare a different idea of
 * what an empty New Session draft is.
 */
function emptyNewSessionDraft(updatedAt: number): NewSessionDraft {
    return {
        input: '',
        selectedMachineId: null,
        selectedPath: null,
        entryIntent: 'session',
        selectedProfileId: null,
        selectedSecretId: null,
        agentType: DEFAULT_AGENT_ID,
        permissionMode: 'default',
        modelSelection: null,
        acpSessionModeId: null,
        updatedAt,
    };
}

export function applyNewSessionDraftSeedV1(input: Readonly<{
    seed: NewSessionDraftSeedV1;
    existingDraft: NewSessionDraft | null;
    updatedAt: number;
}>): NewSessionDraft {
    const base = input.existingDraft ?? emptyNewSessionDraft(input.updatedAt);
    const promptText = normalizedNonEmpty(input.seed.prompt?.text);
    const profileId = normalizedNonEmpty(input.seed.profileId);
    const serverId = normalizedNonEmpty(input.seed.placement?.serverId);
    const machineId = normalizedNonEmpty(input.seed.placement?.machineId);
    const directory = normalizedNonEmpty(input.seed.placement?.directory);

    return {
        ...base,
        ...(promptText === null
            ? {}
            : {
                input: input.seed.prompt?.mode === 'append'
                    ? joinDraftInput(base.input, promptText)
                    : promptText,
            }),
        ...(profileId === null ? {} : { selectedProfileId: profileId }),
        ...(serverId === null ? {} : { targetServerId: serverId }),
        ...(machineId === null ? {} : { selectedMachineId: machineId }),
        ...(directory === null ? {} : { selectedPath: directory }),
        // A seeded New Session is a Session. An Automation draft left in the
        // scope would otherwise swallow the seed into an Automation definition.
        entryIntent: 'session',
        updatedAt: input.updatedAt,
    };
}

export function seedNewSessionDraftV1(input: Readonly<{
    seed: NewSessionDraftSeedV1;
    scope?: ServerAccountScope | null;
    nowMs?: () => number;
    createDraftId?: () => string;
    writeDraft?: typeof writeNewSessionDraftToRepository;
}>): string | null {
    if (!newSessionDraftSeedDeclaresChangeV1(input.seed) || !input.scope) return null;
    const scope = input.scope;
    const draftId = (input.createDraftId ?? randomUUID)();
    (input.writeDraft ?? writeNewSessionDraftToRepository)({
        scope,
        draftId,
        draft: applyNewSessionDraftSeedV1({
        seed: input.seed,
        existingDraft: null,
        updatedAt: input.nowMs?.() ?? Date.now(),
        }),
    });
    return draftId;
}
