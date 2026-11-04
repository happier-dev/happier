import { useEffect, type ReactElement, type ReactNode } from 'react';

import { HappierPageHeader, HappierPageHeadingBindingContext } from '../presentation/layout/PageHeader.js';
import { useHappierPageChromeInternal } from '../presentation/layout/pageChrome.js';
import { normalizeHappierPageOperations } from '../presentation/layout/pageOperations.js';
import { Icon, type IconName } from './Icon.js';
import { usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';
import { type PluginUiFocusTarget, useCollectionDetailHeadingBindingInternal, usePluginUiFocusTargetBindingInternal } from './Focus.js';
import { usePluginUiSurfaceBridge } from './surfaceBridge.js';
import { PageHeaderMarkSlot } from './pageHeaderMark.js';

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
  /**
   * Moves focus to the title when focused: a page state that replaces the content (an editor opened
   * in place) announces itself by its title. A phone whose navigation shows the title keeps focus there.
   */
  focusTarget?: PluginUiFocusTarget;
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
  const explicitHeadingRef = usePluginUiFocusTargetBindingInternal(props.focusTarget);
  const translate = usePluginTranslation();
  const chrome = useHappierPageChromeInternal();
  const bridgeSurface = usePluginUiSurfaceBridge();
  // A Collection detail retains its own semantic heading and controls in the detail body.
  const hostActions = headingRef === undefined && chrome?.renderNavigationActions !== undefined;
  const actions = hostActions ? chrome.renderNavigationActions?.(props.actions == null ? null : bridgeSurface(
    chrome.showsTitle ? normalizeHappierPageOperations(props.actions, (value, key) => resolveAuthorText(translate, value, key)) : props.actions,
  )) : props.actions;
  const title = resolveAuthorText(translate, props.title, props.titleKey) ?? props.title;
  // A collection detail keeps its heading in the body; any other page names itself in the chrome that
  // hides its title, exactly as a core page header does, so a phone never loses the page's identity.
  const publishTitle = headingRef === undefined ? chrome?.publishTitle : undefined;
  useEffect(() => {
    if (publishTitle === undefined) return;
    publishTitle(title);
    return () => publishTitle(undefined);
  }, [publishTitle, title]);
  const description = resolveAuthorText(translate, props.description, props.descriptionKey);
  const meta = props.meta?.map((fact) => ({
    key: fact.key,
    text: resolveAuthorText(translate, fact.text, fact.textKey) ?? fact.text,
    ...(fact.testID === undefined ? {} : { testID: fact.testID }),
    ...(fact.icon === undefined ? {} : { icon: <Icon name={fact.icon} size="small" tone="secondary" /> }),
  }));
  return (
    <HappierPageHeadingBindingContext.Provider value={headingRef ?? explicitHeadingRef}>
    {hostActions && chrome.showsTitle ? actions : null}
    <HappierPageHeader
      title={title}
      largeTitle={chrome?.largeTitle === true && headingRef === undefined}
      showTitle={headingRef !== undefined || chrome?.showsTitle !== true}
      description={description}
      leading={props.leading ? <PageHeaderMarkSlot>{props.leading}</PageHeaderMarkSlot> : undefined}
      details={props.details}
      detailsPlacement={props.detailsPlacement}
      compactPresentation={props.compactPresentation}
      meta={meta}
      actions={hostActions && chrome.showsTitle ? null : actions}
      renderBack={chrome?.renderBack ?? null}
      {...(chrome?.columnMaxWidthPx === undefined ? {} : { columnMaxWidthPx: chrome.columnMaxWidthPx })}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    />
    </HappierPageHeadingBindingContext.Provider>
  );
}
