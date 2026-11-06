import { useOptionalHappierUiAccessibility, useOptionalHappierUiPalette } from '../environment/context.js';
import { HappierPageLoadingRows } from '../presentation/layout/PageLoadingRows.js';
import { HappierPageHeaderPlaceholder } from '../presentation/layout/PageHeaderPlaceholder.js';
import { useHappierPageChromeInternal } from '../presentation/layout/pageChrome.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';

export type PageLoadingRowsProps = Readonly<{ testID: string; header?: boolean; loadingLabel?: string }>;

/** Page-shaped loading rows, retaining the header's room when the destination has not drawn it yet. */
export function PageLoadingRows(props: PageLoadingRowsProps) {
  const theme = usePluginTheme();
  const palette = useOptionalHappierUiPalette(theme);
  const translate = usePluginTranslation();
  const chrome = useHappierPageChromeInternal();
  const reducedMotion = useOptionalHappierUiAccessibility()?.reducedMotion;
  const header = props.header ? <HappierPageHeaderPlaceholder testID={`${props.testID}-header`}
    color={palette?.skeleton ?? theme.colors.control} reducedMotion={reducedMotion}
    largeTitle={chrome?.largeTitle} showTitle={!chrome?.showsTitle} columnMaxWidthPx={chrome?.columnMaxWidthPx} /> : null;
  return <HappierPageLoadingRows {...props} header={header} theme={theme} reducedMotion={reducedMotion}
    columnMaxWidthPx={chrome?.columnMaxWidthPx}
    loadingLabel={props.loadingLabel ?? translate('happier.plugin-ui.state.loading', 'Loading')} />;
}
