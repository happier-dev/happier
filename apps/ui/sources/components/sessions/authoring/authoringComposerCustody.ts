import type { ComposerCapabilitiesV1, ComposerSnapshotV1 } from '@happier-dev/protocol/plugins/ui/composer';
import type { ComposerRefV1} from '@happier-dev/protocol/plugins/ui/composerRef';
import * as React from 'react';

import type { ScopedAuthoringDocument } from '@/components/sessions/authoring/ScopedAuthoringComposer';
import {
    createEphemeralComposerDocumentOwner,
    type ComposerDraftDocument,
    type MutableComposerDocumentOwner,
} from '@/components/sessions/composer/composerDocumentOwner';
import {
    composerAttachmentViewToDraft,
    composerReferencesFromStructuredMentions,
    composerStructuredMentionsFromReferences,
    placePositionlessComposerReferences,
} from '@/components/sessions/composer/composerScopeAdapters';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import {
    notifyComposerPresentationTargetChanged,
    registerComposerPresentationTarget,
    type ComposerPresentationAttachmentComposition,
    type ComposerPresentationTarget,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { randomUUID } from '@/platform/randomUUID';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createAuthoringComposerPresentation } from './authoringComposerPresentation';

/**
 * Custody of a live authoring composer, held above the surface that places it.
 *
 * A portable authored document is deliberately lossy: it stores positionless
 * references and no device-local bytes, because a saved definition must not
 * carry an offset into text it no longer owns. Everything that loss costs —
 * the exact occurrence each mention is bound to, staged attachment content,
 * and the caret — therefore lives in the document's retained custody.
 *
 * The recursive block editor re-parents a block when it moves into or out of a
 * group, which React commits as an unmount and a remount. If the composer owned
 * its own document, that move rebuilt the document from the portable form and
 * silently re-placed a mention on the *first* matching token, dropped staged
 * bytes and lost the caret. Custody is the fix: the document, its selection and
 * its exact Composer address belong to the authoring host, keyed by the block,
 * so placement changes are pure presentation. Custody ends only when the block
 * itself does.
 */

/** Where the caret or an active range sits in a composed document. */
export type AuthoringComposerSelection = Readonly<{ start: number; end: number }>;

/**
 * The addressed document's live draft callbacks, independent of input demand.
 *
 * The document outlives any one mount, so the owner cannot close over a single
 * mount's callbacks. Workflow editing binds its page writer; standalone authoring
 * uses whichever composer is currently bound. External transactions
 * require a current draft writer, so an unbound document cannot silently accept
 * edits that never reach the host's portable draft.
 */
export type AuthoringComposerBinding = Readonly<{
    isCurrent: () => boolean;
    onDocumentChange: (document: ComposerDraftDocument) => void;
}>;

/** The mounted authoring host owns writes/focus even while a row is only a summary. */
export type AuthoringComposerHostBinding = Readonly<{
    readDocument: (blockId: string) => ScopedAuthoringDocument | null;
    onDocumentChange: (blockId: string, document: ScopedAuthoringDocument) => void;
    focusDocument: (blockId: string) => void;
    editable: () => boolean;
    presented: () => boolean;
    readAttachmentComposition: (accountLifetime: ServerAccountScopeLifetime | null) => ComposerPresentationAttachmentComposition | null;
}>;

/** One block's retained composer. */
export type AuthoringComposerCustodyEntry = Readonly<{
    /** The stable exact Composer address, identical across every placement. */
    ref: ComposerRefV1;
    /** The admitting Account follows custody, including across input re-placement. */
    captureAccountCurrentness(): ReturnType<typeof captureActiveServerAccountScopeCurrentness>;
    /**
     * The restore generation the composer's selection restore is keyed by. It is
     * stable per entry: each freshly mounted input consumes it exactly once, so
     * a remount resumes the caret while ordinary typing is never interrupted.
     */
    selectionRestoreToken: string;
    /**
     * The retained live document, built from `createInitialDocument` only the
     * first time this block is composed.
     */
    resolveDocumentOwner(input: Readonly<{
        capabilities: ComposerCapabilitiesV1;
        createInitialDocument: () => ComposerDraftDocument;
    }>): MutableComposerDocumentOwner;
    /**
     * The retained live document without composing one: the adopted document,
     * a handed-over seed not yet adopted, or `null` before this block was ever
     * composed. A placement that shows the document without mounting the live
     * composer reads its exact ranges and staged attachments here.
     */
    readDocument(): ComposerDraftDocument | null;
    /** Binds the draft writer; the returned function releases only that binding. */
    bind(binding: AuthoringComposerBinding): () => void;
    /** Adopts a genuine host edit while preserving the exact document on its portable echo. */
    synchronizeDocument(document: ScopedAuthoringDocument): void;
    /** A host-owned registration survives releasing the mounted row's presentation. */
    registerPresentationTarget(target: ComposerPresentationTarget): () => void;
    readSelection(): AuthoringComposerSelection | null;
    writeSelection(selection: AuthoringComposerSelection): void;
}>;

