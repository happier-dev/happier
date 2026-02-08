export type ParsedBranchInfo = {
    oid?: string;
    head?: string;
    upstream?: string;
    ahead?: number;
    behind?: number;
};

export type ParsedStatusEntry = {
    path: string;
    from: string | null;
    index: string;
    workingDir: string;
};

export type ParsedGitStatusV2Z = {
    branch: ParsedBranchInfo;
    stashCount: number;
    files: ParsedStatusEntry[];
    notAdded: string[];
};

export type ParsedNumStatFile = {
    file: string;
    insertions: number;
    deletions: number;
    binary: boolean;
};

export type ParsedNumStatSummary = {
    files: ParsedNumStatFile[];
};

function parsePorcelainEntryWithFixedFields(
    token: string,
    prefix: '1 ' | '2 ' | 'u ',
    fixedFieldCount: number,
): { fields: string[]; path: string } | null {
    if (!token.startsWith(prefix)) {
        return null;
    }

    const fields: string[] = [];
    let cursor = prefix.length;
    for (let index = 0; index < fixedFieldCount; index += 1) {
        const nextSpace = token.indexOf(' ', cursor);
        if (nextSpace === -1) {
            return null;
        }
        fields.push(token.slice(cursor, nextSpace));
        cursor = nextSpace + 1;
    }

    return {
        fields,
        path: token.slice(cursor),
    };
}

export function parseGitStatusPorcelainV2Z(statusOutput: string): ParsedGitStatusV2Z {
    const tokens = statusOutput.split('\0').filter((token) => token.length > 0);
    const parsed: ParsedGitStatusV2Z = {
        branch: {},
        stashCount: 0,
        files: [],
        notAdded: [],
    };

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i] || '';
        if (token.startsWith('# branch.oid ')) {
            parsed.branch.oid = token.slice('# branch.oid '.length);
            continue;
        }
        if (token.startsWith('# branch.head ')) {
            parsed.branch.head = token.slice('# branch.head '.length);
            continue;
        }
        if (token.startsWith('# branch.upstream ')) {
            parsed.branch.upstream = token.slice('# branch.upstream '.length);
            continue;
        }
        if (token.startsWith('# branch.ab ')) {
            const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(token);
            if (match) {
                parsed.branch.ahead = Number(match[1] || 0);
                parsed.branch.behind = Number(match[2] || 0);
            }
            continue;
        }
        if (token.startsWith('# stash ')) {
            const countRaw = token.slice('# stash '.length);
            const count = Number(countRaw);
            parsed.stashCount = Number.isFinite(count) && count >= 0 ? count : 0;
            continue;
        }
        if (token.startsWith('1 ')) {
            const parsedEntry = parsePorcelainEntryWithFixedFields(token, '1 ', 7);
            if (parsedEntry) {
                const status = parsedEntry.fields[0] || '  ';
                parsed.files.push({
                    path: parsedEntry.path,
                    from: null,
                    index: status[0] || ' ',
                    workingDir: status[1] || ' ',
                });
            }
            continue;
        }
        if (token.startsWith('2 ')) {
            const parsedEntry = parsePorcelainEntryWithFixedFields(token, '2 ', 8);
            if (parsedEntry) {
                const status = parsedEntry.fields[0] || '  ';
                const path = parsedEntry.path;
                const from = tokens[i + 1] || '';
                parsed.files.push({
                    path,
                    from: from || null,
                    index: status[0] || ' ',
                    workingDir: status[1] || ' ',
                });
                i += 1;
            }
            continue;
        }
        if (token.startsWith('u ')) {
            const parsedEntry = parsePorcelainEntryWithFixedFields(token, 'u ', 9);
            if (parsedEntry) {
                const status = parsedEntry.fields[0] || 'UU';
                parsed.files.push({
                    path: parsedEntry.path,
                    from: null,
                    index: status[0] || 'U',
                    workingDir: status[1] || 'U',
                });
            }
            continue;
        }
        if (token.startsWith('? ')) {
            parsed.notAdded.push(token.slice(2));
            continue;
        }
    }

    return parsed;
}

export function parseNumStatZ(numStatOutput: string): ParsedNumStatSummary {
    const tokens = numStatOutput.split('\0');
    const files: ParsedNumStatFile[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const row = tokens[i];
        if (!row) continue;

        const parts = row.split('\t');
        if (parts.length < 3) continue;

        const insertionsRaw = parts[0] || '0';
        const deletionsRaw = parts[1] || '0';
        let file = parts.slice(2).join('\t');

        if (file.length === 0) {
            const oldPath = tokens[i + 1] || '';
            const newPath = tokens[i + 2] || '';
            file = newPath || oldPath;
            i += 2;
        }

        if (!file) continue;

        const binary = insertionsRaw === '-' || deletionsRaw === '-';
        const insertions = binary ? 0 : Number(insertionsRaw);
        const deletions = binary ? 0 : Number(deletionsRaw);

        files.push({
            file,
            insertions: Number.isFinite(insertions) ? insertions : 0,
            deletions: Number.isFinite(deletions) ? deletions : 0,
            binary,
        });
    }

    return { files };
}
