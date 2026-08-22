import renderer, { act } from 'react-test-renderer';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import {
    PluginProjectionV2Schema,
    type ComposerAttachmentDraftV1,
    type DaemonPluginUiComposerSurfaceCatalogEntryV1,
    type PluginProjectionV2,
    type PluginProjectedComposerAttachmentEntryV1,
} from '@happier-dev/protocol';
import {
    applyComposerPresentationTransaction,
    createComposerPresentationHostHandlers,
    readComposerPresentationSnapshot,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import {
    normalizePluginUiProjection,
    type PluginUiComposerAttachmentProjection,
} from '@/sync/domains/plugins/ui/projection';

import { createNewSessionPromptStore } from './newSessionPromptStore';
import { useNewSessionComposerDocument } from './useNewSessionComposerDocument';

const pluginSurfaceHostSpy = vi.hoisted(() => vi.fn());

vi.mock('@/components/plugins/surfaces/PluginSurfaceHost', () => ({
    PluginSurfaceHost: (props: Record<string, unknown>) => {
        pluginSurfaceHostSpy(props);
        return null;
    },
}));

const issueAttachment: ComposerAttachmentDraftV1 = {
    v: 1,
    instanceId: 'issue-42',
    attachment: { pluginId: 'acme.issues', localId: 'issue' },
    key: '42',
    value: { issueId: 42 },
    presentation: { label: 'Issue #42', typeLabel: 'Issue' },
};

const noteAttachment: ComposerAttachmentDraftV1 = {
    v: 1,
    instanceId: 'note-7',
    attachment: { pluginId: 'acme.notes', localId: 'note' },
    key: '7',
    value: { noteId: 7 },
    presentation: { label: 'Note #7', typeLabel: 'Note' },
};

const issueAttachmentCatalogEntry = {
    id: 'acme.issues/issue',
    pluginId: 'acme.issues',
    identity: issueAttachment.attachment,
    immutableGenerationId: 'issues-generation-1',
    definition: {
        id: 'issue',
        title: 'Issue',
        icon: 'file',
        cardinality: 'many',
        valueSchema: {
            type: 'object',
            required: ['issueId'],
            properties: { issueId: { type: 'integer' } },
            additionalProperties: false,
        },
    },
} satisfies PluginProjectedComposerAttachmentEntryV1;

const noteAttachmentCatalogEntry = {
    id: 'acme.notes/note',
    pluginId: 'acme.notes',
    identity: noteAttachment.attachment,
    immutableGenerationId: 'notes-generation-1',
    definition: {
        id: 'note',
        title: 'Note',
        icon: 'file',
        cardinality: 'many',
        valueSchema: {
            type: 'object',
            required: ['noteId'],
            properties: { noteId: { type: 'integer' } },
            additionalProperties: false,
        },
    },
} satisfies PluginProjectedComposerAttachmentEntryV1;

function entriesById(
    entry: PluginProjectedComposerAttachmentEntryV1,
): Readonly<Record<string, PluginUiComposerAttachmentProjection>> {
    return normalizePluginUiProjection(PluginProjectionV2Schema.parse({
        v: 2,
        generation: 1,
        installedPackagesById: {},
        agentsById: {},
        backendsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {
            composerAttachments: {
                family: 'composerAttachments',
                entriesById: { [entry.id]: entry },
            },
        },
        diagnostics: [],
    })).composerAttachmentsById;
}

const newSessionRegion = {
    id: 'acme.issues/new-session-region',
    pluginId: 'acme.issues',
    identity: { pluginId: 'acme.issues', localId: 'new-session-region' },
    immutableGenerationId: 'issues-generation-1',
    definition: {
        id: 'new-session-region',
        placement: 'beforeComposer',
        scopes: ['newSession'],
    },
};

function newSessionComposerCatalogEntry(): DaemonPluginUiComposerSurfaceCatalogEntryV1 {
    return {
        contribution: newSessionRegion.identity,
        immutableGenerationId: newSessionRegion.immutableGenerationId,
        projectionGeneration: 5,
        role: 'region',
        rendererChain: [{ pluginId: 'acme.issues', localId: 'new-session-region-renderer' }],
        selectedRenderer: {
            identity: { pluginId: 'acme.issues', localId: 'new-session-region-renderer' },
            renderer: {
                kind: 'declarative',
                contributionId: 'new-session-region-renderer',
                model: { visible: true },
            },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        },
        executionOrigin: {
            serverIdentityId: 'server-1',
            materializationRef: {
                machineId: 'machine-1',
                materializationId: 'issues-materialization-1',
                pluginId: 'acme.issues',
            },
        },
        resourceCapability: { readable: true, dynamic: true },
        contributorTargetedContributions: {
            target: { pluginId: 'acme.issues', immutableGenerationId: 'issues-generation-1' },
            points: [],
        },
    } as DaemonPluginUiComposerSurfaceCatalogEntryV1;
}

afterEach(() => {
    standardCleanup();
});

describe('useNewSessionComposerDocument', () => {
    it('projects New Session regions through the shared host on the app target', async () => {
        pluginSurfaceHostSpy.mockClear();
        const promptStore = createNewSessionPromptStore('Draft prompt');
        const hook = await renderHook(() => useNewSessionComposerDocument({
            promptStore,
            persistedAttachments: [],
            composerAttachmentEntriesById: {},
            composerPluginProjection: {
                machineId: 'machine-1',
                serverId: 'server-1',
                phase: 'ready',
                inputs: {
                    pluginProjectionById: {},
                    pluginProjectionV2: {
                        v: 2,
                        generation: 5,
                        installedPackagesById: {},
                        familiesById: {
                            composerRegions: { entriesById: { [newSessionRegion.id]: newSessionRegion } },
                        },
                    } as PluginProjectionV2,
                    composerSurfaceCatalog: [newSessionComposerCatalogEntry()],
                },
            },
            scopeKey: 'server-a/account-a',
            canSubmitRef: { current: true },
            isSubmitting: false,
        }));

        await renderScreen(<>{hook.getCurrent().beforeComposer}</>);

        expect(pluginSurfaceHostSpy).toHaveBeenCalledWith(expect.objectContaining({
            composerMount: expect.objectContaining({
                physicalTarget: { kind: 'app' },
                mount: expect.objectContaining({
                    kind: 'composer',
                    mount: expect.objectContaining({
                        role: 'region',
                        input: expect.objectContaining({
                            composer: {
                                kind: 'newSession',
                                instanceId: hook.getCurrent().ref.instanceId,
                            },
                        }),
                    }),
                }),
            }),
        }));

        await hook.unmount();
    });

    it('seeds the persisted Automation edit references so an untouched composer resubmits them', async () => {
        const sessionMention = {
            kind: 'happier.session',
            ref: 'session:sess-42',
            token: '@Nightly%20review',
            label: 'Nightly review',
        } as const;
        const hook = await renderHook(() => useNewSessionComposerDocument({
            promptStore: createNewSessionPromptStore('Continue @Nightly%20review now'),
            persistedAttachments: [],
            composerAttachmentEntriesById: {},
            initialStructuredInputReferences: [sessionMention],
            scopeKey: 'server-a/account-a',
            canSubmitRef: { current: true },
            isSubmitting: false,
        }));

        expect(hook.getCurrent().captureSubmissionSnapshot()?.references).toEqual([
            { ...sessionMention, start: 9, end: 26 },
        ]);

        await hook.unmount();
    });

    it('projects the mounted action-bar layout through the New Session Composer snapshot', async () => {
        const hook = await renderHook(() => useNewSessionComposerDocument({
            promptStore: createNewSessionPromptStore('Draft prompt'),
            persistedAttachments: [],
            composerAttachmentEntriesById: {},
            scopeKey: 'server-a/account-a',
            canSubmitRef: { current: true },
            isSubmitting: false,
        }));
        const document = hook.getCurrent() as Readonly<{
            ref: Readonly<{ kind: 'newSession'; instanceId: string }>;
            onComposerActionBarLayoutChange?: (layout: 'wrap' | 'scroll' | 'collapsed') => void;
        }>;

        expect(readComposerPresentationSnapshot(document.ref)?.layout).toBe('wrap');
        expect(document.onComposerActionBarLayoutChange).toEqual(expect.any(Function));

        document.onComposerActionBarLayoutChange?.('scroll');
        expect(readComposerPresentationSnapshot(document.ref)?.layout).toBe('scroll');

        document.onComposerActionBarLayoutChange?.('collapsed');
        expect(readComposerPresentationSnapshot(document.ref)?.layout).toBe('collapsed');

        await hook.unmount();
    });

    it('preserves a reference whose exact token remains in newer text after acceptance', async () => {
        const promptStore = createNewSessionPromptStore('Draft @issue');
        const hook = await renderHook(() => useNewSessionComposerDocument({
            promptStore,
            persistedAttachments: [issueAttachment],
            composerAttachmentEntriesById: entriesById(issueAttachmentCatalogEntry),
            scopeKey: 'server-a/account-a',
            canSubmitRef: { current: true },
            isSubmitting: false,
        }));

        const initial = hook.getCurrent().captureSubmissionSnapshot();
        expect(initial).not.toBeNull();
        await act(async () => {
            expect(applyComposerPresentationTransaction({
                ref: hook.getCurrent().ref,
                transaction: {
                    expectedRevision: initial!.revision,
                    operations: [{
                        kind: 'reference.insert',
                        reference: {
                            kind: 'partner.reference',
                            ref: 'partner:issue-42',
                            token: '@issue',
                            start: 6,
                            end: 12,
                            label: 'Issue #42',
                        },
                    }],
                },
            }).status).toBe('applied');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        const submitted = hook.getCurrent().captureSubmissionSnapshot();
        expect(submitted).not.toBeNull();
        expect(submitted?.attachments).toEqual([{ ...issueAttachment, availability: { status: 'ready' } }]);
        expect(readComposerPresentationSnapshot(hook.getCurrent().ref)).toMatchObject({
            ref: hook.getCurrent().ref,
            text: 'Draft @issue',
            references: [expect.objectContaining({ ref: 'partner:issue-42' })],
            attachments: [{ instanceId: 'issue-42', availability: { status: 'ready' } }],
        });

        await act(async () => {
            promptStore.setPrompt('Draft @issue, edited while sending');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        let didClear = false;
        await act(async () => {
            didClear = hook.getCurrent().clearAcceptedSnapshot(submitted!);
            await flushHookEffects({ cycles: 1, turns: 1 });
        });
        expect(didClear).toBe(true);
        expect(hook.getCurrent().captureSubmissionSnapshot()).toMatchObject({
            text: 'Draft @issue, edited while sending',
            references: [expect.objectContaining({ ref: 'partner:issue-42', token: '@issue' })],
            attachments: [],
        });
        expect(promptStore.getPrompt()).toBe('Draft @issue, edited while sending');

        await hook.unmount();
    });

    it('clears text-bound newer references together with unchanged accepted text', async () => {
        const promptStore = createNewSessionPromptStore('Draft @issue @new');
        const hook = await renderHook(() => useNewSessionComposerDocument({
            promptStore,
            persistedAttachments: [issueAttachment],
            composerAttachmentEntriesById: entriesById(issueAttachmentCatalogEntry),
            scopeKey: 'server-a/account-a',
            canSubmitRef: { current: true },
            isSubmitting: false,
        }));

        const initial = hook.getCurrent().captureSubmissionSnapshot();
        if (!initial) throw new Error('expected mounted New Session Composer');
        await act(async () => {
            expect(applyComposerPresentationTransaction({
                ref: hook.getCurrent().ref,
                transaction: {
                    expectedRevision: initial.revision,
                    operations: [{
                        kind: 'reference.insert',
                        reference: {
                            kind: 'partner.reference',
                            ref: 'partner:issue-42',
                            token: '@issue',
                            start: 6,
                            end: 12,
                            label: 'Issue #42',
                        },
                    }],
                },
            }).status).toBe('applied');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });
        const submitted = hook.getCurrent().captureSubmissionSnapshot();
        if (!submitted) throw new Error('expected submitted New Session Composer snapshot');
        await act(async () => {
            expect(applyComposerPresentationTransaction({
                ref: hook.getCurrent().ref,
                transaction: {
                    expectedRevision: submitted.revision,
                    operations: [{
                        kind: 'reference.insert',
                        reference: {
                            kind: 'partner.reference',
                            ref: 'partner:issue-99',
                            token: '@new',
                            start: 13,
                            end: 17,
                            label: 'Issue #99',
                        },
                    }],
                },
            }).status).toBe('applied');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(hook.getCurrent().captureSubmissionSnapshot()?.references).toEqual([
            expect.objectContaining({ ref: 'partner:issue-42' }),
            expect.objectContaining({ ref: 'partner:issue-99' }),
        ]);
        let didClear = false;
        await act(async () => {
            didClear = hook.getCurrent().clearAcceptedSnapshot(submitted);
            await flushHookEffects({ cycles: 1, turns: 1 });
        });
        expect(didClear).toBe(true);
        expect(hook.getCurrent().captureSubmissionSnapshot()).toMatchObject({
            text: '',
            references: [],
            attachments: [],
        });
        expect(hook.getCurrent().structuredInputMentions).toEqual([]);

        await hook.unmount();
    });

    it('clears unchanged text and references after acceptance while preserving an attachment field changed during send', async () => {
        const promptStore = createNewSessionPromptStore('Draft @issue');
        const hook = await renderHook(() => useNewSessionComposerDocument({
            promptStore,
            persistedAttachments: [issueAttachment, noteAttachment],
            composerAttachmentEntriesById: {
                ...entriesById(issueAttachmentCatalogEntry),
                ...entriesById(noteAttachmentCatalogEntry),
            },
            scopeKey: 'server-a/account-a',
            canSubmitRef: { current: true },
            isSubmitting: false,
        }));

        const initial = hook.getCurrent().captureSubmissionSnapshot();
        if (!initial) throw new Error('expected mounted New Session Composer');
        await act(async () => {
            expect(applyComposerPresentationTransaction({
                ref: hook.getCurrent().ref,
                transaction: {
                    expectedRevision: initial.revision,
                    operations: [{
                        kind: 'reference.insert',
                        reference: {
                            kind: 'partner.reference',
                            ref: 'partner:issue-42',
                            token: '@issue',
                            start: 6,
                            end: 12,
                            label: 'Issue #42',
                        },
                    }],
                },
            }).status).toBe('applied');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });
        const submitted = hook.getCurrent().captureSubmissionSnapshot();
        if (!submitted) throw new Error('expected submitted New Session Composer snapshot');
        await act(async () => {
            expect(applyComposerPresentationTransaction({
                ref: hook.getCurrent().ref,
                transaction: {
                    expectedRevision: submitted.revision,
                    operations: [{ kind: 'attachment.remove', instanceId: issueAttachment.instanceId }],
                },
            }).status).toBe('applied');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        let didClear = false;
        await act(async () => {
            didClear = hook.getCurrent().clearAcceptedSnapshot(submitted);
            await flushHookEffects({ cycles: 1, turns: 1 });
        });
        expect(didClear).toBe(true);
        expect(hook.getCurrent().captureSubmissionSnapshot()).toMatchObject({
            text: '',
            references: [],
            attachments: [expect.objectContaining({ instanceId: noteAttachment.instanceId })],
        });

        await hook.unmount();
    });

    it('rehydrates a persisted attachment after remount and routes direct removal through the registered document owner', async () => {
        const promptStore = createNewSessionPromptStore('');
        const hook = await renderHook(() => useNewSessionComposerDocument({
            promptStore,
            persistedAttachments: [issueAttachment],
            composerAttachmentEntriesById: entriesById(issueAttachmentCatalogEntry),
            scopeKey: 'server-a/account-a',
            canSubmitRef: { current: true },
            isSubmitting: false,
        }));

        const before = hook.getCurrent().captureSubmissionSnapshot();
        expect(before?.attachments).toHaveLength(1);
        let result: ReturnType<typeof applyComposerPresentationTransaction> | null = null;
        await act(async () => {
            result = applyComposerPresentationTransaction({
                ref: hook.getCurrent().ref,
                transaction: {
                    expectedRevision: before!.revision,
                    operations: [{ kind: 'attachment.remove', instanceId: 'issue-42' }],
                },
            });
        });
        expect(result).toMatchObject({ status: 'applied' });
        // The screen authoring owner consumes this semantic revision as its
        // persistence invalidation key; attachment edits must therefore be
        // externally visible without inventing a second draft store.
        expect(hook.getCurrent()).toMatchObject({ revision: before!.revision + 1 });
        expect(hook.getCurrent().captureSubmissionSnapshot()?.attachments).toEqual([]);

        await hook.unmount();

        const remounted = await renderHook(() => useNewSessionComposerDocument({
            promptStore: createNewSessionPromptStore(''),
            persistedAttachments: [issueAttachment],
            composerAttachmentEntriesById: entriesById(issueAttachmentCatalogEntry),
            scopeKey: 'server-a/account-a',
            canSubmitRef: { current: true },
            isSubmitting: false,
        }));
        expect(remounted.getCurrent().captureSubmissionSnapshot()?.attachments).toEqual([
            { ...issueAttachment, availability: { status: 'ready' } },
        ]);

        await remounted.unmount();
    });

    it('retires the old document identity when the account-scoped draft owner changes', async () => {
        const canSubmitRef = { current: true };
        const promptStoreA = createNewSessionPromptStore('Account A prompt');
        const promptStoreB = createNewSessionPromptStore('Account B prompt');
        const hook = await renderHook((props: Readonly<{
            promptStore: ReturnType<typeof createNewSessionPromptStore>;
            persistedAttachments: readonly ComposerAttachmentDraftV1[];
            composerAttachmentEntriesById: Readonly<Record<string, PluginUiComposerAttachmentProjection>>;
            scopeKey: string;
        }>) => useNewSessionComposerDocument({
            ...props,
            canSubmitRef,
            isSubmitting: false,
        }), {
            initialProps: {
                promptStore: promptStoreA,
                persistedAttachments: [issueAttachment],
                composerAttachmentEntriesById: entriesById(issueAttachmentCatalogEntry),
                scopeKey: 'server-a/account-a',
            },
        });

        const accountARef = hook.getCurrent().ref;
        const accountASnapshot = readComposerPresentationSnapshot(accountARef);
        expect(accountASnapshot?.attachments).toHaveLength(1);

        await hook.rerender({
            promptStore: promptStoreB,
            persistedAttachments: [noteAttachment],
            composerAttachmentEntriesById: entriesById(noteAttachmentCatalogEntry),
            scopeKey: 'server-a/account-b',
        });

        expect(hook.getCurrent().ref).not.toEqual(accountARef);
        expect(readComposerPresentationSnapshot(accountARef)).toBeNull();
        expect(applyComposerPresentationTransaction({
            ref: accountARef,
            transaction: {
                expectedRevision: accountASnapshot!.revision,
                operations: [{ kind: 'attachment.remove', instanceId: issueAttachment.instanceId }],
            },
        })).toEqual({ status: 'composerUnavailable' });
        expect(readComposerPresentationSnapshot(hook.getCurrent().ref)).toMatchObject({
            text: 'Account B prompt',
            attachments: [{ instanceId: noteAttachment.instanceId }],
        });

        await hook.unmount();
    });

    it('keeps a persisted attachment visible but non-sendable across uninstall and incompatible generation replacement, then restores it on reinstall', async () => {
        const promptStore = createNewSessionPromptStore('');
        const hook = await renderHook((props: Readonly<{
            composerAttachmentEntriesById: Readonly<Record<string, PluginUiComposerAttachmentProjection>>;
        }>) => useNewSessionComposerDocument({
            promptStore,
            persistedAttachments: [issueAttachment],
            composerAttachmentEntriesById: props.composerAttachmentEntriesById,
            scopeKey: 'server-a/account-a',
            canSubmitRef: { current: true },
            isSubmitting: false,
        }), {
            initialProps: {
                composerAttachmentEntriesById: entriesById(issueAttachmentCatalogEntry),
            },
        });

        expect(hook.getCurrent().captureSubmissionSnapshot()?.attachments).toEqual([
            { ...issueAttachment, availability: { status: 'ready' } },
        ]);

        await hook.rerender({ composerAttachmentEntriesById: {} });
        const unavailable = hook.getCurrent().captureSubmissionSnapshot();
        expect(unavailable?.attachments).toEqual([
            { ...issueAttachment, availability: { status: 'unavailable' } },
        ]);
        expect(hook.getCurrent().attachmentRowItems).toEqual([
            expect.objectContaining({
                availability: 'unavailable',
                label: issueAttachment.presentation.label,
                onRemove: expect.any(Function),
            }),
        ]);
        expect(hook.getCurrent().hasSendableAttachments).toBe(false);

        const incompatibleGeneration = {
            ...issueAttachmentCatalogEntry,
            immutableGenerationId: 'issues-generation-2',
            definition: {
                ...issueAttachmentCatalogEntry.definition,
                valueSchema: {
                    type: 'object',
                    required: ['issueRef'],
                    properties: { issueRef: { type: 'string' } },
                    additionalProperties: false,
                },
            },
        } satisfies PluginProjectedComposerAttachmentEntryV1;
        await hook.rerender({ composerAttachmentEntriesById: entriesById(incompatibleGeneration) });
        expect(hook.getCurrent().captureSubmissionSnapshot()?.attachments).toEqual([
            { ...issueAttachment, availability: { status: 'invalid' } },
        ]);

        const reinstalled = {
            ...issueAttachmentCatalogEntry,
            immutableGenerationId: 'issues-generation-3',
        } satisfies PluginProjectedComposerAttachmentEntryV1;
        await hook.rerender({ composerAttachmentEntriesById: entriesById(reinstalled) });
        expect(hook.getCurrent().captureSubmissionSnapshot()?.attachments).toEqual([
            { ...issueAttachment, availability: { status: 'ready' } },
        ]);
        expect(hook.getCurrent().attachments).toEqual([issueAttachment]);

        await hook.unmount();
    });

    it('projects decorations and edit locks through the mounted new-session input, then retires the replaced scope', async () => {
        const canSubmitRef = { current: true };
        const hook = await renderHook((props: Readonly<{
            scopeKey: string;
        }>) => useNewSessionComposerDocument({
            // These are ordinary projection inputs: their identities may change
            // while this exact Composer ref remains mounted. Effect projection
            // must not retire the mounted target just because it rerendered.
            promptStore: createNewSessionPromptStore('Draft prompt'),
            persistedAttachments: [],
            composerAttachmentEntriesById: {},
            scopeKey: props.scopeKey,
            canSubmitRef,
            isSubmitting: false,
        }), {
            initialProps: { scopeKey: 'server-a/account-a' },
        });
        const initial = hook.getCurrent() as unknown as Readonly<{
            ref: Readonly<{ kind: 'newSession'; instanceId: string }>;
            composerDecorations: ReadonlyArray<Readonly<{
                key: string;
                decorations: Readonly<{ revision: number }>;
            }>>;
            composerInputLock: Readonly<{
                mode: 'submit' | 'editAndSubmit';
                reasons: readonly string[];
            }> | null;
        }>;
        const snapshot = readComposerPresentationSnapshot(initial.ref);
        expect(snapshot).not.toBeNull();
        if (!snapshot) throw new Error('expected mounted new-session composer target');

        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
        });
        const request = (method: 'setComposerDecorations' | 'acquireComposerInputLock' | 'disposeHostResource', payload: unknown) => ({
            version: 1,
            requestId: `request:${method}`,
            surface: {
                pluginId: 'acme.fixture',
                contributionId: 'composer-tools',
                surfaceId: 'composer-tools:mounted',
                placement: 'composerSurface',
                platform: 'web',
                channel: 'internal',
                resourceScope: [],
                diagnostics: [],
            },
            method,
            payload,
        }) as never;

        await act(async () => {
            expect(handlers.setComposerDecorations!(request('setComposerDecorations', {
                ref: initial.ref,
                key: 'analysis',
                decorations: {
                    revision: snapshot.revision,
                    ranges: [{ range: { start: 0, end: 5 }, treatment: 'highlight' }],
                },
            }))).toEqual({ status: 'set' });
        });
        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(hook.getCurrent().composerDecorations).toEqual([
            expect.objectContaining({
                key: 'analysis',
                decorations: expect.objectContaining({ revision: snapshot.revision }),
            }),
        ]);

        await act(async () => {
            expect(handlers.acquireComposerInputLock!(request('acquireComposerInputLock', {
                subscriptionId: 'lock-1',
                ref: initial.ref,
                request: { reason: 'Review required', mode: 'editAndSubmit' },
            }))).toBeNull();
        });
        expect(hook.getCurrent().composerInputLock).toEqual({
            mode: 'editAndSubmit',
            reasons: ['Review required'],
        });
        expect(readComposerPresentationSnapshot(initial.ref)?.state).toMatchObject({
            editable: false,
            submittable: false,
            inputLock: { mode: 'editAndSubmit', reasons: ['Review required'] },
        });

        await act(async () => {
            expect(handlers.disposeHostResource!(request('disposeHostResource', {
                subscriptionId: 'lock-1',
            }))).toBeNull();
        });
        expect(hook.getCurrent().composerInputLock).toBeNull();
        expect(readComposerPresentationSnapshot(initial.ref)?.state).toMatchObject({
            editable: true,
            submittable: true,
        });
        expect(readComposerPresentationSnapshot(initial.ref)?.state).not.toHaveProperty('inputLock');

        await act(async () => {
            expect(handlers.acquireComposerInputLock!(request('acquireComposerInputLock', {
                subscriptionId: 'replacement-lock',
                ref: initial.ref,
                request: { reason: 'Switching account', mode: 'editAndSubmit' },
            }))).toBeNull();
        });
        expect(hook.getCurrent().composerInputLock).toEqual({
            mode: 'editAndSubmit',
            reasons: ['Switching account'],
        });

        await hook.rerender({ scopeKey: 'server-a/account-b' });
        expect(hook.getCurrent().composerDecorations).toEqual([]);
        expect(hook.getCurrent().composerInputLock).toBeNull();
        expect(readComposerPresentationSnapshot(hook.getCurrent().ref)?.state).not.toHaveProperty('inputLock');
        expect(handlers.setComposerDecorations!(request('setComposerDecorations', {
            ref: initial.ref,
            key: 'late-analysis',
            decorations: {
                revision: snapshot.revision,
                ranges: [{ range: { start: 0, end: 5 }, treatment: 'warning' }],
            },
        }))).toEqual({ status: 'unavailable', reason: 'scopeClosed' });

        await act(async () => {
            expect(handlers.disposeHostResource!(request('disposeHostResource', {
                subscriptionId: 'replacement-lock',
            }))).toBeNull();
        });

        await act(async () => {
            handlers.dispose();
        });
        await hook.unmount();
    });

    it('keeps decoration requests current after StrictMode replay and rejects them after unmount', async () => {
        const canSubmitRef = { current: true };
        const documentHolder: { current: Readonly<{
            ref: Readonly<{ kind: 'newSession'; instanceId: string }>;
        }> | null } = { current: null };

        function StrictModeHarness() {
            const current = useNewSessionComposerDocument({
                promptStore: createNewSessionPromptStore('Draft prompt'),
                persistedAttachments: [],
                composerAttachmentEntriesById: {},
                scopeKey: 'server-a/account-a',
                canSubmitRef,
                isSubmitting: false,
            });
            documentHolder.current = {
                ref: current.ref,
            };
            return null;
        }

        const treeHolder: { current: renderer.ReactTestRenderer | null } = { current: null };
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
        });
        const request = (method: 'setComposerDecorations', payload: unknown) => ({
            version: 1,
            requestId: `request:${method}`,
            surface: {
                pluginId: 'acme.fixture',
                contributionId: 'composer-tools',
                surfaceId: 'composer-tools:mounted',
                placement: 'composerSurface',
                platform: 'web',
                channel: 'internal',
                resourceScope: [],
                diagnostics: [],
            },
            method,
            payload,
        }) as never;

        try {
            await act(async () => {
                treeHolder.current = renderer.create(
                    <React.StrictMode>
                        <StrictModeHarness />
                    </React.StrictMode>,
                    { unstable_strictMode: true } as unknown as renderer.TestRendererOptions,
                );
            });
            await flushHookEffects({ cycles: 1, turns: 1 });

            const mountedDocument = documentHolder.current;
            if (!mountedDocument) throw new Error('expected mounted new-session composer document');
            await act(async () => {
                expect(handlers.setComposerDecorations!(request('setComposerDecorations', {
                    ref: mountedDocument.ref,
                    key: 'strict-mode-analysis',
                    decorations: {
                        revision: 0,
                        ranges: [{ range: { start: 0, end: 5 }, treatment: 'highlight' }],
                    },
                }))).toEqual({ status: 'set' });
            });
            const mountedRef = mountedDocument.ref;
            const mountedTree = treeHolder.current;
            if (!mountedTree) throw new Error('expected StrictMode composer tree');
            await act(async () => {
                mountedTree.unmount();
            });
            treeHolder.current = null;
            expect(handlers.setComposerDecorations!(request('setComposerDecorations', {
                ref: mountedRef,
                key: 'post-unmount-analysis',
                decorations: {
                    revision: 0,
                    ranges: [{ range: { start: 0, end: 5 }, treatment: 'warning' }],
                },
            }))).toEqual({ status: 'unavailable', reason: 'scopeClosed' });
        } finally {
            handlers.dispose();
            const mountedTree = treeHolder.current;
            if (mountedTree) {
                await act(async () => {
                    mountedTree.unmount();
                });
            }
        }
    });

    it('binds focus and active resolution to the mounted new-session input, then closes the replaced scope', async () => {
        const canSubmitRef = { current: true };
        const hook = await renderHook((props: Readonly<{
            scopeKey: string;
        }>) => useNewSessionComposerDocument({
            promptStore: createNewSessionPromptStore('Draft prompt'),
            persistedAttachments: [],
            composerAttachmentEntriesById: {},
            scopeKey: props.scopeKey,
            canSubmitRef,
            isSubmitting: false,
        }), {
            initialProps: { scopeKey: 'server-a/account-a' },
        });
        const initial = hook.getCurrent() as unknown as Readonly<{
            ref: Readonly<{ kind: 'newSession'; instanceId: string }>;
            onComposerFocusChange: (focused: boolean) => void;
            onComposerFocusRequestChange: (request: (() => void) | null) => void;
        }>;
        const focus = vi.fn();

        expect(initial.onComposerFocusChange).toEqual(expect.any(Function));
        expect(initial.onComposerFocusRequestChange).toEqual(expect.any(Function));
        await act(async () => {
            initial.onComposerFocusRequestChange(focus);
            initial.onComposerFocusChange(true);
        });

        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
        });
        const request = (method: 'activeComposer' | 'focusComposer', payload?: unknown) => ({
            version: 1,
            requestId: `request:${method}`,
            surface: {
                pluginId: 'acme.fixture',
                contributionId: 'composer-tools',
                surfaceId: 'composer-tools:mounted',
                placement: 'composerSurface',
                platform: 'web',
                channel: 'internal',
                resourceScope: [],
                diagnostics: [],
            },
            method,
            ...(payload === undefined ? {} : { payload }),
        }) as never;

        expect(handlers.activeComposer!(request('activeComposer'))).toEqual(initial.ref);
        expect(handlers.focusComposer!(request('focusComposer', { ref: initial.ref })))
            .toEqual({ status: 'focused' });
        expect(focus).toHaveBeenCalledTimes(1);

        await hook.rerender({ scopeKey: 'server-a/account-b' });
        expect(handlers.focusComposer!(request('focusComposer', { ref: initial.ref })))
            .toEqual({ status: 'unavailable', reason: 'scopeClosed' });

        handlers.dispose();
        await hook.unmount();
    });
});
