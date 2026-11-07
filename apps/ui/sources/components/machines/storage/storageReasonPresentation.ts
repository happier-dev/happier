import type { HappierStorageCategoryIdV1, StorageItemV1, StorageReasonV1 } from '@happier-dev/protocol/storage/storageV1';
import { StorageEvidenceCodeV1Schema, StorageEvidenceV1Schema } from '@happier-dev/protocol/storage/storageV1';

import type { IconName } from '@/components/ui/icons/iconRegistry.generated';
import type { StatusPillVariant } from '@/components/ui/status/StatusPill';
import { t } from '@/text';

/**
 * The one storage kind → words/marks table (plan 40 §7(g) `RS.reason` / `RS.verdict`): each category's
 * name and glyph, and how an item's verdict reads as a chip. Category, reason and evidence codes
 * receive their display labels here. Tiers are R42's: Forbidden (refused, with the reason) and Keep (stays unless a
 * person confirms what is lost) — there is no "Protected".
 */

export type StorageVerdict = StorageItemV1['verdict'];
export type StorageReasonCode = StorageReasonV1['code'];

export const STORAGE_CATEGORY_ICONS: Readonly<Record<HappierStorageCategoryIdV1, IconName>> = {
    worktrees: 'git-branch',
    caches: 'cube',
    modelPacks: 'stack',
    sessionFolders: 'chat',
    logs: 'file-text',
    agentHomes: 'sparkle',
    temporary: 'clock',
    recordings: 'video-camera',
    trash: 'trash',
    ownData: 'hard-drives',
};

export function storageCategoryTitle(categoryId: HappierStorageCategoryIdV1): string {
    return t(`machineStorage.categories.${categoryId}.title`);
}

/** The ring legend's short name ("Caches" beside "Plugin and tool caches"). */
export function storageCategoryShortTitle(categoryId: HappierStorageCategoryIdV1): string {
    return t(`machineStorage.categories.${categoryId}.short`);
}

/** Evidence describes what was checked; native recognizer and manifest identifiers stay private. */
export function storageEvidenceLabel(code: string): string {
    const known = StorageEvidenceCodeV1Schema.safeParse(code);
    if (known.success) return t(`machineStorage.evidence.${known.data}`);
    const evidence = StorageEvidenceV1Schema.safeParse(code);
    if (evidence.success) {
        if (evidence.data.startsWith('recognizer:')) return t('machineStorage.evidence.recognizer');
        if (evidence.data.startsWith('manifest:')) return t('machineStorage.evidence.manifest');
    }
    return t('machineStorage.evidence.unknown');
}

export function storageReasonLabel(reason: StorageReasonV1): string {
    if (reason.code === 'policy_unavailable') return t('machineStorage.reasons.facts_unavailable');
    if (reason.code === 'unsupported') {
        if (reason.detail?.cause === 'main_checkout_lifecycle_unsupported') return t('machineStorage.ownerLimitations.mainCheckout');
        const categoryId = reason.detail?.categoryId;
        if (reason.detail?.cause === 'owner_requires_whole_item'
            && (categoryId === 'sessionFolders' || categoryId === 'modelPacks' || categoryId === 'recordings')) {
            return t('machineStorage.ownerLimitations.wholeItem', { category: storageCategoryTitle(categoryId) });
        }
    }
    return t(`machineStorage.reasons.${reason.code}`);
}

/** Reasons that say the item can be deleted outright (it came from a finished piece of work). */
const CAN_DELETE_REASONS: ReadonlySet<StorageReasonCode> = new Set(['merged_clean', 'branch_gone', 'clean_pushed', 'stopped']);

export type StorageVerdictChip = Readonly<{
    variant: StatusPillVariant;
    chrome: 'pill' | 'plain';
    icon: IconName | null;
    /** "Safe · downloads again", "Keep · in use", "Always kept". */
    label: string;
    /** The label split for the chip: the verdict word leads and its reason reads quieter (lab `reason` / `verdict`). */
    word?: string;
    detail?: string;
}>;

/**
 * An item's verdict as its row's chip: the good news (Safe, Can delete), a caution and a check read quietly
 * (a plain mark and word); a reason to stop (Keep, Forbidden) reads as a bordered pill.
 */
export function describeStorageVerdict(item: Pick<StorageItemV1, 'verdict' | 'reason'>): StorageVerdictChip {
    const reason = storageReasonLabel(item.reason);
    const withReason = (word: string) => ({ label: `${word} · ${reason}`, word, detail: reason });
    switch (item.verdict) {
        case 'safe':
            return { variant: 'success', chrome: 'plain', icon: 'check-circle',
                ...withReason(t(CAN_DELETE_REASONS.has(item.reason.code) ? 'machineStorage.verdicts.canDelete' : 'machineStorage.verdicts.safe')) };
        case 'caution':
            return { variant: 'attention', chrome: 'plain', icon: 'warning-circle', ...withReason(t('machineStorage.verdicts.caution')) };
        case 'keep':
            return item.reason.code === 'always_kept'
                ? { variant: 'neutral', chrome: 'pill', icon: 'lock', label: t('machineStorage.verdicts.alwaysKept') }
                : { variant: 'neutral', chrome: 'pill', icon: 'lock', ...withReason(t('machineStorage.verdicts.keep')) };
        case 'forbidden':
            return { variant: 'neutral', chrome: 'pill', icon: 'octagon-x', ...withReason(t('machineStorage.verdicts.forbidden')) };
        case 'check':
            return { variant: 'neutral', chrome: 'plain', icon: 'question', ...withReason(t('machineStorage.verdicts.check')) };
    }
}

/** Reasons whose confirmation names a specific loss; any other reason reads as its own label. */
const LOSS_CODES = new Set<StorageReasonCode>(['main_checkout', 'in_use', 'changed_files', 'unpushed_commits', 'unsaved_edits', 'open_pr',
    'attachments_go', 'feature_waits', 'not_rebuildable', 'personal_folder', 'agent_home', 'credentials', 'user_protected', 'contains']);

/**
 * What a Keep confirmation (and the review sheet's Keep row) says is lost (R42.1): "3 files with
 * changes are deleted.", "A session is working in it; it stops." — one sentence per reason the
 * machine gave, with its counts.
 */
export function describeStorageLosses(
    reasons: readonly StorageReasonV1[],
    item?: Readonly<{ file?: boolean }>,
): string {
    return reasons.map(reason => {
        const raw = reason.detail?.count;
        const count = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
        // One file in use loses the file; the folder sentence is a folder's.
        if (reason.code === 'in_use' && item?.file === true) return t('machineStorage.loses.in_use_file', { count });
        return LOSS_CODES.has(reason.code)
            ? t(`machineStorage.loses.${reason.code as 'in_use'}`, { count })
            : t('machineStorage.loses.other', { reason: storageReasonLabel(reason) });
    }).join(' ');
}
