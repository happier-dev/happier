import * as React from 'react';

import { useOptionalHappierUiTypography } from '../environment/context.js';
import { HappierCollectionTitleButton, resolveHappierCollectionTitleStyles, type HappierCollectionTitleButtonProps } from '../presentation/collection/CollectionTitleButton.js';
import { HappierChevron } from '../presentation/collection/DisclosureChevron.js';
import { useHappierPageChromeInternal } from '../presentation/layout/pageChrome.js';
import { resolveHappierPageTextStyle } from '../presentation/layout/pageText.js';
import { HappierText } from '../presentation/text/Text.js';
import { resolveHappierTypeRoleStyle } from '../presentation/text/typeRole.js';
import { CollectionToolbarCompactContext } from './CollectionToolbar.js';
import { usePluginTheme } from './PluginUiProvider.js';

export { CollectionTitleNaturalWidthContext } from '../presentation/collection/CollectionTitleButton.js';
export type CollectionTitleButtonProps = Omit<HappierCollectionTitleButtonProps, 'phone' | 'styles' | 'Text' | 'chevron'>;

/** The Collection's named scope trigger, in the same title anatomy as built-in Space menus. */
export function CollectionTitleButton(props: CollectionTitleButtonProps) {
  const theme = usePluginTheme();
  const typography = useOptionalHappierUiTypography();
  const compact = React.useContext(CollectionToolbarCompactContext);
  const chrome = useHappierPageChromeInternal();
  const styles = resolveHappierCollectionTitleStyles({
    text: theme.colors.text,
    pressed: theme.colors.control,
    label: resolveHappierTypeRoleStyle('heading', theme, typography),
    phoneLabel: resolveHappierPageTextStyle('heroTitle', typography),
  });
  return <HappierCollectionTitleButton {...props} styles={styles} Text={HappierText}
    phone={compact ?? chrome?.largeTitle === true}
    chevron={<HappierChevron direction="down" size={12} color={theme.colors.secondaryText} />} />;
}
