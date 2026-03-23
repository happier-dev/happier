function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function visitSegments(value: unknown, segments: readonly string[], index: number, output: unknown[]): void {
    if (index >= segments.length) {
        output.push(value);
        return;
    }

    const segment = segments[index];
    if (!segment) return;

    if (segment === '[]') {
        if (!Array.isArray(value)) return;
        for (const entry of value) {
            visitSegments(entry, segments, index + 1, output);
        }
        return;
    }

    if (!isRecord(value)) return;
    visitSegments(value[segment], segments, index + 1, output);
}

export function getApprovalFieldValues(input: unknown, path: string): readonly unknown[] {
    const segments = path.split('.').map((segment) => segment.trim()).filter(Boolean);
    if (segments.length === 0) return [];

    const output: unknown[] = [];
    visitSegments(input, segments, 0, output);
    return output;
}

export function shouldHideApprovalField(path: string, allPaths: readonly string[]): boolean {
    if (!path) return true;
    if (path.endsWith('.[]')) return true;

    return allPaths.some((candidate) => candidate !== path && (candidate.startsWith(`${path}.`) || candidate.startsWith(`${path}.[`)));
}

export function formatApprovalFieldValues(values: readonly unknown[]): string | null {
    const flattened = values.flatMap((value) => (Array.isArray(value) ? value : [value]));
    const formatted = flattened
        .map((value) => {
            if (typeof value === 'string') return value.trim();
            if (typeof value === 'number' || typeof value === 'boolean') return String(value);
            return '';
        })
        .filter((value) => value.length > 0);

    if (formatted.length === 0) return null;
    return formatted.join(', ');
}
