import type { ScmStashEntry } from '@happier-dev/protocol';
import type { IconName } from '@/components/ui/icons/Icon';

function normalizeOptionalText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function resolveScmStashPrimaryLabel(entry: ScmStashEntry): string {
    return normalizeOptionalText(entry.branch)
        ?? normalizeOptionalText(entry.message)
        ?? entry.stashRef;
}

export function resolveScmStashSecondaryLabel(entry: ScmStashEntry): string | null {
    const primary = resolveScmStashPrimaryLabel(entry);
    return primary === entry.stashRef ? null : entry.stashRef;
}

export function resolveScmStashIconName(entry: Pick<ScmStashEntry, 'kind'>): IconName {
    return entry.kind === 'transient' ? 'lightning' : 'archive';
}
