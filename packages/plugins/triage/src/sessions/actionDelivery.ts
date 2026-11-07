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
     * There is nothing to deliver. For `send`, an instruction is mandatory:
     * the attachment supplies context but does not say what the agent should do.
     * For `compose`, an attachment alone remains useful editable input.
     */
    | Readonly<{ kind: 'none' }>
    | Readonly<{
        kind: 'send';
        /** Always non-empty after whitespace admission. */
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
    /** Ordinary admitted attachment values, shared by compose and send. */
    attachments?: readonly TriageEntryAttachmentDraftV1[];
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
    attachments.push(...(input.attachments ?? []));
    // The Prompt Library renderer owns these bytes. Use trimming only to apply
    // the canonical "whitespace alone is no text" rule; when content exists,
    // preserve it exactly so indentation and trailing Markdown/newlines do not
    // change merely because the invocation came through a Triage action.
    const resolvedText = input.promptText ?? '';
    const text = resolvedText.trim().length === 0 ? '' : resolvedText;

    // Direct send requires intent, not only context. The generic Session input
    // seam permits attachment-only sends because other products can own that
    // meaning; Triage's action contract is narrower and refuses to invent the
    // missing task for an agent.
    if (input.delivery === 'send' && text.length === 0) return { kind: 'none' };

    // Compose still uses the canonical Session-input emptiness rule: an entry
    // attachment is useful editable input even when Ask deliberately supplies
    // no initial prose.
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
