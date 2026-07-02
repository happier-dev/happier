/**
 * Shared mapping from the rich-eligibility reason union to the i18n copy under
 * `settingsSourceControl.markdownEditMode.disabledReason.*`, surfaced as the
 * disabled "Rich" option's subtitle in any Raw/Rich edit-mode menu.
 *
 * Extracted (Lane A) so BOTH the file-pane toolbar (`FileActionToolbar`) and the
 * generic `MarkdownEditModeMenu` resolve the disabled-reason copy identically —
 * there is no second copy of this switch to drift.
 *
 * PURE — no `@tiptap/*` import (R18); safe in the native graph.
 */

import { t } from '@/text';
import type { MarkdownRichIneligibleReason } from './markdownRichEligibility';

export function resolveMarkdownRichDisabledReasonCopy(
    reason: MarkdownRichIneligibleReason | undefined,
): string | undefined {
    switch (reason) {
        case 'mdx':
            return t('settingsSourceControl.markdownEditMode.disabledReason.mdx');
        case 'too-large':
            return t('settingsSourceControl.markdownEditMode.disabledReason.tooLarge');
        case 'reference-links':
            return t('settingsSourceControl.markdownEditMode.disabledReason.referenceLinks');
        case 'footnotes':
            return t('settingsSourceControl.markdownEditMode.disabledReason.footnotes');
        case 'html-or-jsx':
            return t('settingsSourceControl.markdownEditMode.disabledReason.htmlOrJsx');
        default:
            return undefined;
    }
}
