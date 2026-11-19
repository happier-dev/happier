/** Scan each delivery once and retain only the fragments of its unfinished line. */
export function createUsageNdjsonFramer(): Readonly<{
    write: (text: string) => Generator<string, void, undefined>;
    finish: () => string | undefined;
}> {
    const fragments: string[] = [];
    return {
        *write(text) {
            let offset = 0;
            for (let newline = text.indexOf('\n', offset); newline !== -1; newline = text.indexOf('\n', offset)) {
                fragments.push(text.slice(offset, newline));
                const line = fragments.join('');
                fragments.length = 0;
                yield line;
                offset = newline + 1;
            }
            if (offset < text.length) fragments.push(text.slice(offset));
        },
        finish() {
            if (!fragments.length) return undefined;
            const line = fragments.join('');
            fragments.length = 0;
            return line;
        },
    };
}
