import * as React from 'react';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { t } from '@/text';
import type { LocalFileReviewControl } from '@/components/workspaces/scm/review/hunkReview/useHunkReviewController';

/** A file on the source it came from (a pull request's file on GitHub), with that row's label. */
export type DiffFileSourceLink = Readonly<{ label: string; url: string }>;

/** File actions shared by review, commit and stash headers; local Viewed consumes the review owner's control. */
export function DiffFileActionsMenu(props: Readonly<{
    filePath: string;
    onOpenFile?: () => void;
    sourceLink?: DiffFileSourceLink | null;
    fileReview?: LocalFileReviewControl | null;
}>) {
    const sourceLink = props.sourceLink ?? null;
    const copy = useClipboardWrite();
    return <ItemRowActions
        title={props.filePath}
        overflowTriggerTestID={`diff-file-menu:${props.filePath}`}
        compactThreshold={Number.POSITIVE_INFINITY}
        compactActionIds={[]}
        actionControlSizePx={24}
        iconSize={14}
        gap={0}
        actions={[
            ...(props.fileReview ? [{ id: 'diff-file-viewed', title: t('hunkReview.viewed'), icon: 'check-square' as const,
                selected: props.fileReview.reviewed, disabled: props.fileReview.unavailableReason !== null,
                subtitle: props.fileReview.unavailableReason ?? undefined,
                onPress: () => props.fileReview?.setReviewed(!props.fileReview.reviewed) }] : []),
            ...(props.onOpenFile ? [{ id: 'diff-file-open', title: t('common.open'), icon: 'arrow-square-out' as const, onPress: props.onOpenFile }] : []),
            ...(sourceLink ? [{ id: 'diff-file-open-source', title: sourceLink.label, icon: 'arrow-square-out' as const,
                // The Action executor loads on the press, not with every diff header.
                onPress: () => { void import('@/utils/url/requestOpenExternalUrl').then(({ requestOpenExternalUrl }) => requestOpenExternalUrl(sourceLink.url)); } }] : []),
            { id: 'diff-file-copy-path', title: t('files.repositoryTree.actions.copyPath'), icon: 'copy', onPress: () => { void copy(props.filePath); } },
        ]}
    />;
}
