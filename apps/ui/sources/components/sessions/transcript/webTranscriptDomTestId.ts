export type WebTranscriptExactDataTestIdLookupResult = Readonly<{
    attempted: boolean;
    element: Element | null;
}>;

type WebTranscriptExactDataTestIdLookupContainer = Readonly<{
    querySelector?: ((selector: string) => Element | null) | null;
}>;

export function queryExactWebTranscriptDataTestId(
    container: WebTranscriptExactDataTestIdLookupContainer,
    testId: string,
): WebTranscriptExactDataTestIdLookupResult {
    if (typeof container.querySelector !== 'function') {
        return { attempted: false, element: null };
    }

    try {
        const selector = `[data-testid="${escapeCssAttributeStringValue(testId)}"]`;
        return {
            attempted: true,
            element: container.querySelector(selector),
        };
    } catch {
        return { attempted: false, element: null };
    }
}

function escapeCssAttributeStringValue(value: string): string {
    return value.replace(/[\0-\x1f\x7f"\\]/g, (char) => {
        if (char === '"' || char === '\\') return `\\${char}`;
        return `\\${char.charCodeAt(0).toString(16)} `;
    });
}
