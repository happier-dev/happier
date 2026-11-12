import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/** Existing Environment values are replaced only when the person selects each named key. */
export function DeploymentBindingReplacementChoices(props: Readonly<{
  names: readonly string[];
  selected: readonly string[];
  onChange: (selected: readonly string[]) => void;
  testID: string;
  disabled?: boolean;
}>) {
  if (!props.names.length) return null;
  return <ItemGroup title={t('capabilities.store.appPage.choices.replaceTitle')}
    description={t('capabilities.store.appPage.choices.replaceBody')}>
    {props.names.map(name => <Item key={name} title={name} titleStyle={styles.key} showChevron={false}
      rightElement={<Switch testID={`${props.testID}.replace.${name}`} value={props.selected.includes(name)} disabled={props.disabled}
        onValueChange={replace => props.onChange(replace ? [...props.selected, name] : props.selected.filter(entry => entry !== name))} />} />)}
  </ItemGroup>;
}
const styles = StyleSheet.create(() => ({ key: Typography.mono() }));
