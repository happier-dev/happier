type ParsedSemVer = Readonly<{ core: readonly [number, number, number]; prerelease: readonly string[] }>;

function parseSemVer(raw: string): ParsedSemVer | null {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+.*)?$/.exec(String(raw ?? '').trim());
    if (!match) return null;
    const core = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
    if (!core.every(Number.isSafeInteger)) return null;
    const prerelease = (match[4] ?? '').split('.').filter(Boolean);
    return { core, prerelease };
}

/**
 * SemVer 2.0 precedence for third-party and general versions (an optional leading
 * `v` and build metadata are accepted). Returns null when either side is not SemVer,
 * so callers decide what an unknown version means. Happier's own release-channel
 * ordering (`dev`/`preview` only) stays in `versionComparison.ts`.
 */
export function compareSemVer(a: string, b: string): -1 | 0 | 1 | null {
    const left = parseSemVer(a);
    const right = parseSemVer(b);
    if (!left || !right) return null;
    for (let index = 0; index < 3; index += 1) {
        if (left.core[index] !== right.core[index]) return left.core[index]! > right.core[index]! ? 1 : -1;
    }
    if (left.prerelease.length === 0 || right.prerelease.length === 0) {
        if (left.prerelease.length === right.prerelease.length) return 0;
        return left.prerelease.length === 0 ? 1 : -1; // a release outranks its prereleases
    }
    for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
        const l = left.prerelease[index];
        const r = right.prerelease[index];
        if (l === undefined) return -1;
        if (r === undefined) return 1;
        if (l === r) continue;
        const lNumeric = /^\d+$/.test(l);
        const rNumeric = /^\d+$/.test(r);
        if (lNumeric && rNumeric) {
            // Compare digit strings, so identifiers beyond the safe-integer range stay ordered.
            const ln = l.replace(/^0+(?=\d)/, '');
            const rn = r.replace(/^0+(?=\d)/, '');
            if (ln.length !== rn.length) return ln.length > rn.length ? 1 : -1;
            if (ln !== rn) return ln > rn ? 1 : -1;
            continue;
        }
        if (lNumeric !== rNumeric) return lNumeric ? -1 : 1;
        return l > r ? 1 : -1; // ASCII order, as SemVer specifies
    }
    return 0;
}
