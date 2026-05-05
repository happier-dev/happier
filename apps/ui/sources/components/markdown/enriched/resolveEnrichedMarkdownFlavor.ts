export type EnrichedMarkdownFlavor = 'commonmark' | 'github';

function isClosedSingleLineDisplayMath(trimmedLine: string): boolean {
    return trimmedLine.length > 4 && trimmedLine.startsWith('$$') && trimmedLine.endsWith('$$');
}

export function resolveEnrichedMarkdownFlavor(markdown: string): EnrichedMarkdownFlavor {
    const lines = markdown.split(/\r?\n/);
    let insideDisplayMath = false;

    for (const line of lines) {
        const trimmedLine = line.trim();

        if (!insideDisplayMath) {
            if (isClosedSingleLineDisplayMath(trimmedLine)) return 'github';
            if (trimmedLine === '$$') {
                insideDisplayMath = true;
            }
            continue;
        }

        if (trimmedLine === '$$' || trimmedLine.endsWith('$$')) {
            return 'github';
        }
    }

    return 'commonmark';
}
