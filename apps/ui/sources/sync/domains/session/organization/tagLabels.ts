import type { SessionOrganizationTag } from '@happier-dev/protocol';

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

export function readSessionOrganizationTagLabel(tag: SessionOrganizationTag): string {
    const display = readPlainDisplayRecord(tag.display);
    const displayLabel = typeof display?.label === 'string' ? display.label.trim() : '';
    if (displayLabel) return displayLabel;
    const tagKey = typeof tag.tagKey === 'string' ? tag.tagKey.trim() : '';
    if (tagKey) return tagKey;
    return String(tag.tagId ?? '').trim();
}

export function buildSessionOrganizationTagLabelById(
    tagsById: Readonly<Record<string, SessionOrganizationTag>>,
): Record<string, string> {
    return Object.fromEntries(
        Object.values(tagsById)
            .filter((tag) => tag.archivedAt == null)
            .map((tag) => [tag.tagId, readSessionOrganizationTagLabel(tag)] as const),
    );
}