/**
 * The portable projection of a live document: what a saved definition may hold.
 *
 * Mention ranges and staged attachment content are deliberately dropped, because
 * a stored definition must not carry an offset into text it no longer owns or
 * device-local bytes. That makes the projection one-way, so the host stores it
 * and hands it straight back — and re-adopting that echo re-places every mention
 * at the leftmost matching token and discards staged content. Comparing the
 * incoming document against this projection of the live one is how an echo is
 * told apart from a genuine host edit, at any point in the document's life
 * rather than only within one mount.
 */
export function projectPortableAuthoringDocument(
    document: ComposerDraftDocument,
): ScopedAuthoringDocument {
    return {
        text: document.text,
        references: composerReferencesFromStructuredMentions({
            text: document.text,
            mentions: document.structuredInputMentions,
        }).map(({ start: _start, end: _end, ...reference }) => reference),
        attachments: document.composerAttachments.map((attachment) => {
            const { content: _content, ...portable } = attachment;
            return portable;
        }),
    };
}

/**
 * An exact live document composed elsewhere, handed to one block's custody.
 *
 * New Session's Automation chip composes a prompt in another composer. The
 * portable draft it hands over cannot carry what its composer held — the exact
 * occurrence each mention is bound to, staged bytes, the caret — so the exact
 * document travels beside it and custody adopts it instead of rebuilding the
 * block from the portable form.
 */
export type AuthoringComposerSeed = Readonly<{
    blockId: string;
    document: ComposerDraftDocument;
    selection: AuthoringComposerSelection | null;
}>;

/**
 * Adopts a live Composer snapshot as a custody seed. Availability is a fact of
 * the composing scope, so the destination re-derives it from its own catalog;
 * everything the author placed — ranges, reference identity, staged content —
 * is kept exactly.
 */
export function authoringComposerSeedFromSnapshot(
    blockId: string,
    snapshot: Pick<ComposerSnapshotV1, 'text' | 'references' | 'attachments' | 'selection'>,
): AuthoringComposerSeed {
    return {
        blockId,
        document: {
            text: snapshot.text,
            structuredInputMentions: composerStructuredMentionsFromReferences({
                references: snapshot.references,
                existing: [],
            }),
            composerAttachments: snapshot.attachments.map(
                ({ availability: _availability, ...attachment }) => composerAttachmentViewToDraft(attachment),
            ),
        },
        selection: snapshot.selection ?? null,
    };
}

/** A live staged attachment the portable definition cannot carry. */
export type AuthoringComposerStagedAttachment = Readonly<{ blockId: string; index: number }>;

export type WorkflowAuthoringComposerCustody = Readonly<{
    /** This block's retained composer, created on first use. */
    entryFor(blockId: string): AuthoringComposerCustodyEntry;
    /** Absent for read-only Runs and standalone scoped authoring: their mount lifetime is unchanged. */
    bindHost(binding: AuthoringComposerHostBinding): () => void;
    /** Ends custody for every block the draft no longer contains. */
    retainOnly(blockIds: Iterable<string>): void;
    /**
     * Staged attachment content currently held by retained composers.
     *
     * Device-local bytes never reach the portable draft, so the host reads them
     * here to raise the canonical `unsupported_persisted_attachment` issue
     * rather than letting Save drop them silently.
     */
    readStagedAttachments(): readonly AuthoringComposerStagedAttachment[];
    /** The same fact as one comparable value, for a render subscription. */
    readStagedAttachmentKey(): string;
    observe(listener: () => void): () => void;
}>;

type CustodyRecord = {
    entry: AuthoringComposerCustodyEntry;
    owner: MutableComposerDocumentOwner | null;
    binding: AuthoringComposerBinding | null;
    selection: AuthoringComposerSelection | null;
    /** A handed-over document not yet adopted by the block's first composer. */
    seed: ComposerDraftDocument | null;
    adoptingHostDocument: boolean;
    hostDocument: ScopedAuthoringDocument | null;
    presentation: ReturnType<typeof createAuthoringComposerPresentation> | null;
};

