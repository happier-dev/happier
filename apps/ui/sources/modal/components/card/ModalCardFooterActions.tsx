import * as React from 'react';
import { HappierModalCardFooterActions } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useSheetDismiss } from './sheetDragDismiss';

/** Core's sheet, localized dismissal and text bindings for the shared short-card footer. */
export function ModalCardFooterActions(props: Readonly<{
  cancel?: Readonly<{ onPress: () => void; testID?: string; disabled?: boolean }>;
  note?: string | null;
  noteTestID?: string;
  children?: React.ReactNode;
}>): React.ReactElement {
  const { theme } = useUnistyles();
  const phoneSheet = useSheetDismiss() !== null;
  return <HappierModalCardFooterActions phoneSheet={phoneSheet} gap={theme.space.s8}
    cancel={props.cancel ? <RoundButton {...props.cancel} display="inverted" title={t('common.cancel')} /> : null}
    note={props.note ? <Text testID={props.noteTestID} variant="meta" numberOfLines={1}
      style={{ color: theme.colors.text.secondary }}>{props.note}</Text> : null}>
    {props.children}
  </HappierModalCardFooterActions>;
}
