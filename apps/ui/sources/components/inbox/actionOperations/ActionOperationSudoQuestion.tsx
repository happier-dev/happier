import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import type { QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { t } from '@/text';

import { useActionOperationSudoPassword } from './useActionOperationSudoPassword';

function describeSudoFailure(code: string | null): string | null {
  switch (code) {
    case null:
    case 'cancelled':
      return null;
    case 'permission_denied':
      return t('inbox.actionOperations.sudo.refused');
    case 'no_prompt':
    case 'action_operation_unavailable':
      return t('inbox.actionOperations.sudo.expired');
    default:
      return t('inbox.actionOperations.sudo.failed');
  }
}

/**
 * The Machine's administrator-password question, asked where the operation is shown. The parent
 * mounts it per question (keyed by its task), so a new question always starts empty. The typed
 * password stays in this leaf's draft only until Send, which clears it before the reply returns.
 */
export const ActionOperationSudoQuestion = React.memo(
  function ActionOperationSudoQuestion(
    props: Readonly<{ operation: QualifiedActionOperation }>,
  ) {
    const { theme } = useUnistyles();
    const question = useActionOperationSudoPassword(props.operation);
    const [draft, setDraft] = React.useState('');
    const [sent, setSent] = React.useState(false);
    if (!question.target) return null;
    const username = question.target.prompt.adminUsername;
    const error = describeSudoFailure(question.failureCode);
    const send = () => {
      if (question.pending || draft.length === 0) return;
      const password = draft;
      setDraft('');
      void question.respond(password).then((ok) => {
        if (ok) setSent(true);
      });
    };
    return (
      <ItemGroup
        testID="action-operation-sudo"
        title={t('inbox.actionOperations.sudo.title')}
      >
          {sent ? (
            <Item
              testID="action-operation-sudo-sent"
              mode="info"
              icon={
                <Icon
                  name="check-circle"
                  size={ICON_SIZE.md}
                  color={theme.colors.text.secondary}
                />
              }
              title={t('inbox.actionOperations.sudo.sentTitle')}
              subtitle={t('inbox.actionOperations.sudo.sentHint')}
              subtitleLines={0}
            />
          ) : (
            <Item
              mode="info"
              showChevron={false}
              accessoryLayout="stacked"
              title={t('inbox.actionOperations.sudo.passwordFor', { username })}
              subtitle={t('inbox.actionOperations.sudo.description')}
              subtitleLines={0}
              rightElement={
                <FieldTextInput
                  testID="action-operation-sudo-password"
                  value={draft}
                  onChangeText={setDraft}
                  accessibilityLabel={t(
                    'inbox.actionOperations.sudo.passwordFor',
                    { username },
                  )}
                  error={error}
                  secureTextEntry
                  autoFocus
                  autoCapitalize="none"
                  textContentType={
                    Platform.OS === 'ios' ? 'password' : undefined
                  }
                  returnKeyType="send"
                  onSubmitEditing={send}
                  editable={!question.pending}
                />
              }
            />
          )}
          {sent ? null : (
            <SectionContentRow continuesRow>
              <View style={styles.actions}>
                <RoundButton
                  title={t('inbox.actionOperations.sudo.send')}
                  testID="action-operation-sudo-send"
                  loading={question.pending}
                  disabled={question.pending || draft.length === 0}
                  onPress={send}
                />
              </View>
            </SectionContentRow>
          )}
      </ItemGroup>
    );
  },
);

const styles = StyleSheet.create(() => ({
  actions: { flexDirection: 'row', justifyContent: 'flex-end' },
}));