export function createWorkflowAuthoringComposerCustody(
    draftId: string,
    seeds: readonly AuthoringComposerSeed[] = [],
): WorkflowAuthoringComposerCustody {
    const records = new Map<string, CustodyRecord>();
    let host: AuthoringComposerHostBinding | null = null;
    let accountCurrentness: ReturnType<typeof captureActiveServerAccountScopeCurrentness> | null = null;
    const listeners = new Set<() => void>();
    const notify = (): void => {
        for (const listener of listeners) listener();
    };

    const entryFor = (blockId: string): AuthoringComposerCustodyEntry => {
        const existing = records.get(blockId);
        if (existing !== undefined) return existing.entry;
        const instanceId = randomUUID();
        const ref: ComposerRefV1 = { kind: 'workflowAuthoring', draftId, blockId, instanceId };
        const record: CustodyRecord = {
            entry: null as unknown as AuthoringComposerCustodyEntry,
            owner: null,
            binding: null,
            selection: null,
            seed: null,
            adoptingHostDocument: false,
            hostDocument: null,
            presentation: null,
        };
        record.entry = Object.freeze({
            ref,
            captureAccountCurrentness: () => {
                accountCurrentness ??= captureActiveServerAccountScopeCurrentness();
                return accountCurrentness;
            },
            selectionRestoreToken: instanceId,
            resolveDocumentOwner: (input) => {
                if (record.owner === null) {
                    record.owner = createEphemeralComposerDocumentOwner({
                        ref,
                        capabilities: input.capabilities,
                        initialDocument: record.seed ?? input.createInitialDocument(),
                        isCurrent: () => records.get(blockId) === record && (host !== null
                            ? host.editable() && accountCurrentness?.isCurrent() === true
                            : record.binding?.isCurrent() === true),
                        onDocumentChange: (document) => {
                            if (host !== null) {
                                if (!record.adoptingHostDocument) host.onDocumentChange(blockId, projectPortableAuthoringDocument(document));
                                notifyComposerPresentationTargetChanged(ref);
                            } else record.binding?.onDocumentChange(document);
                        },
                    });
                    record.seed = null;
                    record.owner.observe(notify);
                }
                return record.owner;
            },
            readDocument: () => record.owner?.read().document ?? record.seed,
            bind: (binding) => {
                record.binding = binding;
                return () => {
                    // A move mounts the next placement before the previous one
                    // finishes tearing down in some commit orders; only the
                    // binding that is still installed may clear itself.
                    if (record.binding === binding) record.binding = null;
                };
            },
            synchronizeDocument: (document) => {
                // Re-reading the same host projection between a write and its React echo must not
                // adopt the old bytes over the document we just changed. New host edits/Undo carry
                // a new immutable document, as the mounted adapter's effect dependency does.
                if (record.hostDocument === document) return;
                record.hostDocument = document;
                const owner = record.owner;
                if (owner === null || pluginJsonValuesEqual(projectPortableAuthoringDocument(owner.read().document), document)) return;
                record.adoptingHostDocument = true;
                try {
                    owner.replaceDocument({ text: document.text,
                        structuredInputMentions: composerStructuredMentionsFromReferences({
                            references: placePositionlessComposerReferences({ text: document.text, references: document.references }),
                            existing: owner.read().document.structuredInputMentions,
                        }), composerAttachments: document.attachments,
                    });
                } finally { record.adoptingHostDocument = false; }
            },
            registerPresentationTarget: (target) => {
                if (host === null) return registerComposerPresentationTarget(ref, target);
                if (record.owner === null) throw new Error('An authoring presentation requires its document owner');
                record.presentation ??= createAuthoringComposerPresentation({
                    owner: record.owner,
                    isCurrent: () => records.get(blockId) === record && host !== null && accountCurrentness?.isCurrent() === true,
                    readScope: () => accountCurrentness && 'scope' in accountCurrentness ? accountCurrentness.scope : null,
                    readSelection: () => record.selection,
                    synchronizeDocument: () => {
                        const document = host?.readDocument(blockId);
                        if (document) record.entry.synchronizeDocument(document);
                    },
                    readAttachmentComposition: () => host?.readAttachmentComposition(
                        accountCurrentness && 'scope' in accountCurrentness ? accountCurrentness : null,
                    ) ?? null,
                    editable: () => host?.editable() === true,
                    presented: () => host?.presented() === true,
                    focus: () => host?.focusDocument(blockId),
                });
                return record.presentation.mount(target);
            },
            readSelection: () => record.selection,
            writeSelection: (selection) => { record.selection = selection; },
        });
        records.set(blockId, record);
        return record.entry;
    };
    for (const seed of seeds) {
        entryFor(seed.blockId);
        const record = records.get(seed.blockId)!;
        record.seed = seed.document;
        record.selection = seed.selection;
    }

    const readStagedAttachments = (): readonly AuthoringComposerStagedAttachment[] => {
        const staged: AuthoringComposerStagedAttachment[] = [];
        for (const [blockId, record] of records) {
            // A seed not yet adopted still holds its bytes: Save must refuse
            // them even before the block's composer first mounts.
            const document = record.owner?.read().document ?? record.seed;
            const attachments = document?.composerAttachments ?? [];
            attachments.forEach((attachment, index) => {
                if (attachment.content !== undefined) staged.push({ blockId, index });
            });
        }
        return staged;
    };

    return Object.freeze({
        entryFor,
        bindHost: (binding) => {
            host = binding;
            return () => {
                if (host !== binding) return;
                host = null;
                for (const record of records.values()) {
                    record.presentation?.dispose();
                    record.presentation = null;
                }
            };
        },
        retainOnly: (blockIds) => {
            const retained = new Set(blockIds);
            let released = false;
            for (const blockId of [...records.keys()]) {
                // A same-id edit can replace a prompt with an Action/container. The page's
                // document owner, not continued membership in its block list, owns that lifetime.
                if (retained.has(blockId) && (host === null || host.readDocument(blockId) !== null)) continue;
                records.get(blockId)?.presentation?.dispose();
                records.delete(blockId);
                released = true;
            }
            if (released) notify();
        },
        readStagedAttachments,
        readStagedAttachmentKey: () => readStagedAttachments()
            .map((staged) => `${staged.blockId}/${staged.index}`)
            .join('|'),
        observe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    });
}

