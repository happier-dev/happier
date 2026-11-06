import type { ReactNode } from 'react';
import { HappierModalCardFooterActions } from '../presentation/interaction/ModalCardFooterActions.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { Button } from './Button.js';
import { Text } from './Text.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';

export type ModalCardFooterActionsProps = Readonly<{
  cancel?: Readonly<{ onPress: () => void; testID?: string; disabled?: boolean }>;
  cancelLabel?: string;
  note?: string | null;
  noteTestID?: string;
  children?: ReactNode;
}>;

/** The shared short-card footer, bound to the containing host sheet and plugin copy. */
export function ModalCardFooterActions(props: ModalCardFooterActionsProps) {
  const theme = usePluginTheme();
  const translate = usePluginTranslation();
  const usePhoneSheet = useOptionalPluginUiPresentationHost()?.useModalCardPhoneSheet ?? useNoPhoneSheet;
  const phoneSheet = usePhoneSheet();
  return <HappierModalCardFooterActions phoneSheet={phoneSheet} gap={theme.spacing.small}
    cancel={props.cancel ? <Button {...props.cancel} variant="plain"
      title={props.cancelLabel ?? translate('happier.plugin-ui.common.cancel', 'Cancel')} /> : null}
    note={props.note ? <Text testID={props.noteTestID} variant="meta" tone="muted" numberOfLines={1}>{props.note}</Text> : null}>
    {props.children}
  </HappierModalCardFooterActions>;
}

function useNoPhoneSheet() { return false; }
