import type { UiSessionOrganizationTag } from './types';
import { readSessionSpaceMembershipTagDisplayV1 } from '@happier-dev/protocol/sessions/organization/tags';
import { readSessionOrganizationDisplayRecord } from './displayRecord';

export function readSessionOrganizationSpaceMembership(tag: UiSessionOrganizationTag | undefined) {
    return tag ? readSessionSpaceMembershipTagDisplayV1(readSessionOrganizationDisplayRecord(tag.displayState, tag.display)) : null;
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
    const display = readSessionOrganizationDisplayRecord(tag.displayState, tag.display);
    if (readSessionSpaceMembershipTagDisplayV1(display)) return null;
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
