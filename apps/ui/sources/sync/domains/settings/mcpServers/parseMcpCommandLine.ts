export function parseMcpCommandLine(raw: string): Readonly<{ command: string; args: string[] }> {
    const input = String(raw ?? '').trim();
    if (!input) {
        return { command: '', args: [] };
    }

    const tokens: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;

    for (let index = 0; index < input.length; index += 1) {
        const char = input[index]!;

        if (char === '\\' && index + 1 < input.length) {
            current += input[index + 1]!;
            index += 1;
            continue;
        }

        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }

        if (/\s/.test(char)) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }

        current += char;
    }

    if (current) {
        tokens.push(current);
    }

    return {
        command: tokens[0] ?? '',
        args: tokens.slice(1),
    };
}
