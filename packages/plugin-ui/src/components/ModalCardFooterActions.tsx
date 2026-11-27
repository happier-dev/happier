import { useEffect, type ReactNode } from 'react';
import { View } from 'react-native';
import { HappierModalCardFooterActions } from '../presentation/interaction/ModalCardFooterActions.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { Button } from './Button.js';
import { Text } from './Text.js';
import { usePluginUiSurfaceBridge } from './surfaceBridge.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';

export type ModalCardFooterActionsProps = Readonly<{
  cancel?: Readonly<{ onPress: () => void; testID?: string; disabled?: boolean }>;
  cancelLabel?: string;
  /** One line beside the primary: what it waits on, or its refusal (`noteTone: 'danger'`, announced as it appears). */
  note?: string | null;
  noteTone?: 'secondary' | 'danger';
  noteTestID?: string;
  /** Snapshot the form's unsaved input when its containing setup is moved to another Machine. */
  captureDraft?: () => unknown;
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
  const refusal = props.noteTone === 'danger';
  const note = props.note ? <View testID={props.noteTestID} role={refusal ? 'alert' : undefined}
    accessibilityLiveRegion={refusal ? 'assertive' : undefined} aria-live={refusal ? 'assertive' : undefined}>
    <Text variant="meta" tone={refusal ? 'danger' : 'muted'} numberOfLines={2}>{props.note}</Text>
  </View> : null;
  const actions = <HappierModalCardFooterActions phoneSheet={phoneSheet} gap={theme.spacing.small}
    cancel={props.cancel ? <Button {...props.cancel} variant="plain"
      title={props.cancelLabel ?? translate('happier.plugin-ui.common.cancel', 'Cancel')} /> : null}
    note={note}>
    {props.children}
  </HappierModalCardFooterActions>;
  // A phone sheet's actions fill its width, so the note takes its own line above them instead of being dropped.
  const footer = note && phoneSheet ? <View style={{ gap: theme.spacing.small }}>{note}{actions}</View> : actions;
  // The slot holds the latest footer; it renders apart from this form, so republishing never re-renders the form.
  useEffect(() => { footerSlot?.(bridge(footer), props.captureDraft); });
  useEffect(() => () => footerSlot?.(null), [footerSlot]);
  return footerSlot ? null : footer;
}

function useNoPhoneSheet() { return false; }
function useNoFooterSlot(): ((footer: ReactNode | null, captureDraft?: () => unknown) => void) | null { return null; }
