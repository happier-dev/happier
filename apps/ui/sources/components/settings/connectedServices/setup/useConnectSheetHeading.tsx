import * as React from 'react';
import { createAnchoredSheetChrome } from '@/modal/components/card/anchoredSheetChrome';
import type { ConnectSheetContentProps } from './ConnectedServiceSetupModal';

/**
 * The Connect sheet's band: one mark, the title and one line of purpose, in the shared anchored chrome
 * (popover at the button on wide layouts, bottom sheet on a phone). Set when its words change.
 */
export function useConnectSheetHeading(
  props: ConnectSheetContentProps,
  heading: Readonly<{
    title: string;
    subtitle: string;
    leading: React.ReactNode;
    leadingKey: string;
    /** The band's end: the machine a sign-in runs on, only when the chosen method needs one. */
    actions?: React.ReactNode;
    /** `none`: the body keeps its controls in place and scrolls its own list (the key sheet). */
    bodyScroll?: 'auto' | 'none';
  }>,
) {
  const { setChrome } = props;
  const bodyScroll = heading.bodyScroll ?? 'auto';
  const anchor = props.request.anchor;
  const leadingRef = React.useRef(heading.leading);
  leadingRef.current = heading.leading;
  React.useLayoutEffect(() => {
    setChrome?.({
      ...createAnchoredSheetChrome({
        title: heading.title,
        subtitle: heading.subtitle,
        testID: 'connect-sheet',
        anchor,
      }),
      leading: leadingRef.current,
      ...(heading.actions ? { actions: heading.actions } : {}),
      // A sign-in's steps can outgrow the window: the body scrolls under the band (Share's list scrolls itself).
      bodyScroll,
    });
  }, [anchor, bodyScroll, heading.actions, heading.leadingKey, heading.subtitle, heading.title, setChrome]);
}
