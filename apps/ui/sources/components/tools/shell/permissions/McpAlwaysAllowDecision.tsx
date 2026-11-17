import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ResolvedMcpToolIdentityV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

import { useMcpAlwaysAllow } from './useMcpAlwaysAllow';
import type { McpAlwaysAllowInput } from './useMcpAlwaysAllow';

/**
 * The MCP tool card's Always allow (P8 U8.5, lab xa A): before an answer, the footer draws its own ghost
 * decision through `renderDecision`; once Always ran, one line says whether the per-tool setting was saved,
 * and a failed save retries only the write.
 */
export function McpAlwaysAllowDecision(
  props: Readonly<{
    requestId: string;
    turnId?: string;
    source?: string;
    identity: ResolvedMcpToolIdentityV1;
    scope: ServerAccountScope | null;
    canWriteCatalog: boolean;
    pending: boolean;
    answerForSession(): Promise<void>;
    followUp?: McpAlwaysAllowInput['followUp'];
    choiceId?: string;
    renderDecision(
      decision: Readonly<{ label: string; busy: boolean; onPress: () => void }>,
    ): React.ReactNode;
  }>,
) {
  const always = useMcpAlwaysAllow(props);
  return <McpAlwaysAllowDecisionView {...props} controller={always} />;
}

/** Existing settled line can consume the same controller as an offered-choice button. */
export function McpAlwaysAllowDecisionView(props: Readonly<{
  identity: ResolvedMcpToolIdentityV1;
  pending: boolean;
  controller: ReturnType<typeof useMcpAlwaysAllow>;
  renderDecision(decision: Readonly<{ label: string; busy: boolean; onPress: () => void }>): React.ReactNode;
}>) {
  const { theme } = useUnistyles();
  const always = props.controller;
  const tool = props.identity.toolTitle ?? props.identity.tool;
  // Native submit awaits both the answer and its follow-up. After the tool confirms
  // approval, an in-flight submit is waiting for the catalog save.
  const saving = always.status === 'saving' || (!props.pending && always.status === 'answering');
  if (
    always.status === 'saved' ||
    saving ||
    always.status === 'save_failed'
  ) {
    const failed = always.status === 'save_failed';
    return (
      <View testID="permission-footer.always-allow-settled" style={styles.line}>
        <Icon
          name={failed ? 'warning-circle' : 'check-circle'}
          size={14}
          color={
            failed
              ? theme.colors.state.danger.foreground
              : theme.colors.text.secondary
          }
        />
        <Text variant="meta" style={styles.lineText} numberOfLines={2}>
          <Text variant="meta" emphasis="medium" style={styles.lineStrong}>
            {t('capabilities.session.toolAsk.alwaysAllowed', { tool })}
          </Text>
          {` · ${
            failed
              ? t('capabilities.session.toolAsk.couldntSave')
              : saving
                ? t('capabilities.session.ask.saving')
                : t('capabilities.session.toolAsk.savedIn', {
                    server: props.identity.serverTitle,
                  })
          }`}
        </Text>
        {failed ? (
          <TextLinkButton
            testID="permission-footer.always-allow-retry"
            size="meta"
            tone="strong"
            label={t('capabilities.session.ask.tryAgain')}
            disabled={!always.available}
            onPress={() => {
              void always.retrySave();
            }}
          />
        ) : null}
      </View>
    );
  }
  if (!props.pending || !always.available) return null;
  return (
    <>
      {props.renderDecision({
        label: t('capabilities.session.toolAsk.alwaysAllow'),
        busy: always.status === 'answering',
        onPress: () => {
          void always.allow();
        },
      })}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  line: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    paddingTop: theme.space.s4,
  },
  lineText: {
    flexShrink: 1,
    color: theme.colors.text.secondary,
  },
  lineStrong: {
    color: theme.colors.text.primary,
  },
}));
