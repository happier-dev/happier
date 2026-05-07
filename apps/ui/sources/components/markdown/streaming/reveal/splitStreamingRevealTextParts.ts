export type StreamingRevealTextPart = Readonly<{
    text: string;
    animated: boolean;
}>;

export function readCommonPrefixLength(a: string, b: string): number {
    const max = Math.min(a.length, b.length);
    let index = 0;
    while (index < max && a[index] === b[index]) {
        index++;
    }
    return index;
}

export function splitStreamingRevealTextParts(params: Readonly<{
    text: string;
    commonPrefixLength: number;
}>): StreamingRevealTextPart[] {
    let cursor = 0;
    return params.text
        .split(/(\s+)/)
        .filter((part) => part.length > 0)
        .map((part) => {
            const end = cursor + part.length;
            cursor = end;

            return {
                text: part,
                animated: !/^\s+$/.test(part) && end > params.commonPrefixLength,
            };
        });
}
