import {
    type ComposerAttachmentViewV1,
    type ComposerRefV1,
    type ComposerSnapshotV1,
    type SessionExecutionTargetV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { getComposerMediaContentAvailability } from '@/sync/domains/transfers/runtime/transferRuntime';

const getComposerMediaContentAvailabilitySpy = vi.hoisted(() => (
    vi.fn<typeof getComposerMediaContentAvailability>()
));

vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    getComposerMediaContentAvailability: getComposerMediaContentAvailabilitySpy,
}));

import {
    captureComposerSubmissionSnapshot,
    readComposerSubmissionFieldCurrentness,
    type ComposerSubmissionRoute,
    type ComposerSubmissionSnapshot,
    submitComposerSnapshot,
} from './composerSubmissionCoordinator';

type ComposerMentionRef = ComposerSnapshotV1['references'][number];

const issueReference = {
    kind: 'acme.issue',
    ref: 'issue:42',
    token: '@issue-42',
    start: 0,
    end: 9,
    label: 'Issue #42',
} satisfies ComposerMentionRef;

const issueAttachment = {
    v: 1,
    instanceId: 'issue-42',
    attachment: { pluginId: 'acme.issues', localId: 'issue' },
    key: '42',
    value: { issueId: 42 },
    presentation: { label: 'Issue #42', typeLabel: 'Issue' },
    availability: { status: 'ready' },
} satisfies ComposerAttachmentViewV1;

const triageEntryAttachment = {
    v: 1,
    instanceId: 'triage-entry-42',
    attachment: { pluginId: 'happier.triage', localId: 'entry' },
    key: 'triage-entry-key-42',
    value: {
        v: 1,
        entryRef: {
            source: { pluginId: 'happier.scm.github', localId: 'triage-source' },
            kindId: 'pull-request',
            collisionScope: 'github:repository-7',
            entryId: '42',
        },
        sourceInstance: {
            source: { pluginId: 'happier.scm.github', localId: 'triage-source' },
            sourceInstanceId: 'github-account-1',
        },
    },
    presentation: { label: 'PR #42', typeLabel: 'PRs & Issues' },
    availability: { status: 'ready' },
} satisfies ComposerAttachmentViewV1;

const composerMediaExecutionTarget = { serverId: 'server-1', machineId: 'machine-1' } as const;

