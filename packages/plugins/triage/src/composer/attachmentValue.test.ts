import { describe, expect, it } from 'vitest';

import {
    TRIAGE_ENTRY_ATTACHMENT_IDENTITY_V1,
    TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1,
    deriveTriageComposerEntryAttachmentKey,
    parseTriageComposerEntryAttachmentValue,
} from './attachmentValue.js';

const SOURCE = { pluginId: 'happier.forge', localId: 'items' } as const;
const INSTANCE_ID = '2f1c9b4e-7a55-4a8c-9d2e-0b6f4c3a1d78';
const OTHER_INSTANCE_ID = '9a3d1f22-4c8b-4e01-8fa7-15d0c6b93e44';

const ENTRY_REF = {
    source: SOURCE,
    kindId: 'pull-request',
    collisionScope: 'origin',
    entryId: '42',
} as const;

describe('deriveTriageComposerEntryAttachmentKey', () => {
    it('derives one stable key for one canonical entry ref', () => {
        const first = deriveTriageComposerEntryAttachmentKey(ENTRY_REF);
        const second = deriveTriageComposerEntryAttachmentKey({ ...ENTRY_REF });

        expect(second).toBe(first);
        expect(deriveTriageComposerEntryAttachmentKey({ ...ENTRY_REF, entryId: '43' })).not.toBe(first);
    });

    it('does not coalesce two contract-valid refs that a delimiter join would merge', () => {
        // `collisionScope` and `entryId` are bounded provider strings: both admit
        // any byte, including whatever delimiter a joined key would pick. A
        // joined spelling turns these two distinct entries into one attachment,
        // so attaching the second would silently replace the first.
        const scopeCarriesSeparator = deriveTriageComposerEntryAttachmentKey({
            ...ENTRY_REF,
            collisionScope: 'origin␟ region',
            entryId: '42',
        });
        const entryIdCarriesSeparator = deriveTriageComposerEntryAttachmentKey({
            ...ENTRY_REF,
            collisionScope: 'origin',
            entryId: '␟ region42',
        });
        const colonScope = deriveTriageComposerEntryAttachmentKey({
            ...ENTRY_REF,
            collisionScope: 'origin:region',
            entryId: '42',
        });
        const colonEntryId = deriveTriageComposerEntryAttachmentKey({
            ...ENTRY_REF,
            collisionScope: 'origin',
            entryId: 'region:42',
        });

        expect(entryIdCarriesSeparator).not.toBe(scopeCarriesSeparator);
        expect(colonEntryId).not.toBe(colonScope);
    });

    it('separates the same components across the kind and the qualified source', () => {
        const slashInLocalId = deriveTriageComposerEntryAttachmentKey({
            ...ENTRY_REF,
            source: { pluginId: 'happier.forge', localId: 'x/y' },
            kindId: 'z',
        });
        const slashInKindId = deriveTriageComposerEntryAttachmentKey({
            ...ENTRY_REF,
            source: { pluginId: 'happier.forge', localId: 'x' },
            kindId: 'y/z',
        });

        expect(slashInKindId).not.toBe(slashInLocalId);
    });

    it('stays a bounded attachment key for identifiers a joined spelling could not carry', () => {
        // Four independently bounded 256-byte identifiers reach past the 512
        // code-point composer attachment-key ceiling when joined.
        const key = deriveTriageComposerEntryAttachmentKey({
            source: { pluginId: `happier.${'a'.repeat(240)}`, localId: 'b'.repeat(250) },
            kindId: 'c'.repeat(250),
            collisionScope: 'd'.repeat(250),
            entryId: 'e'.repeat(250),
        });

        expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('ignores which configured instance observed the entry', () => {
        // A repeated attach of the same entry through a second connection must
        // update the one attachment in place, which only holds when the key is a
        // function of the canonical entry ref alone.
        const attachedThroughOne = parseTriageComposerEntryAttachmentValue({
            v: 1,
            entryRef: ENTRY_REF,
            sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE_ID },
        });
        const attachedThroughTwo = parseTriageComposerEntryAttachmentValue({
            v: 1,
            entryRef: ENTRY_REF,
            sourceInstance: { source: SOURCE, sourceInstanceId: OTHER_INSTANCE_ID },
        });

        expect(attachedThroughOne.status).toBe('valid');
        expect(attachedThroughTwo.status).toBe('valid');
        if (attachedThroughOne.status !== 'valid' || attachedThroughTwo.status !== 'valid') return;
        expect(deriveTriageComposerEntryAttachmentKey(attachedThroughTwo.value.entryRef))
            .toBe(deriveTriageComposerEntryAttachmentKey(attachedThroughOne.value.entryRef));
    });
});

describe('parseTriageComposerEntryAttachmentValue', () => {
    const valid = {
        v: 1,
        entryRef: ENTRY_REF,
        sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE_ID },
    };

    it('accepts the exact private identity record', () => {
        const result = parseTriageComposerEntryAttachmentValue(valid);

        expect(result).toEqual({ status: 'valid', value: valid });
    });

    it('rejects a value whose source instance belongs to another source', () => {
        // The attached instance decides which account the dispatch resolver
        // reauthorizes. An instance of another source could never observe this
        // entry, so accepting the pair would authorize the wrong connection.
        const result = parseTriageComposerEntryAttachmentValue({
            ...valid,
            sourceInstance: {
                source: { pluginId: 'happier.tracker', localId: 'items' },
                sourceInstanceId: INSTANCE_ID,
            },
        });

        expect(result.status).toBe('invalid');
        if (result.status !== 'invalid') return;
        expect(result.reason).toBe('sourceMismatch');
    });

    it('accepts the one declared routing hint and keeps it out of identity', () => {
        // An account-wide scope discovers entries across many provider scopes,
        // so the configured connection alone names none of them. Without the
        // last locator the target observed, `get` has nowhere to knock and the
        // dispatch of a perfectly valid attachment is deterministically
        // unresolved. The hint grants no authority: the source still
        // reauthorizes the exact account and still validates its answer against
        // the requested ref.
        const withHint = parseTriageComposerEntryAttachmentValue({
            ...valid,
            lastKnownLocator: { v: 1, routingToken: 'acme/web', webUrl: 'https://example.invalid/42' },
        });

        expect(withHint.status).toBe('valid');
        if (withHint.status !== 'valid') return;
        expect(withHint.value.lastKnownLocator).toEqual({
            v: 1,
            routingToken: 'acme/web',
            webUrl: 'https://example.invalid/42',
        });
        // Routing is not identity. A reattach after the repository moved must
        // update the one attachment in place rather than adding a second
        // selection of the same entry.
        expect(deriveTriageComposerEntryAttachmentKey(withHint.value.entryRef))
            .toBe(deriveTriageComposerEntryAttachmentKey(ENTRY_REF));
    });

    it('rejects any field beyond the declared record', () => {
        // The value carries durable identity plus the one declared routing
        // hint. No snapshot, credential, provider DTO, evidence or prompt text
        // ever persists here, and an undeclared spelling of the hint is refused
        // rather than silently ignored.
        const withLocator = parseTriageComposerEntryAttachmentValue({
            ...valid,
            locator: { v: 1, webUrl: 'https://example.invalid/42' },
        });
        const withEntryTag = parseTriageComposerEntryAttachmentValue({
            ...valid,
            entryRef: { ...ENTRY_REF, entryTag: 'stored-row-tag' },
        });

        expect(withLocator.status).toBe('invalid');
        expect(withEntryTag.status).toBe('invalid');
    });

    it('rejects a foreign version, a missing member, and a non-object', () => {
        expect(parseTriageComposerEntryAttachmentValue({ ...valid, v: 2 }).status).toBe('invalid');
        expect(parseTriageComposerEntryAttachmentValue({ v: 1, entryRef: ENTRY_REF }).status).toBe('invalid');
        expect(parseTriageComposerEntryAttachmentValue(null).status).toBe('invalid');
        expect(parseTriageComposerEntryAttachmentValue('42').status).toBe('invalid');
    });

    it('rejects a source instance id that is not the target-minted stable uuid', () => {
        const result = parseTriageComposerEntryAttachmentValue({
            ...valid,
            sourceInstance: { source: SOURCE, sourceInstanceId: 'instance-tag-1' },
        });

        expect(result.status).toBe('invalid');
    });
});

describe('the Triage entry attachment identity', () => {
    it('qualifies the one entry attachment under the Triage plugin', () => {
        expect(TRIAGE_ENTRY_ATTACHMENT_IDENTITY_V1).toEqual({
            pluginId: 'happier.triage',
            localId: TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1,
        });
        expect(TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1).toBe('entry');
    });
});
