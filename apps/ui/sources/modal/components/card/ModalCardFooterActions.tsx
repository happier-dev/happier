import * as React from 'react';
import { HappierModalCardFooterActions } from '@happier-dev/plugin-ui/presentation';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useDeviceType } from '@/utils/platform/responsive';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useSheetDismiss } from './sheetDragDismiss';

/** Core's sheet, localized dismissal and text bindings for the shared short-card footer. */
export function ModalCardFooterActions(props: Readonly<{
  /** The quiet dismissal; `title` names it when it is not Cancel (Back one step in, Close after a run). */
  cancel?: Readonly<{ onPress: () => void; testID?: string; disabled?: boolean; title?: string }>;
  note?: string | null;
  noteTestID?: string;
  /** A quiet way out in the note's place (Deploy an app's "Or ask an agent to set it up"); it wins over `note`. */
  noteAction?: Readonly<{ label: string; onPress: () => void; testID?: string }> | null;
  children?: React.ReactNode;
}>): React.ReactElement {
  const { theme } = useUnistyles();
  const phoneSheet = useSheetDismiss() !== null;
  const phone = useDeviceType() === 'phone';
  const noteAction = props.noteAction ? <TextLinkButton testID={props.noteAction.testID} size="meta" label={props.noteAction.label}
    onPress={props.noteAction.onPress} /> : null;
  // A phone's footer is too narrow for the way out beside two actions (QA 320): it takes its own line above them.
  if (noteAction && phone) return <View style={{ gap: theme.space.s12 }}>
    {noteAction}
    <HappierModalCardFooterActions phoneSheet={phoneSheet} gap={theme.space.s8}
      cancel={props.cancel ? <RoundButton {...props.cancel} display="inverted" title={props.cancel.title ?? t('common.cancel')} /> : null}>
      {props.children}
    </HappierModalCardFooterActions>
  </View>;
  return <HappierModalCardFooterActions phoneSheet={phoneSheet} gap={theme.space.s8}
    cancel={props.cancel ? <RoundButton {...props.cancel} display="inverted" title={props.cancel.title ?? t('common.cancel')} /> : null}
    note={noteAction ?? (props.note ? <Text testID={props.noteTestID} variant="meta" numberOfLines={2}
      style={{ color: theme.colors.text.secondary }}>{props.note}</Text> : null)}>
    {props.children}
  </HappierModalCardFooterActions>;
}