/**
 * The authoring host's custody for one draft.
 *
 * Deletion is the only thing that ends custody, so the retained set is the
 * draft's own block ids rather than a mount refcount: a block that is between
 * two placements has no mounted composer and must still keep its document.
 */
export function useWorkflowAuthoringComposerCustody(input: Readonly<{
    draftId: string;
    blockIds: readonly string[];
    /** Exact documents handed over with the draft; adopted by the first custody only. */
    seeds?: readonly AuthoringComposerSeed[];
    host?: AuthoringComposerHostBinding;
}>): WorkflowAuthoringComposerCustody {
    const stateRef = React.useRef<Readonly<{
        draftId: string;
        custody: WorkflowAuthoringComposerCustody;
    }> | null>(null);
    if (stateRef.current === null || stateRef.current.draftId !== input.draftId) {
        stateRef.current = {
            draftId: input.draftId,
            custody: createWorkflowAuthoringComposerCustody(
                input.draftId,
                stateRef.current === null ? input.seeds : undefined,
            ),
        };
    }
    const custody = stateRef.current.custody;
    const { host } = input;
    React.useLayoutEffect(() => host === undefined ? undefined : custody.bindHost(host), [custody, host]);
    const { blockIds } = input;
    React.useEffect(() => {
        custody.retainOnly(blockIds);
    }, [blockIds, custody]);
    return custody;
}

/**
 * The React lifetime adapter for a custody-held composer document.
 *
 * Semantic revision ownership stays in the document owner and lifetime stays in
 * custody; React owns only the render subscription and the current callbacks.
 */
export function useAuthoringComposerDocumentOwner(input: Readonly<{
    custody: AuthoringComposerCustodyEntry;
    capabilities: ComposerCapabilitiesV1;
    createInitialDocument: () => ComposerDraftDocument;
    isCurrent: () => boolean;
    onDocumentChange: (document: ComposerDraftDocument) => void;
}>): MutableComposerDocumentOwner {
    const latestInputRef = React.useRef(input);
    latestInputRef.current = input;
    const owner = input.custody.resolveDocumentOwner({
        capabilities: input.capabilities,
        createInitialDocument: input.createInitialDocument,
    });
    const binding = React.useMemo<AuthoringComposerBinding>(() => ({
        isCurrent: () => latestInputRef.current.isCurrent(),
        onDocumentChange: (document) => latestInputRef.current.onDocumentChange(document),
    }), []);
    const custody = input.custody;
    React.useLayoutEffect(() => custody.bind(binding), [binding, custody]);
    React.useSyncExternalStore(owner.observe, () => owner.read().revision, () => owner.read().revision);
    return owner;
}
