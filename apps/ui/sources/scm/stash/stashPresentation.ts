import type { ComponentProps } from 'react';
import type { Octicons } from '@expo/vector-icons';
import type { ScmStashEntry } from '@happier-dev/protocol';

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

export function resolveScmStashIconName(entry: Pick<ScmStashEntry, 'kind'>): ComponentProps<typeof Octicons>['name'] {
    return entry.kind === 'transient' ? 'zap' : 'archive';
}
