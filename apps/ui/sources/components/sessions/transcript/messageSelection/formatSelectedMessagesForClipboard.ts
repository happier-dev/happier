import type { TranscriptBulkCopyFormat, TranscriptSelectableMessageText } from './_types';

export function formatSelectedMessagesForClipboard(
    entries: ReadonlyArray<TranscriptSelectableMessageText>,
    opts: {
        format: TranscriptBulkCopyFormat;
        roleLabels: Readonly<{ user: string; assistant: string }>;
    },
): string {
    if (entries.length === 0) return '';

    if (opts.format === 'plain') {
        return entries.map((entry) => entry.text).join('\n\n');
    }

    return entries
        .map((entry) => `**${opts.roleLabels[entry.role]}:**\n\n${entry.text}`)
        .join('\n\n');
}
