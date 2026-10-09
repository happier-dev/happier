import type { ReactElement, ReactNode } from 'react';
import { View } from 'react-native';

import {
  useOptionalPluginUiPresentationHost,
  type PluginUiDetailsPaneHost,
} from '../presentationHost/context.js';
import { HappierPageHeader } from '../presentation/layout/PageHeader.js';
import { IconButton } from './Button.js';
import { Icon } from './Icon.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { usePluginUiSurfaceBridge } from './surfaceBridge.js';
import { useCollectionDetailHeadingBindingInternal } from './Focus.js';

export type DetailsPaneProps = Readonly<{
  /** Whether the detail is open. The plugin keeps the open item in its own location (`replacePageLocation`). */
  open: boolean;
  /** The pane's title in its header band. Omit it when the detail draws its own heading and close control. */
  title?: string;
  subtitle?: string;
  /** The item's identity mark beside the title (a kind glyph). It stands on its own: no tile, border or fill. */
  leading?: ReactNode;
  /** A mark leading the subtitle line (the source's brand mark). */
  subtitleLeading?: ReactNode;
  /** The detail's actions, beside the pane's close button (icon buttons). */
  actions?: ReactNode;
  /** The pane asks to close: its close or back control, Escape, or a tap outside an overlay pane. */
  onClose: () => void;
  children?: ReactNode;
  testID?: string;
}>;

const NO_PANE_HOST = null;

/**
 * Whether the page's app details pane sits beside this surface right now. `false` where the host
 * placed the surface in no pane host, on phones and with side panes turned off.
 */
/** @internal The Collection reads it to choose its container. */
export function useDetailsPaneAvailable(): boolean {
  const binding = useOptionalPluginUiPresentationHost()?.detailsPane ?? NO_PANE_HOST;
  return useBindingAvailable(binding);
}

/** @internal Whether the host placed this surface in a pane host at all, its pane beside the page or not. */
export function useDetailsPaneHostInstalled(): boolean {
  return (useOptionalPluginUiPresentationHost()?.detailsPane ?? NO_PANE_HOST) !== null;
}

/**
 * The host binding is installed once per mount, so the same hook runs on every render of a given
 * surface; where there is none a constant stands in.
 */
function useBindingAvailable(binding: PluginUiDetailsPaneHost | null): boolean {
  const useAvailable = binding?.useAvailable ?? useNoPane;
  return useAvailable();
}

function useNoPane(): boolean {
  return false;
}

/**
 * An item opened beside the page, in the page's **app details pane** — the same pane every Happier
 * page opens details in: one band with the title, the actions and a close button, the width the user
 * last gave it, docked beside the page or over it when the page would get too narrow, Escape and
 * focus return. Where there is no pane beside the page (phones, side panes turned off, a surface the
 * host placed in no pane host) the detail is pushed inside the page with a way back.
 *
 * The children render where the pane is, not where `DetailsPane` is declared: they keep this plugin's
 * context (theme, translation, the surface context, the Host API and every public component), and
 * they read the page's state through the props and closures you pass them. React context that your
 * own components provide above `DetailsPane` does not reach them; provide it inside the children.
 *
 * ```tsx
 * <DetailsPane open={entry !== null} title={entry?.title} actions={<OpenOnGitHub />}
 *   onClose={() => host.replacePageLocation('', { backLocation: '' })}>
 *   <EntryDetail entry={entry} />
 * </DetailsPane>
 * ```
 */
export function DetailsPane(props: DetailsPaneProps): ReactElement | null {
  const headingRef = useCollectionDetailHeadingBindingInternal();
  const binding = useOptionalPluginUiPresentationHost()?.detailsPane ?? NO_PANE_HOST;
  const available = useBindingAvailable(binding);
  const bridge = usePluginUiSurfaceBridge();
  if (binding !== null && available) {
    return (
      <>
        {binding.renderDetailsPane({
          open: props.open,
          ...(headingRef === undefined ? {} : { headingRef }),
          ...(props.title === undefined ? {} : { title: props.title }),
          ...(props.subtitle === undefined ? {} : { subtitle: props.subtitle }),
          ...(props.leading === undefined ? {} : { leading: bridge(props.leading) }),
          ...(props.subtitleLeading === undefined ? {} : { subtitleLeading: bridge(props.subtitleLeading) }),
          ...(props.actions === undefined ? {} : { actions: bridge(props.actions) }),
          onClose: props.onClose,
          children: bridge(props.children),
          ...(props.testID === undefined ? {} : { testID: props.testID }),
        })}
      </>
    );
  }
  if (!props.open) return null;
  return <PushedDetail {...props} />;
}

/** The detail as the page: over the page's content, a back control, the title and the actions. */
function PushedDetail(props: DetailsPaneProps): ReactElement {
  const theme = usePluginTheme();
  const translate = usePluginTranslation();
  return (
    <View
      testID={props.testID}
      role="dialog"
      aria-modal={true}
      accessibilityViewIsModal
      accessibilityLabel={props.title ?? translate('happier.plugin-ui.detailsPane.back', 'Back')}
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        backgroundColor: theme.colors.canvas,
      }}
    >
      <HappierPageHeader
        title={props.title ?? ''}
        // A line led by a mark is the item's facts line (the header's meta), its mark before the words.
        {...(props.subtitleLeading === undefined || props.subtitle === undefined
          ? { description: props.subtitle }
          : { meta: [{ key: 'subtitle', text: props.subtitle, icon: props.subtitleLeading }] })}
        {...(props.leading === undefined ? {} : { leading: props.leading })}
        actions={props.actions}
        renderBack={(style) => <View style={style}><IconButton
          icon={<Icon name="back" tone="secondary" />}
          accessibilityLabel={translate('happier.plugin-ui.detailsPane.back', 'Back')}
          onPress={props.onClose}
          {...(props.testID === undefined ? {} : { testID: `${props.testID}:back` })}
        /></View>}
      />
      <View style={{ flex: 1, minHeight: 0 }}>{props.children}</View>
    </View>
  );
}
