import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SETTINGS_TEXT_INPUT_METRICS } from '@/components/ui/forms/settingsTextInputMetrics';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';

const styles = StyleSheet.create((theme) => ({
  fieldLabel: {
    color: theme.colors.text.secondary,
    fontSize: 14,
    marginBottom: 8,
  },
  input: {
    backgroundColor: theme.colors.input.background,
    color: theme.colors.input.text,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    ...SETTINGS_TEXT_INPUT_METRICS,
    marginBottom: 12,
  },
}));

export const PromptOrganizationFields = React.memo(function PromptOrganizationFields(props: Readonly<{
  folderName: string;
  onChangeFolderName: (value: string) => void;
  tags: string;
  onChangeTags: (value: string) => void;
  folderTestID: string;
  tagsTestID: string;
  editable: boolean;
}>) {
  const { theme } = useUnistyles();

  return (
    <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
      <Text style={styles.fieldLabel}>{t('promptLibrary.folderLabel')}</Text>
      <TextInput
        testID={props.folderTestID}
        placeholder={t('promptLibrary.folderPlaceholder')}
        placeholderTextColor={theme.colors.input.placeholder}
        value={props.folderName}
        onChangeText={props.onChangeFolderName}
        style={styles.input}
        editable={props.editable}
      />

      <Text style={styles.fieldLabel}>{t('promptLibrary.tagsLabel')}</Text>
      <TextInput
        testID={props.tagsTestID}
        placeholder={t('promptLibrary.tagsPlaceholder')}
        placeholderTextColor={theme.colors.input.placeholder}
        value={props.tags}
        onChangeText={props.onChangeTags}
        style={[styles.input, { marginBottom: 0 }]}
        editable={props.editable}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
});
