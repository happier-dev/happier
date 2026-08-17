import type { UiSessionOrganizationTag } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readPlainDisplayRecord(value: unknown): Record<string, unknown> | null {
    if (!isRecord(value) || value.t !== 'plain' || !isRecord(value.v)) return null;
    return value.v;
}

export function normalizeSessionTagLabels(tags: readonly string[] | null | undefined): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const tag of tags ?? []) {
        const normalized = String(tag ?? '').trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}

export function readSessionOrganizationTagLabel(tag: UiSessionOrganizationTag): string | null {
    if (tag.displayState.status !== 'available') return null;
    const display = isRecord(tag.displayState.value)
        ? tag.displayState.value
        : readPlainDisplayRecord(tag.display);
    const displayLabel = typeof display?.label === 'string' ? display.label.trim() : '';
    return displayLabel || null;
}

export function buildSessionOrganizationTagLabelById(
    tagsById: Readonly<Record<string, UiSessionOrganizationTag>>,
): Record<string, string> {
    return Object.fromEntries(
        Object.values(tagsById)
            .filter((tag) => tag.archivedAt == null)
            .map((tag) => [tag.tagId, readSessionOrganizationTagLabel(tag)] as const)
            .filter((entry): entry is readonly [string, string] => entry[1] !== null),
    );
}
