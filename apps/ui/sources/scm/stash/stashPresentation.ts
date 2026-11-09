import type { ScmStashEntry } from '@happier-dev/protocol/scm';
import type { IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';

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

/**
 * The stash in words (details lab 2, SZ): a stash Happier kept when you switched branches is "Kept
 * on v0.3"; one Happier or someone else made reads as its own message.
 */
export function resolveScmStashTitle(entry: ScmStashEntry): string {
    const branch = entry.branch?.trim();
    if (entry.kind === 'branch' && branch) return t('detailsSurface.history.stashKeptOn', { branch });
    return resolveScmStashPrimaryLabel(entry);
}

/** Where the stash came from, long for the header and short for the switcher rows. */
export function resolveScmStashOrigin(entry: ScmStashEntry, length: 'long' | 'short'): string {
    const branch = entry.branch?.trim();
    if (entry.kind === 'branch') {
        return length === 'long' && branch
            ? t('detailsSurface.history.stashOriginBranch', { branch })
            : t('detailsSurface.history.stashOriginBranchShort');
    }
    if (entry.kind === 'transient') return t('detailsSurface.history.stashOriginTransient');
    return t('detailsSurface.history.stashOriginUnmanaged');
}
