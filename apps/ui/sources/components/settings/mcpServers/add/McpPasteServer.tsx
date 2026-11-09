import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ValueRefV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';

import { ValueRefRowsEditor } from '@/components/ui/forms/valueRefs/ValueRefRowsEditor';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';

import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import {
  seedMcpPasteRow,
  type McpPasteAnswers,
  type McpPasteAsk,
  type McpPasteServerModel,
} from './mcpAddPaste';

/** One server in the preview: its name and how it runs, the pasted key's fate, and each value still asked. */
export function McpPasteServer(
  props: Readonly<{
    server: McpPasteServerModel;
    answers: McpPasteAnswers;
    secrets: SavedSecret[];
    scope: AccountSettingsScope | null;
    canFlip: boolean;
    /** The caller already names the server above this editor (a Found row), so its own head would repeat it. */
    hideHead?: boolean;
    /** Whether a value still asked is flagged. A caller that asks before an Add attempt keeps the fields neutral. */
    showAttention?: boolean;
    /**
     * One part in its own section (a paste's details: the values under What it needs, the transport under What runs
     * where). Omitted: both, in one block.
     */
    part?: 'values' | 'transport';
    onRow: (inputId: string, value: ValueRefV1) => void;
    onFlip: (name: string, transport: 'http' | 'sse') => void;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { server } = props;
  const remote = server.transport !== 'stdio';
  const values = props.part !== 'transport';
  const transport = props.part !== 'values';
  const rows = (asks: readonly McpPasteAsk[]) =>
    Object.fromEntries(
      asks.map((ask): [string, ValueRefV1] => [
        ask.key,
        props.answers.rows[ask.inputId] ?? seedMcpPasteRow(ask),
      ]),
    );
  const change =
    (asks: readonly McpPasteAsk[]) => (next: Record<string, ValueRefV1>) => {
      for (const ask of asks) {
        const value = next[ask.key];
        if (value && value !== props.answers.rows[ask.inputId])
          props.onRow(ask.inputId, value);
      }
    };
  const attention = (asks: readonly McpPasteAsk[]) =>
    new Set(
      asks
        .filter((ask) => {
          if (props.showAttention === false) return false;
          const value = props.answers.rows[ask.inputId] ?? seedMcpPasteRow(ask);
          return value.t === 'literal'
            ? value.v.trim().length === 0
            : value.t === 'savedSecret' && value.secretId.length === 0;
        })
        .map((ask) => ask.key),
    );
  return (
    <View style={styles.server} testID={props.testID}>
      {props.hideHead ? null : (
        <View style={styles.serverHead}>
          <HappierBrandMark brand={{ displayName: server.name }} pixelSize={20} externallyLabelled />
          <Text variant="body" style={styles.mono} numberOfLines={1}>
            {server.name}
          </Text>
          <Text variant="meta" style={{ color: theme.colors.text.tertiary }}>
            {remote
              ? t('capabilities.mcpAdd.paste.remote')
              : t('capabilities.mcpAdd.paste.local')}
          </Text>
        </View>
      )}
      {remote && transport ? (
        <View style={styles.transport}>
          <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
            {t('capabilities.mcpAdd.paste.transport')}
          </Text>
          {props.canFlip ? (
            <SegmentedTabBar
              tabs={[
                {
                  id: 'http',
                  label: t('capabilities.mcpAdd.paste.http'),
                  testID: `${props.testID}.transport.http`,
                },
                {
                  id: 'sse',
                  label: t('capabilities.mcpAdd.paste.sse'),
                  testID: `${props.testID}.transport.sse`,
                },
              ]}
              activeTabId={server.transport}
              onSelectTab={(id) =>
                props.onFlip(server.name, id as 'http' | 'sse')
              }
              segmentSizing="content"
              accessibilityLabel={t('capabilities.mcpAdd.paste.transport')}
            />
          ) : (
            <Text variant="meta" style={{ color: theme.colors.text.primary }}>
              {server.transport === 'sse'
                ? t('capabilities.mcpAdd.paste.sse')
                : t('capabilities.mcpAdd.paste.http')}
            </Text>
          )}
        </View>
      ) : null}
      {values ? server.literalSecrets.map((secret) => (
        <View key={secret.inputId} style={styles.note}>
          <Icon
            name="lock"
            size={ICON_SIZE.xs}
            color={theme.colors.text.secondary}
          />
          <Text
            variant="meta"
            style={{ color: theme.colors.text.secondary, flexShrink: 1 }}
          >
            {t('capabilities.mcpAdd.paste.keySaved', {
              key: secret.key,
              name: secret.secretName,
            })}
          </Text>
        </View>
      )) : null}
      {values && server.env.length > 0 ? (
        <ValueRefRowsEditor
          kind="env"
          declaredNames
          entries={rows(server.env)}
          onChangeEntries={change(server.env)}
          secrets={props.secrets}
          scope={props.scope}
          testIdPrefix={`${props.testID}.env`}
          attentionKeys={attention(server.env)}
        />
      ) : null}
      {values && server.headers.length > 0 ? (
        <ValueRefRowsEditor
          kind="header"
          declaredNames
          entries={rows(server.headers)}
          onChangeEntries={change(server.headers)}
          secrets={props.secrets}
          scope={props.scope}
          testIdPrefix={`${props.testID}.header`}
          attentionKeys={attention(server.headers)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  server: { gap: theme.space.s8 },
  serverHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    flexWrap: 'wrap',
  },
  note: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  mono: { ...Typography.mono(), flexShrink: 1, color: theme.colors.text.primary },
}));
