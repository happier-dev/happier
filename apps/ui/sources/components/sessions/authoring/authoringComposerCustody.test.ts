import { describe, expect, it, vi } from 'vitest';
import { createWorkflowAuthoringComposerCustody } from './authoringComposerCustody';

let issued = 0;
vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => {
        issued += 1;
        return `instance-${issued}`;
    },
}));

const CAPABILITIES = { text: true, references: true, attachments: true, submit: false } as const;

function documentWith(text: string) {
    return () => ({ text, structuredInputMentions: [], composerAttachments: [] });
}

const STAGED_ATTACHMENT = {
    v: 1,
    instanceId: 'attachment-staged',
    attachment: { pluginId: 'acme.issues', localId: 'issue' },
    key: 'issue-42',
    value: { issueId: 42 },
    presentation: { label: 'Issue #42', typeLabel: 'Issue' },
    content: {
        kind: 'stagedMedia',
        handle: {
            v: 1,
            id: 'stage-42',
            executionTarget: { serverId: 'server-a', machineId: 'machine-1' },
            owner: { pluginId: 'acme.issues', localId: 'issue' },
            mediaKind: 'image',
            mimeType: 'image/png',
            name: 'issue-42.png',
            sizeBytes: 12,
            sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
    },
} as const;

describe('workflow authoring composer custody', () => {
    it('keeps one composer identity and one live document for a block across placements', async () => {
        const custody = createWorkflowAuthoringComposerCustody('draft-1');

        const entry = custody.entryFor('analyze');
        const owner = entry.resolveDocumentOwner({
            capabilities: CAPABILITIES,
            createInitialDocument: documentWith('Analyze the repository'),
        });
        owner.replaceDocument({
            text: 'Analyze the repository twice',
            structuredInputMentions: [],
            composerAttachments: [],
        });
        entry.writeSelection({ start: 4, end: 9 });

        // A later placement asks for the same block and must be handed the same
        // document, not a new one seeded from the portable form.
        const relocated = custody.entryFor('analyze');
        expect(relocated).toBe(entry);
        expect(relocated.ref).toEqual({
            kind: 'workflowAuthoring',
            draftId: 'draft-1',
            blockId: 'analyze',
            instanceId: 'instance-1',
        });
        expect(relocated.resolveDocumentOwner({
            capabilities: CAPABILITIES,
            createInitialDocument: documentWith('Analyze the repository'),
        })).toBe(owner);
        expect(owner.read().document.text).toBe('Analyze the repository twice');
        expect(relocated.readSelection()).toEqual({ start: 4, end: 9 });
    });

    it('routes document changes to the current draft binding and refuses unbound transactions', async () => {
        const custody = createWorkflowAuthoringComposerCustody('draft-2');
        const entry = custody.entryFor('analyze');
        const owner = entry.resolveDocumentOwner({
            capabilities: CAPABILITIES,
            createInitialDocument: documentWith('Draft'),
        });

        const first = vi.fn();
        const releaseFirst = entry.bind({ isCurrent: () => true, onDocumentChange: first });
        const second = vi.fn();
        // The next placement mounts before the previous one finishes tearing
        // down, so a late release must not unbind the live composer.
        const releaseSecond = entry.bind({ isCurrent: () => true, onDocumentChange: second });
        releaseFirst();

        owner.replaceDocument({ text: 'Draft two', structuredInputMentions: [], composerAttachments: [] });
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);

        releaseSecond();
        // Without a draft writer an external edit would mutate only custody and be lost on Save.
        expect(owner.apply(owner.read().revision, {
            text: 'Draft three',
            references: [],
            attachments: [],
        })).toMatchObject({ status: 'composerUnavailable' });
        expect(owner.read().document.text).toBe('Draft two');
    });

    it('ends custody only for blocks the draft no longer contains', async () => {
        const custody = createWorkflowAuthoringComposerCustody('draft-3');
        const analyze = custody.entryFor('analyze');
        const implement = custody.entryFor('implement');
        analyze.resolveDocumentOwner({
            capabilities: CAPABILITIES,
            createInitialDocument: documentWith('Analyze'),
        }).replaceDocument({ text: 'Analyze edited', structuredInputMentions: [], composerAttachments: [] });

        custody.retainOnly(['implement']);

        expect(custody.entryFor('implement')).toBe(implement);
        const readded = custody.entryFor('analyze');
        expect(readded).not.toBe(analyze);
        expect(readded.resolveDocumentOwner({
            capabilities: CAPABILITIES,
            createInitialDocument: documentWith('Analyze'),
        }).read().document.text).toBe('Analyze');
    });

    it.each(['deletion', 'host unmount', 'prompt replacement'] as const)('keeps the addressed document after its row closes, until %s', async ending => {
        const { projectComposerDocumentSnapshot } = await import('@/components/sessions/composer/composerSnapshotProjection');
        const { applyComposerPresentationTransaction, readComposerPresentationSnapshot, requestRegisteredComposerFocus } =
            await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
        const custody = createWorkflowAuthoringComposerCustody('host-lifetime');
        const entry = custody.entryFor('analyze');
        entry.captureAccountCurrentness();
        const initial = { text: 'Draft', references: [], attachments: [] };
        let hostDocument: typeof initial | null = initial;
        const edits: string[] = [];
        let focused: string | null = null;
        const releaseHost = custody.bindHost({
            readDocument: () => hostDocument,
            onDocumentChange: (_blockId, document) => { edits.push(document.text); },
            focusDocument: blockId => { focused = blockId; },
            editable: () => true, presented: () => true, readAttachmentComposition: () => null,
        });
        const owner = entry.resolveDocumentOwner({ capabilities: CAPABILITIES, createInitialDocument: documentWith('Draft') });
        const releaseWriter = entry.bind({ isCurrent: () => true,
            onDocumentChange: () => { throw new Error('The former row must not write the draft'); },
        });
        let rowMounted = true;
        const releasePresentation = entry.registerPresentationTarget({
            readRevision: () => owner.read().revision,
            replace: () => { throw new Error('The former row must not replace the document'); },
            readSnapshot: () => {
                if (!rowMounted) throw new Error('The former row must not answer a snapshot');
                return projectComposerDocumentSnapshot({ owner, attachmentCatalog: { entriesById: null },
                    presentation: { layout: 'wrap', focused: false, editable: true, submittable: false, submitting: false, running: false },
                });
            },
        });
        try {
            entry.synchronizeDocument(hostDocument);
            releasePresentation();
            releaseWriter();
            rowMounted = false;
            expect(readComposerPresentationSnapshot(entry.ref)).toMatchObject({ text: 'Draft', ref: entry.ref });
            for (const text of [' one', ' two']) {
                const snapshot = readComposerPresentationSnapshot(entry.ref)!;
                expect(applyComposerPresentationTransaction({ ref: entry.ref, transaction: { expectedRevision: snapshot.revision,
                    operations: [{ kind: 'text.insert', position: { offset: snapshot.text.length }, text }],
                } })).toMatchObject({ status: 'applied' });
            }
            // Both transactions happen before React echoes a new portable projection.
            expect(readComposerPresentationSnapshot(entry.ref)?.text).toBe('Draft one two');
            expect(edits).toEqual(['Draft one', 'Draft one two']);
            expect(requestRegisteredComposerFocus(entry.ref)).toBe(true);
            expect(focused).toBe('analyze');

            hostDocument = { ...initial, text: 'Host Undo' };
            expect(readComposerPresentationSnapshot(entry.ref)?.text).toBe('Host Undo');
            expect(edits).toHaveLength(2); // Adopting Undo never creates a new draft edit.
            if (ending === 'deletion') custody.retainOnly([]);
            else if (ending === 'host unmount') releaseHost();
            else {
                hostDocument = null;
                custody.retainOnly(['analyze']);
            }
            expect(readComposerPresentationSnapshot(entry.ref)).toBeNull();
            expect(owner.apply(owner.read().revision, { text: 'Deleted', references: [], attachments: [] }))
                .toMatchObject({ status: 'composerUnavailable' });
        } finally { releaseHost(); }
    });

    /**
     * A document composed somewhere else — New Session's composer, handed over
     * by the Automation chip — arrives with everything the portable draft
     * drops: which of two equal tokens a mention is bound to, staged bytes and
     * the caret. Custody adopts that exact document for its block instead of
     * rebuilding it from the portable form, and adopts it only once.
     */
    it('adopts an exact seeded document once, keeping the bound occurrence, staged bytes and caret', async () => {
        const text = 'Compare @issue with @issue';
        const secondTokenStart = 'Compare @issue with '.length;
        const seededDocument = {
            text,
            structuredInputMentions: [{
                kind: 'partner.reference',
                ref: 'partner:issue-42',
                label: 'Issue #42',
                tokenText: '@issue',
                start: secondTokenStart,
                end: secondTokenStart + '@issue'.length,
            }],
            composerAttachments: [STAGED_ATTACHMENT],
        } as never;
        const custody = createWorkflowAuthoringComposerCustody('draft-5', [{
            blockId: 'analyze',
            document: seededDocument,
            selection: { start: 3, end: 7 },
        }]);

        // Staged bytes block Save before any composer has mounted.
        expect(custody.readStagedAttachments()).toEqual([{ blockId: 'analyze', index: 0 }]);
        const entry = custody.entryFor('analyze');
        expect(entry.readSelection()).toEqual({ start: 3, end: 7 });

        const createInitialDocument = vi.fn(documentWith(text));
        const owner = entry.resolveDocumentOwner({ capabilities: CAPABILITIES, createInitialDocument });
        expect(createInitialDocument).not.toHaveBeenCalled();
        expect(owner.read().document.structuredInputMentions).toEqual([
            expect.objectContaining({ start: secondTokenStart, end: secondTokenStart + '@issue'.length }),
        ]);
        expect(owner.read().document.composerAttachments).toEqual([STAGED_ATTACHMENT]);

        // Once a block's custody ends, a re-added block starts fresh: the seed
        // was consumed, not retained as a second copy.
        custody.retainOnly([]);
        const fresh = custody.entryFor('analyze').resolveDocumentOwner({
            capabilities: CAPABILITIES,
            createInitialDocument: documentWith('Fresh'),
        });
        expect(fresh.read().document.text).toBe('Fresh');
        expect(custody.readStagedAttachments()).toEqual([]);
    });

    it('reports live staged attachment bytes the portable draft cannot carry', async () => {
        const custody = createWorkflowAuthoringComposerCustody('draft-4');
        const entry = custody.entryFor('analyze');
        const owner = entry.resolveDocumentOwner({
            capabilities: CAPABILITIES,
            createInitialDocument: documentWith('Attach'),
        });
        const observed = vi.fn();
        custody.observe(observed);
        expect(custody.readStagedAttachments()).toEqual([]);

        owner.replaceDocument({
            text: 'Attach',
            structuredInputMentions: [],
            composerAttachments: [{
                v: 1,
                instanceId: 'attachment-staged',
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                key: 'issue-42',
                value: { issueId: 42 },
                presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                content: {
                    kind: 'stagedMedia',
                    handle: {
                        v: 1,
                        id: 'stage-42',
                        executionTarget: { serverId: 'server-a', machineId: 'machine-1' },
                        owner: { pluginId: 'acme.issues', localId: 'issue' },
                        mediaKind: 'image',
                        mimeType: 'image/png',
                        name: 'issue-42.png',
                        sizeBytes: 12,
                        sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
                    },
                },
            }] as never,
        });

        expect(observed).toHaveBeenCalled();
        expect(custody.readStagedAttachments()).toEqual([{ blockId: 'analyze', index: 0 }]);
        expect(custody.readStagedAttachmentKey()).toBe('analyze/0');
    });
});