const stagedMediaAttachment = {
    ...issueAttachment,
    content: {
        kind: 'stagedMedia' as const,
        handle: {
            v: 1 as const,
            id: 'stage-42',
            executionTarget: composerMediaExecutionTarget,
            owner: { pluginId: 'acme.issues', localId: 'issue' },
            mediaKind: 'image' as const,
            mimeType: 'image/png' as const,
            name: 'issue-42.png',
            sizeBytes: 12,
            sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
    },
} satisfies ComposerAttachmentViewV1;

function createSnapshot(input: Readonly<{
    ref?: ComposerRefV1;
    text?: string;
    references?: readonly ComposerMentionRef[];
    attachments?: readonly ComposerAttachmentViewV1[];
}> = {}): ComposerSnapshotV1 {
    return {
        revision: 7,
        ref: input.ref ?? { kind: 'session', sessionId: 'session-1' },
        text: input.text ?? '@issue-42',
        references: [...(input.references ?? [issueReference])],
        attachments: [...(input.attachments ?? [issueAttachment])],
        layout: 'wrap',
        capabilities: {
            text: true,
            references: true,
            attachments: true,
            submit: true,
        },
        state: {
            focused: true,
            editable: true,
            submittable: true,
            submitting: false,
            running: false,
        },
    };
}

describe('composerSubmissionCoordinator', () => {
    afterEach(() => {
        getComposerMediaContentAvailabilitySpy.mockReset();
    });

    it('captures a detached exact semantic snapshot before delegated admission', () => {
        const source = createSnapshot({ attachments: [structuredClone(issueAttachment)] });
        const captured = captureComposerSubmissionSnapshot(source);
        if (!captured) throw new Error('expected captured Composer snapshot');

        expect(captured).toMatchObject({
            ref: { kind: 'session', sessionId: 'session-1' },
            revision: 7,
            text: '@issue-42',
            references: [issueReference],
            attachments: [issueAttachment],
        });

        expect(captured.references).not.toBe(source.references);
        expect(captured.attachments).not.toBe(source.attachments);
        expect(captured.attachments[0]).not.toBe(source.attachments[0]);
        expect(captured.attachments[0]?.value).not.toBe(source.attachments[0]?.value);

        expect(captured).toMatchObject({
            text: '@issue-42',
            references: [issueReference],
            attachments: [issueAttachment],
        });
    });

    it('tracks text, references, and attachments independently for every live composer document owner', () => {
        const refs: readonly ComposerRefV1[] = [
            { kind: 'session', sessionId: 'session-1' },
            { kind: 'newSession', instanceId: 'new-session-composer-1' },
            { kind: 'participantMessage', sessionId: 'session-1', instanceId: 'participant-composer-1' },
        ];

        for (const ref of refs) {
            const accepted = captureComposerSubmissionSnapshot(createSnapshot({ ref }));
            if (!accepted) throw new Error('expected accepted Composer snapshot');

            expect(readComposerSubmissionFieldCurrentness(createSnapshot({
                ref,
                text: 'newer text',
                references: accepted.references,
                attachments: accepted.attachments,
            }), accepted)).toMatchObject({ text: false, references: true, attachments: true });
            expect(readComposerSubmissionFieldCurrentness(createSnapshot({
                ref,
                text: `prefixed ${accepted.text}`,
                references: accepted.references.map((reference) => ({
                    ...reference,
                    start: reference.start + 9,
                    end: reference.end + 9,
                })),
                attachments: accepted.attachments,
            }), accepted)).toMatchObject({ text: false, references: true, attachments: true });
            expect(readComposerSubmissionFieldCurrentness(createSnapshot({
                ref,
                text: accepted.text,
                references: [{
                    ...issueReference,
                    ref: 'issue:99',
                    token: '@issue-99',
                    end: 9,
                    label: 'Issue #99',
                }],
                attachments: accepted.attachments,
            }), accepted)).toMatchObject({ text: true, references: false, attachments: true });
            expect(readComposerSubmissionFieldCurrentness(createSnapshot({
                ref,
                text: accepted.text,
                references: accepted.references,
                attachments: [{
                    ...issueAttachment,
                    value: { issueId: 99 },
                    presentation: { label: 'Issue #99', typeLabel: 'Issue' },
                }],
            }), accepted)).toMatchObject({ text: true, references: true, attachments: false });
        }
    });

    // Composer strict-JSON fields have one equality owner. A valid public
    // attachment update may supply an equivalent value whose object keys arrive
    // in another order, and the durable draft repository already treats that as
    // unchanged; submission currentness must not disagree with it.
    it('decides attachment currentness by strict-JSON value, not by serialization order', () => {
        // Built literally rather than through `captureComposerSubmissionSnapshot`
        // so this case measures only the equality rule.
        const acceptedWith = (
            attachments: readonly ComposerAttachmentViewV1[],
        ): ComposerSubmissionSnapshot => structuredClone({
            ref: { kind: 'session', sessionId: 'session-1' } as ComposerRefV1,
            revision: 7,
            text: '@issue-42',
            references: [issueReference],
            attachments: [...attachments],
        });

        const accepted = acceptedWith([{ ...issueAttachment, value: { a: 1, b: 2 } }]);
        expect(readComposerSubmissionFieldCurrentness(createSnapshot({
            attachments: [{ ...issueAttachment, value: { b: 2, a: 1 } }],
        }), accepted)).toMatchObject({ attachments: true });

        // Positive twin: a real nested value change is still not current.
        expect(readComposerSubmissionFieldCurrentness(createSnapshot({
            attachments: [{ ...issueAttachment, value: { a: 1, b: 3 } }],
        }), accepted)).toMatchObject({ attachments: false });

        // Positive twin: the optional fields a projected attachment view can
        // carry — staged media content included — stay current against an exact
        // detached clone of the same value.
        expect(readComposerSubmissionFieldCurrentness(createSnapshot({
            attachments: [stagedMediaAttachment],
        }), acceptedWith([stagedMediaAttachment]))).toMatchObject({ attachments: true });
    });

    it('clears changed references together with unchanged accepted text', () => {
        const accepted = captureComposerSubmissionSnapshot(createSnapshot());
        if (!accepted) throw new Error('expected accepted Composer snapshot');
        const current = createSnapshot({
            text: accepted.text,
            references: [{
                ...issueReference,
                ref: 'issue:99',
                label: 'Issue #99',
            }],
            attachments: accepted.attachments,
        });

        expect(readComposerSubmissionFieldCurrentness(current, accepted)).toMatchObject({
            text: true,
            references: false,
            attachments: true,
            reconciledText: '',
            reconciledReferences: [],
        });
    });

    it('keeps current reference metadata only when the resulting text retains its exact token', () => {
        const accepted = captureComposerSubmissionSnapshot(createSnapshot());
        if (!accepted) throw new Error('expected accepted Composer snapshot');
        const currentReference = {
            ...issueReference,
            start: 8,
            end: 17,
            composerReference: { pluginId: 'acme.issues', localId: 'current-issue' },
        } satisfies ComposerMentionRef;
        const current = createSnapshot({
            text: 'Updated @issue-42 prompt',
            references: [currentReference],
            attachments: accepted.attachments,
        });

        expect(readComposerSubmissionFieldCurrentness(current, accepted)).toMatchObject({
            text: false,
            references: true,
            attachments: true,
            reconciledText: 'Updated @issue-42 prompt',
            reconciledReferences: [currentReference],
        });
    });

    it('submits a valid textless attachment snapshot and only asks its document owner to exact-clear after acceptance', async () => {
        const admit = vi.fn(async (_snapshot: ComposerSubmissionSnapshot) => ({ status: 'accepted' as const }));
        const clearAcceptedSnapshot = vi.fn(() => false);
        const snapshot = createSnapshot({ text: '', references: [], attachments: [issueAttachment] });

        const result = await submitComposerSnapshot({
            snapshot,
            route: { kind: 'session', ref: { kind: 'session', sessionId: 'session-1' }, admit },
            clearAcceptedSnapshot,
        });

        expect(admit.mock.calls[0]?.[0]).toMatchObject({
            text: '',
            references: [],
            attachments: [issueAttachment],
        });
        expect(clearAcceptedSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            revision: 7,
            attachments: [issueAttachment],
        }));
        expect(result).toMatchObject({ status: 'accepted', cleared: false });
    });

    it('takes Triage entry context only from the exact current composer snapshot across selection and scope changes', async () => {
        const admit = vi.fn(async () => ({ status: 'accepted' as const }));
        const clearAcceptedSnapshot = vi.fn(() => true);

        // Deselecting an entry while retaining prose sends the prose without a
        // remembered attachment. The canonical snapshot is the only binding.
        await expect(submitComposerSnapshot({
            snapshot: createSnapshot({ text: 'Continue without the PR', references: [], attachments: [] }),
            route: { kind: 'session', ref: { kind: 'session', sessionId: 'session-1' }, admit },
            clearAcceptedSnapshot,
        })).resolves.toMatchObject({ status: 'accepted' });
        expect(admit).toHaveBeenLastCalledWith(expect.objectContaining({ attachments: [] }), expect.anything());

        // Replacing the selected entry before submission sends only the newer
        // canonical value, never the entry captured by an earlier render.
        const changedEntry = {
            ...triageEntryAttachment,
            instanceId: 'triage-entry-43',
            key: 'triage-entry-key-43',
            value: {
                ...triageEntryAttachment.value,
                entryRef: { ...triageEntryAttachment.value.entryRef, entryId: '43' },
            },
            presentation: { ...triageEntryAttachment.presentation, label: 'PR #43' },
        } satisfies ComposerAttachmentViewV1;
        await expect(submitComposerSnapshot({
            snapshot: createSnapshot({ text: '', references: [], attachments: [changedEntry] }),
            route: { kind: 'session', ref: { kind: 'session', sessionId: 'session-1' }, admit },
            clearAcceptedSnapshot,
        })).resolves.toMatchObject({ status: 'accepted' });
        expect(admit).toHaveBeenLastCalledWith(expect.objectContaining({ attachments: [changedEntry] }), expect.anything());

        // Clearing the composer leaves no input to admit, and switching to a
        // different Session cannot submit the previous Session's attachment.
        await expect(submitComposerSnapshot({
            snapshot: createSnapshot({ text: '', references: [], attachments: [] }),
            route: { kind: 'session', ref: { kind: 'session', sessionId: 'session-1' }, admit },
            clearAcceptedSnapshot,
        })).resolves.toMatchObject({ status: 'notSendable' });
        await expect(submitComposerSnapshot({
            snapshot: createSnapshot({ text: '', references: [], attachments: [triageEntryAttachment] }),
            route: { kind: 'session', ref: { kind: 'session', sessionId: 'session-2' }, admit },
            clearAcceptedSnapshot,
        })).resolves.toMatchObject({ status: 'blocked', reason: 'scopeMismatch' });

        expect(admit).toHaveBeenCalledTimes(2);
    });

    it('fails closed before every Message-carrying admission when an older daemon does not negotiate staged media', async () => {
        getComposerMediaContentAvailabilitySpy.mockResolvedValue({ available: false });

        const scopes = [
            {
                name: 'session',
                snapshot: createSnapshot({ attachments: [stagedMediaAttachment] }),
                route: {
                    kind: 'session' as const,
                    ref: { kind: 'session' as const, sessionId: 'session-1' },
                },
            },
            {
                name: 'new session',
                snapshot: createSnapshot({
                    ref: { kind: 'newSession', instanceId: 'new-session-composer-1' },
                    attachments: [stagedMediaAttachment],
                }),
                route: {
                    kind: 'newSession' as const,
                    ref: { kind: 'newSession' as const, instanceId: 'new-session-composer-1' },
                },
            },
            {
                name: 'participant',
                snapshot: createSnapshot({
                    ref: { kind: 'participantMessage', sessionId: 'session-1', instanceId: 'participant-composer-1' },
                    attachments: [stagedMediaAttachment],
                }),
                route: {
                    kind: 'participantMessage' as const,
                    ref: { kind: 'participantMessage' as const, sessionId: 'session-1', instanceId: 'participant-composer-1' },
                },
            },
            {
                name: 'pending',
                snapshot: createSnapshot({
                    ref: { kind: 'pendingMessage', sessionId: 'session-1', localId: 'pending-1' },
                    attachments: [stagedMediaAttachment],
                }),
                route: {
                    kind: 'pendingMessage' as const,
                    ref: { kind: 'pendingMessage' as const, sessionId: 'session-1', localId: 'pending-1' },
                },
            },
        ] satisfies ReadonlyArray<Readonly<{
            name: string;
            snapshot: ComposerSnapshotV1;
            route: Omit<ComposerSubmissionRoute, 'admit'>;
        }>>;

        for (const scope of scopes) {
            const admit = vi.fn(async () => ({ status: 'accepted' as const }));
            const clearAcceptedSnapshot = vi.fn(() => true);

            const result = await submitComposerSnapshot({
                snapshot: scope.snapshot,
                route: {
                    ...scope.route,
                    readCurrentExecutionTarget: () => composerMediaExecutionTarget,
                    admit,
                } as ComposerSubmissionRoute,
                clearAcceptedSnapshot,
            });

            expect(result, scope.name).toMatchObject({ status: 'blocked', reason: 'mediaContentUnavailable' });
            expect(admit, scope.name).not.toHaveBeenCalled();
            expect(clearAcceptedSnapshot, scope.name).not.toHaveBeenCalled();
        }

        expect(getComposerMediaContentAvailabilitySpy).toHaveBeenCalledTimes(4);
        expect(getComposerMediaContentAvailabilitySpy).toHaveBeenNthCalledWith(1, {
            executionTarget: composerMediaExecutionTarget,
        });
    });

    it('admits staged media through the exact current target when its daemon advertises the operation', async () => {
        getComposerMediaContentAvailabilitySpy.mockResolvedValueOnce({
            available: true,
            capability: 'composer.mediaContent.v1',
        });
        const admit = vi.fn(async () => ({ status: 'accepted' as const }));
        const clearAcceptedSnapshot = vi.fn(() => true);

        const result = await submitComposerSnapshot({
            snapshot: createSnapshot({
                text: 'Send this staged image',
                attachments: [stagedMediaAttachment],
            }),
            route: {
                kind: 'session',
                ref: { kind: 'session', sessionId: 'session-1' },
                readCurrentExecutionTarget: () => composerMediaExecutionTarget,
                admit,
            },
            clearAcceptedSnapshot,
        });

        expect(getComposerMediaContentAvailabilitySpy).toHaveBeenCalledWith({
            executionTarget: composerMediaExecutionTarget,
        });
        expect(admit).toHaveBeenCalledTimes(1);
        expect(clearAcceptedSnapshot).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ status: 'accepted', cleared: true });
    });

    it('blocks a staged handle when the current target changed after it was picked', async () => {
        const admit = vi.fn(async () => ({ status: 'accepted' as const }));
        const clearAcceptedSnapshot = vi.fn(() => true);

        const result = await submitComposerSnapshot({
            snapshot: createSnapshot({ attachments: [stagedMediaAttachment] }),
            route: {
                kind: 'session',
                ref: { kind: 'session', sessionId: 'session-1' },
                readCurrentExecutionTarget: () => ({ serverId: 'server-2', machineId: 'machine-2' }),
                admit,
            },
            clearAcceptedSnapshot,
        });

        expect(result).toMatchObject({ status: 'blocked', reason: 'mediaContentUnavailable' });
        expect(getComposerMediaContentAvailabilitySpy).not.toHaveBeenCalled();
        expect(admit).not.toHaveBeenCalled();
        expect(clearAcceptedSnapshot).not.toHaveBeenCalled();
    });

    it('fails closed when the route can no longer provide a valid current staged-media target', async () => {
        const admit = vi.fn(async () => ({ status: 'accepted' as const }));
        const clearAcceptedSnapshot = vi.fn(() => true);

        const result = await submitComposerSnapshot({
            snapshot: createSnapshot({ attachments: [stagedMediaAttachment] }),
            route: {
                kind: 'session',
                ref: { kind: 'session', sessionId: 'session-1' },
                readCurrentExecutionTarget: () => ({ serverId: 'server-1' }),
                admit,
            },
            clearAcceptedSnapshot,
        });

        expect(result).toMatchObject({ status: 'blocked', reason: 'mediaContentUnavailable' });
        expect(getComposerMediaContentAvailabilitySpy).not.toHaveBeenCalled();
        expect(admit).not.toHaveBeenCalled();
        expect(clearAcceptedSnapshot).not.toHaveBeenCalled();
    });

    it('retains a staged draft if its exact target changes while the one capability probe is pending', async () => {
        const deferredAvailability: {
            resolve: ((value: Awaited<ReturnType<typeof getComposerMediaContentAvailability>>) => void) | null;
        } = { resolve: null };
        getComposerMediaContentAvailabilitySpy.mockImplementationOnce(() => new Promise<
            Awaited<ReturnType<typeof getComposerMediaContentAvailability>>
        >((resolve) => {
            deferredAvailability.resolve = resolve;
        }));
        const admit = vi.fn(async () => ({ status: 'accepted' as const }));
        const clearAcceptedSnapshot = vi.fn(() => true);
        let currentExecutionTarget: SessionExecutionTargetV1 = { ...composerMediaExecutionTarget };

        const resultPromise = submitComposerSnapshot({
            snapshot: createSnapshot({ attachments: [stagedMediaAttachment] }),
            route: {
                kind: 'session',
                ref: { kind: 'session', sessionId: 'session-1' },
                readCurrentExecutionTarget: () => currentExecutionTarget,
                admit,
            },
            clearAcceptedSnapshot,
        });

        expect(getComposerMediaContentAvailabilitySpy).toHaveBeenCalledWith({
            executionTarget: composerMediaExecutionTarget,
        });
        currentExecutionTarget = { serverId: 'server-2', machineId: 'machine-2' };
        const resolve = deferredAvailability.resolve;
        if (!resolve) throw new Error('expected staged-media capability probe');
        resolve({ available: true, capability: 'composer.mediaContent.v1' });

        await expect(resultPromise).resolves.toMatchObject({ status: 'blocked', reason: 'mediaContentUnavailable' });
        expect(getComposerMediaContentAvailabilitySpy).toHaveBeenCalledTimes(1);
        expect(admit).not.toHaveBeenCalled();
        expect(clearAcceptedSnapshot).not.toHaveBeenCalled();
    });

    it('retains the exact draft when canonical admission rejects it', async () => {
        const admit = vi.fn(async () => ({ status: 'rejected' as const }));
        const clearAcceptedSnapshot = vi.fn(() => true);

        const result = await submitComposerSnapshot({
            snapshot: createSnapshot(),
            route: { kind: 'session', ref: { kind: 'session', sessionId: 'session-1' }, admit },
            clearAcceptedSnapshot,
        });

        expect(result).toMatchObject({ status: 'rejected' });
        expect(clearAcceptedSnapshot).not.toHaveBeenCalled();
    });

    it('never clears when canonical admission throws', async () => {
        const admit = vi.fn(async () => {
            throw new Error('Target daemon is unavailable');
        });
        const clearAcceptedSnapshot = vi.fn(() => true);

        await expect(submitComposerSnapshot({
            snapshot: createSnapshot(),
            route: { kind: 'session', ref: { kind: 'session', sessionId: 'session-1' }, admit },
            clearAcceptedSnapshot,
        })).rejects.toThrow('Target daemon is unavailable');

        expect(clearAcceptedSnapshot).not.toHaveBeenCalled();
    });

    it('rejects a mismatched document route before that route can admit or clear a draft', async () => {
        const admit = vi.fn(async () => ({ status: 'accepted' as const }));
        const clearAcceptedSnapshot = vi.fn(() => true);

        const result = await submitComposerSnapshot({
            snapshot: createSnapshot(),
            route: { kind: 'newSession', ref: { kind: 'newSession', instanceId: 'new-session-composer-1' }, admit },
            clearAcceptedSnapshot,
        });

        expect(result).toMatchObject({ status: 'blocked', reason: 'scopeMismatch' });
        expect(admit).not.toHaveBeenCalled();
        expect(clearAcceptedSnapshot).not.toHaveBeenCalled();
    });

    it('rejects a same-kind route that belongs to another exact composer owner', async () => {
        const admit = vi.fn(async () => ({ status: 'accepted' as const }));
        const clearAcceptedSnapshot = vi.fn(() => true);
        const route = {
            kind: 'session',
            ref: { kind: 'session', sessionId: 'session-2' },
            admit,
        } as unknown as ComposerSubmissionRoute;

        const result = await submitComposerSnapshot({
            snapshot: createSnapshot(),
            route,
            clearAcceptedSnapshot,
        });

        expect(result).toMatchObject({ status: 'blocked', reason: 'scopeMismatch' });
        expect(admit).not.toHaveBeenCalled();
        expect(clearAcceptedSnapshot).not.toHaveBeenCalled();
    });

    it('does not let a pending-message route reuse another pending local id', async () => {
        const admit = vi.fn(async () => ({ status: 'accepted' as const }));
        const clearAcceptedSnapshot = vi.fn(() => true);
        const snapshot = createSnapshot({
            ref: { kind: 'pendingMessage', sessionId: 'session-1', localId: 'pending-1' },
        });

        const result = await submitComposerSnapshot({
            snapshot,
            route: {
                kind: 'pendingMessage',
                ref: { kind: 'pendingMessage', sessionId: 'session-1', localId: 'pending-2' },
                admit,
            },
            clearAcceptedSnapshot,
        });

        expect(result).toMatchObject({ status: 'blocked', reason: 'scopeMismatch' });
        expect(admit).not.toHaveBeenCalled();
        expect(clearAcceptedSnapshot).not.toHaveBeenCalled();
    });

    it('does not delegate or clear a references-only draft', async () => {
        const admit = vi.fn(async () => ({ status: 'accepted' as const }));
        const clearAcceptedSnapshot = vi.fn(() => true);

        const result = await submitComposerSnapshot({
            snapshot: createSnapshot({ text: '', references: [issueReference], attachments: [] }),
            route: { kind: 'session', ref: { kind: 'session', sessionId: 'session-1' }, admit },
            clearAcceptedSnapshot,
        });

        expect(result).toMatchObject({ status: 'notSendable' });
        expect(admit).not.toHaveBeenCalled();
        expect(clearAcceptedSnapshot).not.toHaveBeenCalled();
    });

    it('honors canonical document currentness when exact-snapshot clearing is rejected', async () => {
        let settleAdmission: ((outcome: { status: 'accepted' }) => void) | null = null;
        const admit = vi.fn(() => new Promise<{ status: 'accepted' }>((resolve) => {
            settleAdmission = resolve;
        }));
        const clearAcceptedSnapshot = vi.fn((snapshot) => {
            expect(snapshot).toMatchObject({
                text: '@issue-42',
                attachments: [issueAttachment],
            });
            return false;
        });
        const source = createSnapshot({ attachments: [structuredClone(issueAttachment)] });

        const resultPromise = submitComposerSnapshot({
            snapshot: source,
            route: { kind: 'session', ref: { kind: 'session', sessionId: 'session-1' }, admit },
            clearAcceptedSnapshot,
        });

        expect(admit).toHaveBeenCalledTimes(1);
        const settle = settleAdmission as ((outcome: { status: 'accepted' }) => void) | null;
        if (!settle) throw new Error('Admission delegate did not begin');
        settle({ status: 'accepted' });

        await expect(resultPromise).resolves.toMatchObject({ status: 'accepted', cleared: false });
        expect(clearAcceptedSnapshot).toHaveBeenCalledTimes(1);
    });

    it('lets canonical admission signal its durable handoff so the exact clear happens before later completion', async () => {
        const clearAcceptedSnapshot = vi.fn(() => true);
        let didClear = false;
        const admit = vi.fn(async (_snapshot, handoff) => {
            expect(didClear).toBe(false);
            expect(handoff.accept()).toBe(true);
            expect(handoff.accept()).toBe(true);
            didClear = true;
            expect(didClear).toBe(true);
            return { status: 'accepted' as const };
        });

        const result = await submitComposerSnapshot({
            snapshot: createSnapshot(),
            route: { kind: 'session', ref: { kind: 'session', sessionId: 'session-1' }, admit },
            clearAcceptedSnapshot,
        });

        expect(clearAcceptedSnapshot).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ status: 'accepted', cleared: true });
    });

    it('routes new-session submission through its creation-and-admission owner without inventing a UI preparation path', async () => {
        const admit = vi.fn(async (_snapshot: ComposerSubmissionSnapshot) => ({ status: 'accepted' as const }));
        const clearAcceptedSnapshot = vi.fn(() => true);
        const snapshot = createSnapshot({
            ref: { kind: 'newSession', instanceId: 'new-session-composer-1' },
            text: 'Create the session with this issue',
        });

        const result = await submitComposerSnapshot({
            snapshot,
            route: { kind: 'newSession', ref: { kind: 'newSession', instanceId: 'new-session-composer-1' }, admit },
            clearAcceptedSnapshot,
        });

        expect(admit.mock.calls[0]?.[0]).toMatchObject({
            ref: { kind: 'newSession', instanceId: 'new-session-composer-1' },
        });
        expect(result).toMatchObject({ status: 'accepted', cleared: true });
    });

    it('blocks a selected unavailable attachment before delegation and preserves it for removal or recovery', async () => {
        const admit = vi.fn(async () => ({ status: 'accepted' as const }));
        const clearAcceptedSnapshot = vi.fn(() => true);
        const unavailableAttachment = {
            ...issueAttachment,
            availability: { status: 'unavailable', reason: 'plugin-not-installed' } as const,
        } satisfies ComposerAttachmentViewV1;

        const result = await submitComposerSnapshot({
            snapshot: createSnapshot({ text: 'Keep this visible', attachments: [unavailableAttachment] }),
            route: { kind: 'session', ref: { kind: 'session', sessionId: 'session-1' }, admit },
            clearAcceptedSnapshot,
        });

        expect(result).toMatchObject({ status: 'blocked', reason: 'attachmentUnavailable' });
        expect(admit).not.toHaveBeenCalled();
        expect(clearAcceptedSnapshot).not.toHaveBeenCalled();
    });

    it('delegates pending attachments through the one canonical pending admission', async () => {
        const admit = vi.fn(async (_snapshot: ComposerSubmissionSnapshot) => ({ status: 'accepted' as const }));
        const clearAcceptedSnapshot = vi.fn(() => true);
        const snapshot = createSnapshot({
            ref: { kind: 'pendingMessage', sessionId: 'session-1', localId: 'pending-1' },
        });

        const result = await submitComposerSnapshot({
            snapshot,
            route: {
                kind: 'pendingMessage',
                ref: { kind: 'pendingMessage', sessionId: 'session-1', localId: 'pending-1' },
                admit,
            },
            clearAcceptedSnapshot,
        });

        expect(admit.mock.calls[0]?.[0]).toMatchObject({
            ref: { kind: 'pendingMessage', sessionId: 'session-1', localId: 'pending-1' },
            attachments: [issueAttachment],
        });
        expect(clearAcceptedSnapshot).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ status: 'accepted', cleared: true });
    });

    it('delegates reference-only pending edits through the same canonical pending admission', async () => {
        const admit = vi.fn(async (_snapshot: ComposerSubmissionSnapshot) => ({ status: 'accepted' as const }));
        const clearAcceptedSnapshot = vi.fn(() => true);
        const snapshot = createSnapshot({
            ref: { kind: 'pendingMessage', sessionId: 'session-1', localId: 'pending-1' },
            text: '@issue-43',
            references: [{ ...issueReference, ref: 'issue:43', token: '@issue-43', label: 'Issue #43' }],
            attachments: [issueAttachment],
        });

        const result = await submitComposerSnapshot({
            snapshot,
            route: {
                kind: 'pendingMessage',
                ref: { kind: 'pendingMessage', sessionId: 'session-1', localId: 'pending-1' },
                admit,
            },
            clearAcceptedSnapshot,
        });

        expect(admit.mock.calls[0]?.[0]).toMatchObject({
            references: [{ ref: 'issue:43', token: '@issue-43' }],
            attachments: [issueAttachment],
        });
        expect(result).toMatchObject({ status: 'accepted', cleared: true });
    });
});
