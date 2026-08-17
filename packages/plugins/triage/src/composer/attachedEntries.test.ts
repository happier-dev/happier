import type { ComposerAttachmentViewV1, ComposerReadResultV1 } from '@happier-dev/plugin-sdk/ui';
import { describe, expect, it } from 'vitest';

import {
    findTriageAttachedEntry,
    projectTriageEntriesCompactState,
    selectTriageAttachedEntries,
} from './attachedEntries.js';
import { deriveTriageComposerEntryAttachmentKey } from './attachmentValue.js';

const SOURCE = { pluginId: 'happier.forge', localId: 'items' } as const;
const INSTANCE_ID = '2f1c9b4e-7a55-4a8c-9d2e-0b6f4c3a1d78';

function entryRef(entryId: string) {
    return { source: SOURCE, kindId: 'pull-request', collisionScope: 'origin', entryId } as const;
}

function triageAttachment(input: Readonly<{
    entryId: string;
    instanceId: string;
    label?: string;
    availability?: ComposerAttachmentViewV1['availability'];
    icon?: 'file';
}>): ComposerAttachmentViewV1 {
    const ref = entryRef(input.entryId);
    return {
        v: 1,
        instanceId: input.instanceId,
        attachment: { pluginId: 'happier.triage', localId: 'entry' },
        key: deriveTriageComposerEntryAttachmentKey(ref),
        value: {
            v: 1,
            entryRef: ref,
            sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE_ID },
        },
        presentation: {
            typeLabel: 'Pull request',
            label: input.label ?? `Fix ${input.entryId}`,
            ...(input.icon === undefined ? {} : { icon: input.icon }),
        },
        availability: input.availability ?? { status: 'ready' },
    } as ComposerAttachmentViewV1;
}

function foreignAttachment(instanceId: string): ComposerAttachmentViewV1 {
    return {
        v: 1,
        instanceId,
        // Another plugin may declare an attachment with the same local id and
        // even the same value shape; only the qualified identity separates them.
        attachment: { pluginId: 'happier.files', localId: 'entry' },
        key: deriveTriageComposerEntryAttachmentKey(entryRef('99')),
        value: {
            v: 1,
            entryRef: entryRef('99'),
            sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE_ID },
        },
        presentation: { typeLabel: 'File', label: 'x' },
        availability: { status: 'ready' },
    } as ComposerAttachmentViewV1;
}

function readyRead(attachments: readonly ComposerAttachmentViewV1[]): ComposerReadResultV1 {
    return {
        status: 'ready',
        snapshot: {
            revision: 7,
            ref: { kind: 'session', sessionId: 'session-1' },
            text: 'draft',
            references: [],
            attachments: [...attachments],
            layout: 'wrap',
            capabilities: { text: true, references: true, attachments: true, submit: true },
            state: {
                focused: true,
                editable: true,
                submittable: true,
                submitting: false,
                running: false,
            },
        },
    } as ComposerReadResultV1;
}

describe('selectTriageAttachedEntries', () => {
    it('keeps only the qualified Triage entry attachment', () => {
        // Another plugin's attachment may use the same local id; only the
        // qualified identity separates them inside one shared snapshot.
        const attached = selectTriageAttachedEntries([
            foreignAttachment('other-1'),
            triageAttachment({ entryId: '42', instanceId: 'triage-1' }),
        ]);

        expect(attached.map((entry) => entry.instanceId)).toEqual(['triage-1']);
    });

    it('projects the identity of each attached entry from its persisted value', () => {
        const attached = selectTriageAttachedEntries([
            triageAttachment({ entryId: '42', instanceId: 'triage-1' }),
        ]);

        expect(attached[0]?.identity).toEqual({
            entryRef: entryRef('42'),
            sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE_ID },
        });
    });

    it('keeps a record whose value no longer parses, with a null identity', () => {
        // The record still exists in the draft and stays host-removable, so
        // dropping it here would under-report what the message will carry.
        const unparseable = {
            ...triageAttachment({ entryId: '42', instanceId: 'triage-1' }),
            value: { v: 1, entryRef: entryRef('42') },
        } as ComposerAttachmentViewV1;

        const attached = selectTriageAttachedEntries([unparseable]);

        expect(attached).toHaveLength(1);
        expect(attached[0]?.identity).toBeNull();
    });

    it('keeps a record the host reports unavailable or invalid', () => {
        const attached = selectTriageAttachedEntries([
            triageAttachment({
                entryId: '42',
                instanceId: 'triage-1',
                availability: { status: 'unavailable', reason: 'source uninstalled' },
            }),
        ]);

        expect(attached).toHaveLength(1);
        expect(attached[0]?.availability.status).toBe('unavailable');
    });
});

