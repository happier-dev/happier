export function countTextLinesUpTo(text: string, maxLines: number): number {
    if (maxLines <= 0) return 0;

    const input = String(text ?? '');
    // Match `text.split('\n').length` semantics: even an empty string is 1 line.
    let lines = 1;

    for (let i = 0; i < input.length; i++) {
        if (input.charCodeAt(i) === 10) {
            lines += 1;
            if (lines >= maxLines) return maxLines;
        }
    }

    return lines;
}
