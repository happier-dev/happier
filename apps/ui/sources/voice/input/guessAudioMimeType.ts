/**
 * Best-effort audio MIME type from a file name/uri extension.
 *
 * Single owner for the previously-duplicated `guessMimeType` copies across the
 * STT input layer. Unknown/extension-less inputs fall back to `audio/mp4`
 * (the default container produced by the recorder presets).
 */
export function guessAudioMimeType(uri: string): string {
    const lower = uri.toLowerCase();
    if (lower.endsWith('.webm')) return 'audio/webm';
    if (lower.endsWith('.wav')) return 'audio/wav';
    if (lower.endsWith('.mp3')) return 'audio/mpeg';
    return 'audio/mp4';
}
