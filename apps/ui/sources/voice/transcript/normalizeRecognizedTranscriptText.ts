export function normalizeRecognizedTranscriptText(rawText: string | null): string | null {
    const text = rawText?.trim();
    if (!text) return null;
    // Recognizers without punctuation/casing can return whole utterances in
    // uppercase. Keep supplied mixed casing, including acronyms and filenames.
    if (text !== text.toUpperCase() || text === text.toLowerCase()) return text;
    return text.toLowerCase()
        .replace(/(^|[.!?]\s+)([^\p{L}]*)(\p{L})/gu, (_match, boundary: string, prefix: string, letter: string) => (
            boundary + prefix + letter.toUpperCase()
        ));
}