describe('findTriageAttachedEntry', () => {
    it('matches a corpus row by its canonical key rather than by object identity', () => {
        const attached = selectTriageAttachedEntries([
            triageAttachment({ entryId: '42', instanceId: 'triage-1' }),
        ]);

        // A freshly read corpus row is a different object with the same
        // canonical identity; the picker must still show it as attached.
        expect(findTriageAttachedEntry(attached, { ...entryRef('42') })?.instanceId).toBe('triage-1');
        expect(findTriageAttachedEntry(attached, entryRef('43'))).toBeNull();
    });

    it('matches a record whose value no longer parses through its persisted key', () => {
        const unparseable = {
            ...triageAttachment({ entryId: '42', instanceId: 'triage-1' }),
            value: { v: 1 },
        } as ComposerAttachmentViewV1;

        const attached = selectTriageAttachedEntries([unparseable]);

        expect(findTriageAttachedEntry(attached, entryRef('42'))?.instanceId).toBe('triage-1');
    });
});

describe('projectTriageEntriesCompactState', () => {
    it('renders the truthful static declaration with no count and no selection at zero', () => {
        expect(projectTriageEntriesCompactState(readyRead([foreignAttachment('other-1')]))).toEqual({
            kind: 'none',
            selected: false,
            label: { kind: 'staticTitle' },
            icon: { kind: 'declaration' },
        });
    });

    it('renders the single entry label and its admitted icon at one', () => {
        expect(projectTriageEntriesCompactState(readyRead([
            triageAttachment({ entryId: '42', instanceId: 'triage-1', label: 'Fix the parser', icon: 'file' }),
        ]))).toEqual({
            kind: 'one',
            selected: true,
            label: { kind: 'entry', text: 'Fix the parser' },
            icon: { kind: 'admitted', token: 'file' },
        });
    });

    it('falls back to the declaration icon when the record admitted none', () => {
        const state = projectTriageEntriesCompactState(readyRead([
            triageAttachment({ entryId: '42', instanceId: 'triage-1' }),
        ]));

        expect(state.icon).toEqual({ kind: 'declaration' });
    });

    it('renders a count and the declaration icon at many', () => {
        expect(projectTriageEntriesCompactState(readyRead([
            triageAttachment({ entryId: '42', instanceId: 'triage-1' }),
            triageAttachment({ entryId: '43', instanceId: 'triage-2' }),
            foreignAttachment('other-1'),
        ]))).toEqual({
            kind: 'many',
            selected: true,
            label: { kind: 'count', count: 2 },
            icon: { kind: 'declaration' },
        });
    });

    it('counts a record whose projected presentation is unavailable or unparseable', () => {
        const state = projectTriageEntriesCompactState(readyRead([
            triageAttachment({ entryId: '42', instanceId: 'triage-1' }),
            triageAttachment({
                entryId: '43',
                instanceId: 'triage-2',
                availability: { status: 'invalid', reason: 'declaration changed' },
            }),
        ]));

        expect(state).toEqual({
            kind: 'many',
            selected: true,
            label: { kind: 'count', count: 2 },
            icon: { kind: 'declaration' },
        });
    });

    it('never remembers a previous count once the composer read is unavailable or still loading', () => {
        // The projection owns no state: a remembered count would keep claiming
        // attachments after the addressed scope closed.
        projectTriageEntriesCompactState(readyRead([
            triageAttachment({ entryId: '42', instanceId: 'triage-1' }),
            triageAttachment({ entryId: '43', instanceId: 'triage-2' }),
        ]));

        const closed = projectTriageEntriesCompactState({ status: 'unavailable', reason: 'scopeClosed' });
        const loading = projectTriageEntriesCompactState(null);

        expect(closed).toEqual({
            kind: 'none',
            selected: false,
            label: { kind: 'staticTitle' },
            icon: { kind: 'declaration' },
        });
        expect(loading).toEqual(closed);
    });
});
