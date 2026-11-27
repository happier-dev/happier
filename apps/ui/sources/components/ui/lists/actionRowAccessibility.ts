import type { ReactNode } from 'react';

function normalizePrimitiveLabelPart(value: ReactNode): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const trimmed = String(value).trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function buildActionRowAccessibilityLabel(
    parts: ReadonlyArray<ReactNode | null | undefined>,
): string | undefined {
    const labelParts: string[] = [];
    for (const part of parts) {
        const label = normalizePrimitiveLabelPart(part);
        if (label) labelParts.push(label);
    }
    if (labelParts.length === 0) return undefined;
    // Each part reads as its own sentence; a part that already ends one (a description's own stop) is not stopped twice.
    return labelParts.reduce((label, part) => `${label}${/[.!?…。]$/.test(label) ? ' ' : '. '}${part}`);
}
