import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Text } from '@/components/ui/text/Text';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';

import { McpPasteServer } from '../add/McpPasteServer';
import type { useMcpFoundAdoption } from './useMcpFoundAdoption';

/**
 * What a finding needs before it becomes a server (P7 T6): every environment variable and header the
 * config names is asked with an explicit choice (Saved Secret, text, or a variable from the machine),
 * in the same value rows the Add modal uses. It opens under the finding it belongs to; Add stays off
 * until every value has a choice, and a refusal keeps the choices for Retry.
 */
export const McpFoundAdoptionPanel = React.memo(function McpFoundAdoptionPanel(
  props: Readonly<{
    testID: string;
    adoption: ReturnType<typeof useMcpFoundAdoption>;
    /** The selected Home's Saved Secrets, so a key is chosen where the server will be saved. */
    secrets: SavedSecret[];
    scope: AccountSettingsScope | null;
  }>,
) {
  const { theme } = useUnistyles();
  const { adoption } = props;
  const { model, answers, state } = adoption;
  // Values stay neutral while they are being asked; the ones still open are flagged once Add is pressed without them.
  const [attempted, setAttempted] = React.useState(false);
  if (!model) return null;
  // A finding that names no value is added at once: there is nothing to ask, so nothing opens unless the add fails.
  const asksValues =
    model.fields.length > 0 ||
    model.servers.some(
      (server) => server.env.length + server.headers.length + server.literalSecrets.length > 0,
    );
  if (!asksValues && state.status !== 'failed') return null;
  const submitting = state.status === 'submitting';
  const failed = state.status === 'failed';
  const note = failed
    ? t('capabilities.mcpAdd.paste.addFailed')
    : model.errors.length > 0
      ? t('capabilities.mcpAdd.paste.unreadable')
      : adoption.openValues > 0
        ? t('capabilities.mcpAdd.paste.stillNeeded', {
            count: adoption.openValues,
          })
        : null;
  const hint =
    adoption.openValues > 0
      ? t('capabilities.mcpAdd.paste.stillNeeded', {
          count: adoption.openValues,
        })
      : undefined;
  return (
    <View style={styles.panel} testID={props.testID}>
      <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
        {t('capabilities.mcpAdd.paste.foundBody')}
      </Text>
      {model.servers.map((server) => (
        <McpPasteServer
          key={server.name}
          server={server}
          answers={answers}
          secrets={props.secrets}
          scope={props.scope}
          canFlip={false}
          hideHead
          showAttention={attempted}
          onRow={adoption.setValue}
          onFlip={() => undefined}
          testID={`${props.testID}.server.${server.name}`}
        />
      ))}
      {model.fields.length > 0 ? (
        <View style={styles.fields}>
          <Text variant="label" style={{ color: theme.colors.text.primary }}>
            {t('capabilities.mcpAdd.paste.otherValues')}
          </Text>
          {model.fields.map((ask) => (
            <View key={ask.inputId} style={styles.field}>
              <Text
                variant="meta"
                style={{ color: theme.colors.text.secondary }}
              >
                {ask.description ? `${ask.key} · ${ask.description}` : ask.key}
              </Text>
              <FieldTextInput
                testID={`${props.testID}.field.${ask.inputId}`}
                value={answers.fields[ask.inputId] ?? ''}
                onChangeText={(next) => adoption.setField(ask.inputId, next)}
                accessibilityLabel={ask.key}
                secureTextEntry={ask.secret}
                invalid={
                  attempted &&
                  (answers.fields[ask.inputId] ?? '').trim().length === 0
                }
                monospace
              />
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.footer}>
        <Text
          variant="meta"
          style={[
            styles.note,
            {
              color: failed
                ? theme.colors.status.error
                : theme.colors.text.secondary,
            },
          ]}
          testID={`${props.testID}.note`}
        >
          {note ?? ''}
        </Text>
        <View style={styles.actions}>
          <RoundButton
            testID={`${props.testID}.cancel`}
            size="small"
            display="secondary"
            title={t('common.cancel')}
            disabled={submitting}
            onPress={adoption.cancel}
          />
          <RoundButton
            testID={`${props.testID}.add`}
            size="small"
            title={
              failed
                ? t('capabilities.mcpAdd.detail.retry')
                : t('capabilities.mcpAdd.paste.addN', { count: 1 })
            }
            loading={submitting}
            disabled={!adoption.canBegin || model.errors.length > 0}
            {...(hint ? { accessibilityHint: hint } : {})}
            onPress={() => {
              if (adoption.openValues > 0) setAttempted(true);
              else void adoption.submit();
            }}
          />
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  panel: {
    gap: theme.space.s12,
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s4,
    paddingBottom: theme.space.s16,
  },
  fields: { gap: theme.space.s8 },
  field: { gap: theme.space.s4 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s12,
    flexWrap: 'wrap',
  },
  note: { flexShrink: 1, minHeight: 18 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
}));
