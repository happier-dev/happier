import { useEffect, type ReactNode } from 'react';
import { HappierModalCardFooterActions } from '../presentation/interaction/ModalCardFooterActions.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { Button } from './Button.js';
import { Text } from './Text.js';
import { usePluginUiSurfaceBridge } from './surfaceBridge.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';

export type ModalCardFooterActionsProps = Readonly<{
  cancel?: Readonly<{ onPress: () => void; testID?: string; disabled?: boolean }>;
  cancelLabel?: string;
  note?: string | null;
  noteTestID?: string;
  children?: ReactNode;
}>;

/**
 * The shared short-card footer, bound to the containing host sheet and plugin copy. Inside a host card that offers its
 * footer, the actions stand there, pinned beside the card's edge; elsewhere they end the body.
 */
export function ModalCardFooterActions(props: ModalCardFooterActionsProps) {
  const theme = usePluginTheme();
  const translate = usePluginTranslation();
  const host = useOptionalPluginUiPresentationHost();
  const usePhoneSheet = host?.useModalCardPhoneSheet ?? useNoPhoneSheet;
  const phoneSheet = usePhoneSheet();
  const useFooterSlot = host?.useModalCardFooterSlot ?? useNoFooterSlot;
  const footerSlot = useFooterSlot();
  // The host card's footer is outside this surface's tree: the surface's own context goes along with the actions.
  const bridge = usePluginUiSurfaceBridge();
  const footer = <HappierModalCardFooterActions phoneSheet={phoneSheet} gap={theme.spacing.small}
    cancel={props.cancel ? <Button {...props.cancel} variant="plain"
      title={props.cancelLabel ?? translate('happier.plugin-ui.common.cancel', 'Cancel')} /> : null}
    note={props.note ? <Text testID={props.noteTestID} variant="meta" tone="muted" numberOfLines={1}>{props.note}</Text> : null}>
    {props.children}
  </HappierModalCardFooterActions>;
  // The slot holds the latest footer; it renders apart from this form, so republishing never re-renders the form.
  useEffect(() => { footerSlot?.(bridge(footer)); });
  useEffect(() => () => footerSlot?.(null), [footerSlot]);
  return footerSlot ? null : footer;
}

function useNoPhoneSheet() { return false; }
function useNoFooterSlot(): ((footer: ReactNode | null) => void) | null { return null; }
