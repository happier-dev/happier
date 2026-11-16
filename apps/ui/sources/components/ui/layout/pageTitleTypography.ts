import { HAPPIER_PAGE_TEXT, useHappierTextPresentation } from '@happier-dev/plugin-ui/presentation';
import { Typography } from '@/constants/Typography';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';

/**
 * The page/screen title step: the large, tightly tracked title a full page
 * opens with. `PageHeader` renders it, and plugin surfaces receive it as their
 * `heading` type role (`pluginUiThemeProjection.ts`), so a plugin page heading
 * and a host page title are one size.
 */
// The return type is inferred on purpose: an explicit `TextStyle` widens the object, and spreading it
// into a unistyles `StyleSheet.create` callback then fails to type-check.
export function pageTitleTypography() {
    return {
        ...Typography.default('bold'),
        // The step's metrics are the shared page type scale (`HAPPIER_PAGE_TEXT`), which a plugin
        // page title draws with too.
        fontSize: HAPPIER_PAGE_TEXT.pageTitle.fontSize,
        lineHeight: HAPPIER_PAGE_TEXT.pageTitle.lineHeight,
        letterSpacing: HAPPIER_PAGE_TEXT.pageTitle.letterSpacing ?? 0,
    };
}

/** The most lines a page title takes before it ends in an ellipsis, at the default text size. */
const PAGE_TITLE_MAX_LINES = 2;

/**
 * How many lines a page or entity title may wrap to before it ends in an ellipsis: two at the default text size, so a
 * long name wraps rather than clipping on one line. A data-named title keeps as much of its name at a larger text size
 * as at the default. Each line holds 1/s of the characters at text scale s, and the title's own column narrows too (the
 * header's actions grow by s beside it), so the stop grows with s²: at 200% a title that read whole on two lines still
 * reads whole (QA-DESIGN-R2 M2). `PageHeader` and a phone's large pane header both read it (owner round 2 item 4).
 */
export function usePageTitleMaxLines(): number {
    const { metricScale } = useHappierTextPresentation({ textScale: useLocalSetting('uiFontScale') });
    return Math.max(PAGE_TITLE_MAX_LINES, Math.ceil(PAGE_TITLE_MAX_LINES * metricScale * metricScale));
}
