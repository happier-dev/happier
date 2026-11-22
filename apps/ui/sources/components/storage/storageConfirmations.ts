import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

import { Modal } from '@/modal';
import { t } from '@/text';

const formatBytes = (bytes: number) => formatHappierDataBytes(bytes, { kind: 'storage' });

/**
 * Storage view lab scene 3: the two new confirmations, in the app's one dialog (`Modal.confirm`, the same owner as the
 * shipped Artifact delete). Each says what clearing frees as the dialog's facts; every number is the producer's (the trim or removal
 * owner's preview), never a sum made here. They are not yet wired: STORAGE-1119 owns the Actions that run after them.
 */
export async function confirmTrimOldVersions(input: Readonly<{
    title: string;
    freesBytes: number;
    /** What the Artifact limit becomes, as the trim owner reports it; `null` when no limit is set. */
    limitAfter: Readonly<{ leftBytes: number; limitBytes: number }> | null;
}>): Promise<boolean> {
    return Modal.confirm(t('artifacts.browser.storageView.confirm.trimTitle', { title: input.title }), undefined, {
        destructive: true,
        confirmText: t('artifacts.browser.storageView.confirm.trimConfirm'),
        messageParagraphs: [{ text: t('artifacts.browser.storageView.confirm.trimBody') }],
        facts: [
            { label: t('artifacts.browser.storageView.confirm.freesLabel'), value: formatBytes(input.freesBytes) },
            ...(input.limitAfter ? [{ label: t('artifacts.browser.storageView.confirm.limitAfterLabel'),
                value: t('artifacts.browser.storageView.confirm.limitAfterValue', {
                    left: formatBytes(input.limitAfter.leftBytes), limit: formatBytes(input.limitAfter.limitBytes) }) }] : []),
        ],
    });
}

/** Remove a committed Discussion file: the message stays and says the file was removed (owner Q2: author or owner). */
export async function confirmRemoveDiscussionFile(input: Readonly<{
    name: string;
    /** The Discussion's name when the caller has it; without it the body says "the message". */
    discussionTitle: string | null;
    /** The viewer wrote the message ("Your message"); otherwise they own the Discussion. */
    own: boolean;
    freesBytes: number;
}>): Promise<boolean> {
    return Modal.confirm(t('artifacts.browser.storageView.confirm.removeTitle', { name: input.name }), undefined, {
        destructive: true,
        confirmText: t('artifacts.browser.storageView.confirm.removeConfirm'),
        messageParagraphs: [
            { text: input.discussionTitle === null ? t('artifacts.browser.storageView.confirm.removeBody')
                : input.own ? t('artifacts.browser.storageView.confirm.removeOwnBody', { discussion: input.discussionTitle })
                    : t('artifacts.browser.storageView.confirm.removeOtherBody', { discussion: input.discussionTitle }), irreversible: true },
        ],
        facts: [{ label: t('artifacts.browser.storageView.confirm.freesLabel'), value: formatBytes(input.freesBytes) }],
    });
}
