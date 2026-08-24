import type { ComposerAttachmentAuthorPresentationV1 } from '@happier-dev/plugin-sdk/ui';
import type {
    TriageEntryLocatorV1,
    TriageEntryRefV1,
    TriageSourceInstanceRefV1,
} from '@happier-dev/triage-protocol/v1';

import { hasSessionInputContentV1 } from '@happier-dev/plugin-sdk/sessions';

import {
    buildTriageEntryAttachmentDraftV1,
    type TriageEntryAttachmentDraftV1,
} from '../composer/mutationPlan.js';
import type { TriageActionDeliveryV1 } from '../settings/actions.js';

/**
 * What happens to the resolved prompt once a Session exists (`PLAN.md` §0a A4a).
 *
 * `delivery` is the member that decides it, and until now it decided nothing:
 * every press produced a Session with an empty composer regardless of what the
 * action said. The two arms are genuinely different user actions:
 *
 *  - **`send`** — the reader asked for the work to start. The prompt is sent
 *    immediately, with no second confirmation, through the canonical Session
 *    input seam WITH the entry attached. The attachment is the point: a direct
 *    send that delivered a prompt and no entry context is the exact failure
 *    A4a exists to prevent, and the entry's authoritative facts are resolved at
 *    dispatch by the attachment's own `resolveForDispatch` rather than
 *    stringified into the text.
 *  - **`compose`** — the reader asked to look first. The same text and the same
 *    attachment are placed in the new Session's composer and nothing is sent,
 *    so they can edit, add, or abandon it.
 *
 * Both arms carry one attachment draft per valid entry, built by the one
 * composer-side owner (`composer/mutationPlan.ts#buildTriageEntryAttachmentDraftV1`),
 * so an entry attached by a direct send and an entry attached by the picker are
 * the same record.
 *
 * **The Prompt Library's own `behavior` does not decide this.**
 * `insert | insert_on_send | insert_and_send` is the affordance for somebody
 * typing that slash token into a composer; the action's `delivery` is what its
 * author configured here. The Library owns WHICH content resolves; the action
 * owns WHETHER it is composed or sent.
 */

export type TriageActionDeliveryPlanV1 =
    /**
     * There is nothing to deliver: the action references no prompt AND the entry
     * cannot be attached. Deliberately distinct from an attachment-only send,
     * which carries real content, and from a blank message with nothing on it.
     */
    | Readonly<{ kind: 'none' }>
    | Readonly<{
        kind: 'send';
        /** Empty only when the attachment is the whole input. */
        text: string;
        attachments: readonly TriageEntryAttachmentDraftV1[];
    }>
    | Readonly<{
        kind: 'compose';
        /** Absent when the action references no prompt; the attachment still lands. */
        text?: string;
        attachments: readonly TriageEntryAttachmentDraftV1[];
    }>;

/**
 * The entry facts one attachment draft is built from.
 *
 * A delivery carries ONE of these per entry the press acts on. A single-entry
 * press supplies one; a bulk press that asked for one Session with the whole
 * selection attached supplies all of them, in the order the reader chose them.
 * The two are one code path on purpose: "attach the entry" and "attach the
 * entries" differ only in how many there are, and a second builder for the
 * plural case is how one of them ends up attaching a different record.
 */
export type TriageActionDeliveryEntryV1 = Readonly<{
    entryRef: TriageEntryRefV1;
    sourceInstance: TriageSourceInstanceRefV1;
    presentation: ComposerAttachmentAuthorPresentationV1;
    lastKnownLocator?: TriageEntryLocatorV1;
}>;

export function planTriageActionDeliveryV1(input: Readonly<{
    delivery: TriageActionDeliveryV1;
    /** The prompt body the Library resolved, or nothing when the action names none. */
    promptText: string | null;
    /**
     * Every entry this press attaches, in the reader's own order. An entry the
     * value parser refuses contributes no attachment and does not refuse the
     * others: losing four valid entries because a fifth carried a mismatched
     * connection is a different failure from the one being prevented.
     */
    entries: readonly TriageActionDeliveryEntryV1[];
}>): TriageActionDeliveryPlanV1 {
    const attachments = input.entries.flatMap((entry) => {
        const draft = buildTriageEntryAttachmentDraftV1({
            entryRef: entry.entryRef,
            sourceInstance: entry.sourceInstance,
            presentation: entry.presentation,
            ...(entry.lastKnownLocator === undefined
                ? {}
                : { lastKnownLocator: entry.lastKnownLocator }),
        });
        return draft === null ? [] : [draft];
    });
    const text = input.promptText === null ? '' : input.promptText.trim();

    // The one canonical emptiness rule, shared with the Session-input seam that
    // admits the send (`protocol#hasSessionInputContentV1`): an input carrying
    // neither text nor an attachment has nothing to say, and everything else
    // does. Both arms answer it the same way, so a promptless action delivers
    // its entry either way — which is what `settings/actions.ts` promises:
    // without a prompt, `delivery` decides whether the Session opens with the
    // entry attached and waiting, or sends that attachment straight away.
    if (!hasSessionInputContentV1({ text, attachmentCount: attachments.length })) {
        return { kind: 'none' };
    }

    if (input.delivery === 'send') return { kind: 'send', text, attachments };

    return {
        kind: 'compose',
        ...(text.length === 0 ? {} : { text }),
        attachments,
    };
}
