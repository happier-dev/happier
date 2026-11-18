import * as React from 'react';
import type { ConnectSheetContentProps } from './ConnectedServiceSetupModal';
import { createConnectSheetChrome } from './connectSheetChrome';
import { resolveConnectSheetBodyScroll } from './connectSheetOpening';

/**
 * The Connect sheet's band: one mark, the title and one line of purpose, in the Connect sheet's one
 * presentation (centred dialog on wide layouts, bottom sheet on a phone). Set when its words change.
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
  }>,
) {
  const { setChrome } = props;
  const bodyScroll = resolveConnectSheetBodyScroll(props.request);
  const leadingRef = React.useRef(heading.leading);
  leadingRef.current = heading.leading;
  React.useLayoutEffect(() => {
    setChrome?.({
      ...createConnectSheetChrome({
        title: heading.title,
        subtitle: heading.subtitle,
        testID: 'connect-sheet',
      }),
      leading: leadingRef.current,
      // Chrome updates merge; null retires a previous method's Machine chip.
      actions: heading.actions ?? null,
      // A sign-in's steps can outgrow the window: the body scrolls under the band (Share's list scrolls itself).
      bodyScroll,
    });
  }, [bodyScroll, heading.actions, heading.leadingKey, heading.subtitle, heading.title, setChrome]);
}

