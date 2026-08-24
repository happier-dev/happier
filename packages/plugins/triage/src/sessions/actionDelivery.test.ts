import { describe, expect, it } from 'vitest';

import { deriveTriageComposerEntryAttachmentKey } from '../composer/attachmentValue.js';
import { planTriageActionDeliveryV1 } from './actionDelivery.js';

const SOURCE = { pluginId: 'happier.forge', localId: 'items' } as const;
const INSTANCE_ID = '2f1c9b4e-7a55-4a8c-9d2e-0b6f4c3a1d78';
const SOURCE_INSTANCE = { source: SOURCE, sourceInstanceId: INSTANCE_ID } as const;
const ENTRY_REF = {
    source: SOURCE,
    kindId: 'pull-request',
    collisionScope: 'origin',
    entryId: '42',
} as const;
const PRESENTATION = { label: 'Fix the parser', description: 'acme/api' } as const;

const ENTRY = {
    entryRef: ENTRY_REF,
    sourceInstance: SOURCE_INSTANCE,
    presentation: PRESENTATION,
} as const;

const BASE = { entries: [ENTRY] } as const;

/** The same one entry, read through a connection that could never observe it. */
const UNOBSERVABLE_ENTRY = {
    ...ENTRY,
    sourceInstance: {
        source: { pluginId: 'happier.other', localId: 'items' },
        sourceInstanceId: INSTANCE_ID,
    },
} as const;

describe('what happens to the resolved prompt once a Session exists', () => {
    it('sends the prompt WITH the entry attached, never the prompt alone', () => {
        const plan = planTriageActionDeliveryV1({
            ...BASE,
            delivery: 'send',
            promptText: '  Repair the failing parser test.  ',
        });

        expect(plan.kind).toBe('send');
        if (plan.kind !== 'send') return;
        expect(plan.text).toBe('Repair the failing parser test.');
        // A direct send that delivered a prompt and no entry context is the
        // exact failure `PLAN.md` §0a A4a exists to prevent.
        expect(plan.attachments).toHaveLength(1);
        expect(plan.attachments[0]).toEqual({
            attachmentLocalId: 'entry',
            value: {
                key: deriveTriageComposerEntryAttachmentKey(ENTRY_REF),
                value: { v: 1, entryRef: ENTRY_REF, sourceInstance: SOURCE_INSTANCE },
                presentation: PRESENTATION,
            },
        });
    });

    it('composes the same prompt and the same attachment, and sends nothing', () => {
        const composed = planTriageActionDeliveryV1({
            ...BASE,
            delivery: 'compose',
            promptText: 'Repair the failing parser test.',
        });
        const sent = planTriageActionDeliveryV1({
            ...BASE,
            delivery: 'send',
            promptText: 'Repair the failing parser test.',
        });

        expect(composed.kind).toBe('compose');
        if (composed.kind !== 'compose' || sent.kind !== 'send') return;
        expect(composed.text).toBe('Repair the failing parser test.');
        // One entry, attached the same way whichever arm placed it.
        expect(composed.attachments).toEqual(sent.attachments);
    });

    it('preserves every selected entry in order for a bulk New Session seed', () => {
        const second = {
            ...ENTRY,
            entryRef: { ...ENTRY_REF, entryId: '99' },
            presentation: { label: 'Fix the serializer', description: 'acme/api' },
        } as const;
        const plan = planTriageActionDeliveryV1({
            entries: [ENTRY, second],
            delivery: 'compose',
            promptText: null,
        });

        expect(plan.kind).toBe('compose');
        if (plan.kind !== 'compose') return;
        expect(plan.attachments.map((attachment) => attachment.value.key)).toEqual([
            deriveTriageComposerEntryAttachmentKey(ENTRY_REF),
            deriveTriageComposerEntryAttachmentKey(second.entryRef),
        ]);
        expect(plan.attachments.map((attachment) => attachment.value.presentation.label))
            .toEqual(['Fix the parser', 'Fix the serializer']);
    });

    it('still attaches the entry when a compose action names no prompt', () => {
        const plan = planTriageActionDeliveryV1({ ...BASE, delivery: 'compose', promptText: null });

        expect(plan.kind).toBe('compose');
        if (plan.kind !== 'compose') return;
        expect(plan.text).toBeUndefined();
        expect(plan.attachments).toHaveLength(1);
    });

    it('sends the entry attachment when a send action names no prompt', () => {
        // `settings/actions.ts` states the contract: without a prompt, `delivery`
        // says whether the Session opens with the entry attached and waiting, or
        // SENDS THAT ATTACHMENT STRAIGHT AWAY. Returning `none` here contradicted
        // it and made a promptless send action deliver nothing at all — the exact
        // silent context loss `PLAN.md` §0a A4a names.
        for (const promptText of [null, '   ']) {
            const plan = planTriageActionDeliveryV1({ ...BASE, delivery: 'send', promptText });
            expect(plan.kind).toBe('send');
            if (plan.kind !== 'send') continue;
            expect(plan.text).toBe('');
            expect(plan.attachments).toHaveLength(1);
        }
    });

    it('sends nothing only when neither a prompt nor a placeable attachment exists', () => {
        // Both arms agree on the one canonical emptiness rule: an input carrying
        // neither text nor an attachment is nothing to say, and a blank message
        // announcing the Session is a message the reader never wrote.
        const unattachable = { entries: [UNOBSERVABLE_ENTRY], promptText: null } as const;
        expect(planTriageActionDeliveryV1({ ...unattachable, delivery: 'send' }))
            .toEqual({ kind: 'none' });
        expect(planTriageActionDeliveryV1({ ...unattachable, delivery: 'compose' }))
            .toEqual({ kind: 'none' });
    });

    it('carries the observed routing hint into the attached value when one was observed', () => {
        const lastKnownLocator = {
            v: 1,
            routingToken: 'opaque-token',
            webUrl: 'https://example.test/pr/42',
        } as never;
        const plan = planTriageActionDeliveryV1({
            entries: [{ ...ENTRY, lastKnownLocator }],
            delivery: 'send',
            promptText: 'go',
        });

        expect(plan.kind).toBe('send');
        if (plan.kind !== 'send') return;
        expect(plan.attachments[0]?.value.value).toEqual({
            v: 1,
            entryRef: ENTRY_REF,
            sourceInstance: SOURCE_INSTANCE,
            lastKnownLocator,
        });
    });

    it('refuses to attach an entry under a connection that could never observe it', () => {
        const plan = planTriageActionDeliveryV1({
            entries: [UNOBSERVABLE_ENTRY],
            delivery: 'send',
            promptText: 'go',
        });

        // The prompt still travels: the reader asked for this work to start,
        // and losing it because one optional member did not validate would
        // refuse the whole press over part of it.
        expect(plan.kind).toBe('send');
        if (plan.kind !== 'send') return;
        expect(plan.text).toBe('go');
        expect(plan.attachments).toEqual([]);
    });
});
