import type {
    ComposerRefV1,
    ComposerSnapshotV1,
    ComposerTransactionResultV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { PluginUiComposerAttachmentProjection } from '@/sync/domains/plugins/ui/projection';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    readComposerPresentationSnapshot,
    registerComposerPresentationTarget,
    type ComposerPresentationDocumentMutation,
    type ComposerPresentationTarget,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import {
    clearAllNewSessionComposerAttachmentSeeds,
    readNewSessionComposerAttachmentSeeds,
    writeNewSessionComposerAttachmentSeeds,
    type NewSessionComposerAttachmentSeedV1,
} from './newSessionComposerAttachmentSeedStore';

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
        title: { key: 'attachment.entry', fallback: 'Entry' },
        icon: 'file',
        cardinality: 'many',
        valueSchema: { type: 'object' },
    },
    valueValidator: () => true,
} satisfies PluginUiComposerAttachmentProjection;

const scope = Object.freeze({
    serverId: 'server-a',
    accountId: 'account-a',
}) satisfies ServerAccountScope;
const otherScope = Object.freeze({
    serverId: 'server-a',
    accountId: 'account-b',
}) satisfies ServerAccountScope;
const draftId = 'draft-seeded-attachments';

const seeds: readonly NewSessionComposerAttachmentSeedV1[] = [{
    pluginId: 'happier.triage',
    attachmentLocalId: 'entry',
    value: {
        key: 'entry:42',
        value: { entryId: '42' },
        presentation: { label: 'PR #42' },
    },
}, {
    pluginId: 'happier.triage',
    attachmentLocalId: 'entry',
    value: {
        key: 'entry:43',
        value: { entryId: '43' },
        presentation: { label: 'Issue #43' },
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
        clearAllNewSessionComposerAttachmentSeeds();
        standardCleanup();
    });

    it('admits a host seed only through the mounted Composer transaction and does not repeat it', async () => {
        writeNewSessionComposerAttachmentSeeds({ scope, draftId }, seeds);
        cleanups.push(registerComposerPresentationTarget(ref, createTarget()));
        const hook = await renderHook(() => useNewSessionSeededComposerAttachments({
            scope,
            draftId,
            ref,
            entriesById: { [entry.id]: entry },
            isCurrent: () => true,
            localize: (pluginId, value) => (
                pluginId === 'happier.triage'
                && typeof value === 'object'
                && value !== null
                && 'key' in value
                    ? 'Entrada'
                    : String(value)
            ),
        }));

        expect(readComposerPresentationSnapshot(ref)?.attachments).toEqual([
            expect.objectContaining({
                instanceId: 'host-minted-1',
                attachment: { pluginId: 'happier.triage', localId: 'entry' },
                key: 'entry:42',
                value: { entryId: '42' },
                presentation: { label: 'PR #42', typeLabel: 'Entrada' },
            }),
            expect.objectContaining({
                instanceId: 'host-minted-2',
                attachment: { pluginId: 'happier.triage', localId: 'entry' },
                key: 'entry:43',
                value: { entryId: '43' },
                presentation: { label: 'Issue #43', typeLabel: 'Entrada' },
            }),
        ]);

        await hook.rerender();
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(readComposerPresentationSnapshot(ref)?.attachments).toHaveLength(2);
        expect(readNewSessionComposerAttachmentSeeds({ scope, draftId })).toEqual([]);
    });

    it('keeps a seed pending across unmount until the current Composer catalog admits it', async () => {
        writeNewSessionComposerAttachmentSeeds({ scope, draftId }, seeds);
        writeNewSessionComposerAttachmentSeeds({ scope: otherScope, draftId }, [{
            ...seeds[0]!,
            value: { ...seeds[0]!.value, key: 'other-account' },
        }]);
        cleanups.push(registerComposerPresentationTarget(ref, createTarget()));
        const firstMount = await renderHook(() => useNewSessionSeededComposerAttachments({
            scope,
            draftId,
            ref,
            entriesById: {},
            isCurrent: () => true,
            localize: (_pluginId, value) => typeof value === 'string' ? value : 'Entry',
        }));

        expect(readComposerPresentationSnapshot(ref)?.attachments).toEqual([]);
        expect(readNewSessionComposerAttachmentSeeds({ scope, draftId })).toEqual(seeds);
        await firstMount.unmount();

        await renderHook(() => useNewSessionSeededComposerAttachments({
            scope,
            draftId,
            ref,
            entriesById: { [entry.id]: entry },
            isCurrent: () => true,
            localize: (_pluginId, value) => typeof value === 'string' ? value : 'Entry',
        }));
        expect(readComposerPresentationSnapshot(ref)?.attachments).toHaveLength(2);
        expect(readNewSessionComposerAttachmentSeeds({ scope, draftId })).toEqual([]);
        expect(readNewSessionComposerAttachmentSeeds({ scope: otherScope, draftId }))
            .toHaveLength(1);
    });

    it('clears only the exact seeds whose canonical Composer transactions applied', async () => {
        const unavailableSeed: NewSessionComposerAttachmentSeedV1 = {
            pluginId: 'acme.unavailable',
            attachmentLocalId: 'entry',
            value: {
                key: 'unavailable:1',
                value: { entryId: 'unavailable' },
                presentation: { label: 'Unavailable entry' },
            },
        };
        writeNewSessionComposerAttachmentSeeds({ scope, draftId }, [seeds[0]!, unavailableSeed]);
        cleanups.push(registerComposerPresentationTarget(ref, createTarget()));

        await renderHook(() => useNewSessionSeededComposerAttachments({
            scope,
            draftId,
            ref,
            entriesById: { [entry.id]: entry },
            isCurrent: () => true,
            localize: (_pluginId, value) => typeof value === 'string' ? value : 'Entry',
        }));

        expect(readComposerPresentationSnapshot(ref)?.attachments).toHaveLength(1);
        expect(readNewSessionComposerAttachmentSeeds({ scope, draftId }))
            .toEqual([unavailableSeed]);
    });
});
