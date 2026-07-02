export type TranscriptSelectableMessageRole = 'user' | 'assistant';

export type TranscriptSelectableMessageText = Readonly<{
    role: TranscriptSelectableMessageRole;
    text: string;
}>;

export type TranscriptBulkCopyFormat = 'markdown_labeled' | 'plain';
