import type { ReactElement, ReactNode } from 'react';

import { HappierPageHeader, HappierPageHeadingBindingContext } from '../presentation/layout/PageHeader.js';
import { useHappierPageChromeInternal } from '../presentation/layout/pageChrome.js';
import { Icon, type IconName } from './Icon.js';
import { usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';
import { useCollectionDetailHeadingBindingInternal } from './Focus.js';
import { usePluginUiSurfaceBridge } from './surfaceBridge.js';

/** One fact on the page header's meta line ("v2.4.0", "Personal Home", "End-to-end encrypted"). */
export type PageHeaderMetaFact = Readonly<{
  key: string;
  text: string;
  /** A key from this plugin's declared translation bundle; `text` is its fallback. */
  textKey?: string;
  /** A small glyph before the text. */
  icon?: IconName;
  testID?: string;
}>;

export type PageHeaderProps = Readonly<{
  /** The page's title. Hidden when the host's navigation already shows it; the purpose line stays. */
  title: string;
  /** A surface's one display greeting, above the regular page-title step. */
  titleProminence?: 'page' | 'hero';
  /** A key from this plugin's declared translation bundle; `title` is its fallback. */
  titleKey?: string;
  /** One sentence saying what the page is for. */
  description?: string;
  descriptionKey?: string;
  /** A leading identity mark: the thing the page is about (a `BrandMark`, an `Image`). */
  leading?: ReactNode;
  /** Identity details or a summary spanning the page's content column. */
  details?: ReactNode;
  /** Defaults to identity; column places the summary below title and actions at full content width. */
  detailsPlacement?: 'identity' | 'column';
  /** Entity identity centered above its controls on a compact measured pane. */
  compactPresentation?: 'centered';
  /** The distinguishing facts of the thing the page is about, on one quiet line. */
  meta?: readonly PageHeaderMetaFact[];
  /** At most one primary page action plus context controls. */
  actions?: ReactNode;
  testID?: string;
}>;

/**
 * The header of a plugin configuration or detail page: title, one-line
 * purpose, an optional identity mark, a meta line and actions — the same
 * owner, layout and type scale as Happier's own settings pages, including the
 * host's back arrow in the gutter beside the title when the page is opened
 * from another page.
 */
export function PageHeader(props: PageHeaderProps): ReactElement {
  const headingRef = useCollectionDetailHeadingBindingInternal();
  const translate = usePluginTranslation();
  const chrome = useHappierPageChromeInternal();
  const bridgeSurface = usePluginUiSurfaceBridge();
  // A Collection detail retains its own semantic heading and controls in the detail body.
  const hostActions = headingRef === undefined && chrome?.showsTitle === true && chrome.renderNavigationActions !== undefined;
  const title = resolveAuthorText(translate, props.title, props.titleKey) ?? props.title;
  const description = resolveAuthorText(translate, props.description, props.descriptionKey);
  const meta = props.meta?.map((fact) => ({
    key: fact.key,
    text: resolveAuthorText(translate, fact.text, fact.textKey) ?? fact.text,
    ...(fact.testID === undefined ? {} : { testID: fact.testID }),
    ...(fact.icon === undefined ? {} : { icon: <Icon name={fact.icon} size="small" tone="secondary" /> }),
  }));
  return (
    <HappierPageHeadingBindingContext.Provider value={headingRef}>
    {hostActions && props.actions ? chrome.renderNavigationActions?.(bridgeSurface(props.actions)) : null}
    <HappierPageHeader
      title={title}
      titleProminence={props.titleProminence}
      showTitle={headingRef !== undefined || chrome?.showsTitle !== true}
      description={description}
      leading={props.leading}
      details={props.details}
      detailsPlacement={props.detailsPlacement}
      compactPresentation={props.compactPresentation}
      meta={meta}
      actions={hostActions ? null : props.actions}
      renderBack={chrome?.renderBack ?? null}
      {...(chrome?.columnMaxWidthPx === undefined ? {} : { columnMaxWidthPx: chrome.columnMaxWidthPx })}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    />
    </HappierPageHeadingBindingContext.Provider>
  );
}
