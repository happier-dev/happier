import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

const stylesheet = StyleSheet.create(theme => ({
  error: { ...Typography.variant('meta'), color: theme.colors.state.danger.textForeground },
}));

/** State-free shared row; personal Follow owns arming and delivery. */
export function WorkNotificationOperationView(props: Readonly<{
  sourceId: string;
  testIDPrefix: string;
  title: string;
  armed: boolean;
  pending: boolean;
  disabled: boolean;
  error: boolean;
  onChange: (value: boolean) => Promise<void>;
}>) {
  const id = (suffix: string) => `${props.testIDPrefix}${suffix}:${props.sourceId}`;
  return (
    <View>
      <Item
        testID={id(props.armed ? '-cancel' : '')}
        title={props.title}
        // A failed change is said on the row's own line, on its text column, never beside the row.
        subtitle={props.error ? (
          <Text testID={id('-error')} accessibilityLiveRegion="polite" style={stylesheet.error}>
            {t('sessionWork.notify.failed')}
          </Text>
        ) : undefined}
        density="compact"
        disabled={props.disabled}
        loading={props.pending}
        showChevron={false}
        onPress={() => { void props.onChange(!props.armed); }}
        rightElementOutsidePressable
        rightElement={(
          <Switch
            testID={id('-switch')}
            accessibilityLabel={props.title}
            value={props.armed}
            disabled={props.disabled}
            onValueChange={value => { void props.onChange(value); }}
          />
        )}
      />
    </View>
  );
}
