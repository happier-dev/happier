import type {
    ComposerRefV1,
    ComposerSnapshotV1,
    ComposerTransactionResultV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { PluginUiComposerAttachmentProjection } from '@/sync/domains/plugins/ui/projection';
import {
    readComposerPresentationSnapshot,
    registerComposerPresentationTarget,
    type ComposerPresentationDocumentMutation,
    type ComposerPresentationTarget,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import type { NewSessionPluginAttachmentSeedV1 } from '@/utils/sessions/tempDataStore';

import { useNewSessionSeededComposerAttachments } from './useNewSessionSeededComposerAttachments';

const ref = {
    kind: 'newSession',
    instanceId: 'new-session-seeded-attachment-test',
} as const satisfies ComposerRefV1;

const entry = {
    id: 'happier.triage/entry',
    pluginId: 'happier.triage',
    identity: { pluginId: 'happier.triage', localId: 'entry' },
    immutableGenerationId: 'triage-generation-1',
    definition: {
        id: 'entry',
        title: 'Entry',
        icon: 'file',
        cardinality: 'many',
        valueSchema: { type: 'object' },
    },
    valueValidator: () => true,
} satisfies PluginUiComposerAttachmentProjection;

const seeds: readonly NewSessionPluginAttachmentSeedV1[] = [{
    pluginId: 'happier.triage',
    attachmentLocalId: 'entry',
    value: {
        key: 'entry:42',
        value: { entryId: '42' },
        presentation: { label: 'PR #42' },
    },
}];

function createSnapshot(): ComposerSnapshotV1 {
    return {
        revision: 1,
        ref,
        text: '',
        references: [],
        attachments: [],
        layout: 'wrap',
        capabilities: {
            text: true,
            references: true,
            attachments: true,
            submit: true,
        },
        state: {
            focused: false,
            editable: true,
            submittable: true,
            submitting: false,
            running: false,
        },
    };
}

function createTarget(): ComposerPresentationTarget {
    let current = createSnapshot();
    let nextInstance = 0;
    return {
        readRevision: () => current.revision,
        replace: (text, expectedRevision) => {
            if (current.revision !== expectedRevision) return current.revision;
            current = { ...current, text, revision: current.revision + 1 };
            return current.revision;
        },
        readSnapshot: () => current,
        commitDocument: (input: Readonly<{
            expectedRevision: number;
            mutation: ComposerPresentationDocumentMutation;
        }>): ComposerTransactionResultV1 => {
            if (current.revision !== input.expectedRevision) {
                return { status: 'conflict', currentRevision: current.revision };
            }
            current = {
                ...current,
                text: input.mutation.text,
                references: [...input.mutation.references],
                attachments: [...input.mutation.attachments],
                revision: current.revision + 1,
            };
            return { status: 'applied', revision: current.revision };
        },
        createAttachmentInstanceId: () => {
            nextInstance += 1;
            return `host-minted-${nextInstance}`;
        },
    };
}

describe('useNewSessionSeededComposerAttachments', () => {
    const cleanups: Array<() => void> = [];

    afterEach(() => {
        while (cleanups.length > 0) cleanups.pop()?.();
        standardCleanup();
    });

    it('admits a host seed only through the mounted Composer transaction and does not repeat it', async () => {
        cleanups.push(registerComposerPresentationTarget(ref, createTarget()));
        const hook = await renderHook(() => useNewSessionSeededComposerAttachments({
            seeds,
            ref,
            entriesById: { [entry.id]: entry },
            isCurrent: () => true,
        }));

        expect(readComposerPresentationSnapshot(ref)?.attachments).toEqual([expect.objectContaining({
            instanceId: 'host-minted-1',
            attachment: { pluginId: 'happier.triage', localId: 'entry' },
            key: 'entry:42',
            value: { entryId: '42' },
            presentation: { label: 'PR #42', typeLabel: 'Entry' },
        })]);

        await hook.rerender();
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(readComposerPresentationSnapshot(ref)?.attachments).toHaveLength(1);
    });

    it('keeps a seed pending until the current Composer catalog admits its contribution', async () => {
        cleanups.push(registerComposerPresentationTarget(ref, createTarget()));
        const hook = await renderHook((entriesById: Readonly<Record<string, PluginUiComposerAttachmentProjection>>) => (
            useNewSessionSeededComposerAttachments({
                seeds,
                ref,
                entriesById,
                isCurrent: () => true,
            })
        ), { initialProps: {} });

        expect(readComposerPresentationSnapshot(ref)?.attachments).toEqual([]);

        await hook.rerender({ [entry.id]: entry });
        expect(readComposerPresentationSnapshot(ref)?.attachments).toEqual([expect.objectContaining({
            instanceId: 'host-minted-1',
            attachment: { pluginId: 'happier.triage', localId: 'entry' },
        })]);
    });
});
