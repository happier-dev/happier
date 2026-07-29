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
    return labelParts.length > 0 ? labelParts.join('. ') : undefined;
}
