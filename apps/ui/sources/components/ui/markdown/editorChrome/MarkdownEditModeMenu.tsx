import * as React from 'react';

import { SegmentedTabBar, type SegmentedTab } from '@/components/ui/navigation/SegmentedTabBar';
import { t } from '@/text';
import type { MarkdownEditMode } from '@/components/ui/markdown/editor/markdownEditorTypes';
import type { MarkdownRichIneligibleReason } from '@/components/ui/markdown/editor/core/eligibility/markdownRichEligibility';
import { resolveMarkdownRichDisabledReasonCopy } from '@/components/ui/markdown/editor/core/eligibility/markdownRichDisabledReasonCopy';

/**
 * The Rich / Raw switch every Markdown field shares (Docs, prompts, skills, board notes, `.md` files):
 * two views of one document, so both stay visible and one press switches (the shared segmented view
 * switch, with the Rich / Raw labels Settings → Markdown opens as uses).
 *
 * It shows the EFFECTIVE mode: when Rich is preferred but this document can't open in it, Raw is the
 * chosen segment and Rich stays visible, disabled, announcing why (the shared
 * `resolveMarkdownRichDisabledReasonCopy`, also used by `FilePageHeader`).
 */

export type MarkdownEditModeMenuProps = Readonly<{
    mode: MarkdownEditMode;
    onChange: (mode: MarkdownEditMode) => void;
    richEligible: boolean;
    richDisabledReason?: MarkdownRichIneligibleReason;
    /** Prefix of each segment's test id (`<prefix>:rich`, `<prefix>:raw`). */
    testID?: string;
}>;

export function MarkdownEditModeMenu(props: MarkdownEditModeMenuProps) {
    const richDisabled = props.richEligible !== true;
    const unavailableReason = richDisabled ? resolveMarkdownRichDisabledReasonCopy(props.richDisabledReason) : undefined;
    const tabs = React.useMemo<ReadonlyArray<SegmentedTab<MarkdownEditMode>>>(() => [
        { id: 'rich', label: t('settingsSourceControl.page.editor.rich'), disabled: richDisabled, unavailableReason },
        { id: 'raw', label: t('settingsSourceControl.page.editor.raw') },
    ], [richDisabled, unavailableReason]);
    const effectiveMode: MarkdownEditMode = props.mode === 'rich' && !richDisabled ? 'rich' : 'raw';
    const { onChange } = props;

    return (
        <SegmentedTabBar<MarkdownEditMode>
            tabs={tabs}
            activeTabId={effectiveMode}
            onSelectTab={onChange}
            compact
            segmentSizing="content"
            testIDPrefix={props.testID ?? 'markdown-edit-mode'}
        />
    );
}
