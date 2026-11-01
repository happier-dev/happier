/**
 * Appends a selected transcript passage to a composer draft as a Markdown blockquote, followed by
 * an empty line where the reply goes. Returns `null` for a blank selection so the caller leaves the
 * draft untouched.
 */
export function appendTranscriptQuoteToDraft(draft: string, selectedText: string): string | null {
    const lines = selectedText.replace(/\r\n?/g, '\n').trim().split('\n');
    if (lines.length === 1 && lines[0] === '') return null;
    const quote = lines
        .map((line) => {
            const content = line.trimEnd();
            return content.length > 0 ? `> ${content}` : '>';
        })
        .join('\n');
    const separator = draft.length === 0 || draft.endsWith('\n\n') ? '' : draft.endsWith('\n') ? '\n' : '\n\n';
    return `${draft}${separator}${quote}\n\n`;
}
