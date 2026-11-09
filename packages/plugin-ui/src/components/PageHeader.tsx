import { useEffect, useMemo, type ReactElement, type ReactNode } from 'react';

import { HappierPageHeader, HappierPageHeadingBindingContext } from '../presentation/layout/PageHeader.js';
import { useHappierPageChromeInternal } from '../presentation/layout/pageChrome.js';
import { normalizeHappierPageOperations } from '../presentation/layout/pageOperations.js';
import { usePluginHostApi } from '../hostApi/context.js';
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
  /** The fact is an address, path or id: mono, one line giving up its middle, whole value named, copied on tap. */
  mono?: boolean;
  testID?: string;
}>;

export type PageHeaderProps = Readonly<{
  /**
   * The page's title. Hidden when the host's navigation already shows it (the purpose line stays), unless the
   * header has a `leading` mark: an entity's mark, title, facts and actions always stay together in the page.
   */
  title: string;
  /** A key from this plugin's declared translation bundle; `title` is its fallback. */
  titleKey?: string;
  /** One sentence saying what the page is for. */
  description?: string;
  descriptionKey?: string;
  /** A leading identity or status mark: the thing the page is about (a `BrandMark`, an `Image`, a status glyph). */
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
   * `wrap` (default): controls on the title row, wrapping beneath when the title needs its readable width.
   * `inline`: controls stay on the title row. `hang`: the mark and controls hang from the title's line, with
   * the description and facts beneath at full width.
   */
  actionsLayout?: 'wrap' | 'inline' | 'hang';
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
  // An entity header (a leading identity or status mark) keeps its mark, title, facts and actions together in
  // the body, as a core entity page does (`alwaysShowTitle`, actions in the page): the mark never stands without
  // its title, and the navigation chrome keeps the destination's own name.
  const entity = props.leading != null;
  // A Collection detail retains its own semantic heading and controls in the detail body. Every other header
  // takes the host's controls (its route controls, its pane's Hide); an entity keeps them, with its own
  // actions, in its row rather than letting the host hoist them into navigation chrome.
  const hostActions = headingRef === undefined && chrome?.renderNavigationActions !== undefined;
  const hoisted = hostActions && !entity && chrome.showsTitle;
  const actions = hostActions ? chrome.renderNavigationActions?.(props.actions == null ? null : bridgeSurface(
    hoisted ? normalizeHappierPageOperations(props.actions, (value, key) => resolveAuthorText(translate, value, key)) : props.actions,
  ), entity ? 'page' : 'navigation') : props.actions;
  const title = resolveAuthorText(translate, props.title, props.titleKey) ?? props.title;
  // A collection detail keeps its heading in the body; any other page names itself in the chrome that
  // hides its title, exactly as a core page header does, so a phone never loses the page's identity.
  const publishTitle = headingRef === undefined && !entity ? chrome?.publishTitle : undefined;
  useEffect(() => {
    if (publishTitle === undefined) return;
    publishTitle(title);
    return () => publishTitle(undefined);
  }, [publishTitle, title]);
  const description = resolveAuthorText(translate, props.description, props.descriptionKey);
  const hostApi = usePluginHostApi();
  const metaIdCopy = useMemo(() => ({
    write: (value: string) => hostApi.writeClipboard(value),
    copiedLabel: translate('happier.plugin-ui.pageHeader.copied', 'Copied'),
  }), [hostApi, translate]);
  const meta = props.meta?.map((fact) => ({
    key: fact.key,
    text: resolveAuthorText(translate, fact.text, fact.textKey) ?? fact.text,
    ...(fact.mono ? { mono: true } : {}),
    ...(fact.testID === undefined ? {} : { testID: fact.testID }),
    ...(fact.icon === undefined ? {} : { icon: <Icon name={fact.icon} size="small" tone="secondary" /> }),
  }));
  return (
    <HappierPageHeadingBindingContext.Provider value={headingRef ?? explicitHeadingRef}>
    {hoisted ? actions : null}
    <HappierPageHeader
      title={title}
      largeTitle={chrome?.largeTitle === true && headingRef === undefined}
      showTitle={headingRef !== undefined || entity || chrome?.showsTitle !== true}
      description={description}
      leading={props.leading ? <PageHeaderMarkSlot>{props.leading}</PageHeaderMarkSlot> : undefined}
      details={props.details}
      detailsPlacement={props.detailsPlacement}
      compactPresentation={props.compactPresentation}
      meta={meta}
      actions={hoisted ? null : actions}
      actionsLayout={props.actionsLayout}
      metaIdCopy={metaIdCopy}
      renderBack={chrome?.renderBack ?? null}
      {...(chrome?.columnMaxWidthPx === undefined ? {} : { columnMaxWidthPx: chrome.columnMaxWidthPx })}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    />
    </HappierPageHeadingBindingContext.Provider>
  );
}
