import { Typography } from '@/constants/Typography';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { TranscriptSeparatorRow } from '@/components/sessions/transcript/separators/TranscriptSeparatorRow';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useSession } from '@/sync/domains/state/storage';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

export function ForkDividerRow(props: Readonly<{
  parentSessionId: string;
  childSessionId: string;
  parentCutoffSeqInclusive: number;
  /** Home this transcript is mounted for; the parent lives on the same one. */
  serverId?: string | null;
}>): React.ReactElement {
  const { theme } = useUnistyles();
  const transcriptSource = useSessionTranscriptSource();
  const parentSession = useSession(props.parentSessionId);
  const dividerId = `${props.parentSessionId}:${props.childSessionId}`;
  const parentName = parentSession ? getSessionName(parentSession) : null;
  const title =
    parentName
      ? t('session.forking.dividerTitleWithParent', { parent: parentName })
      : t('session.forking.dividerTitle');

  const parentServerId = props.serverId ?? parentSession?.serverId ?? null;
  const handleOpenParent = React.useCallback(() => {
    const seq = Math.max(0, Math.trunc(props.parentCutoffSeqInclusive));
    transcriptSource.navigate?.(buildScopedSessionRouteHref({
      sessionId: props.parentSessionId,
      serverId: parentServerId,
      query: { jumpSeq: seq },
    }));
  }, [parentServerId, props.parentCutoffSeqInclusive, props.parentSessionId, transcriptSource]);

  return (
    <TranscriptSeparatorRow
      testID={`transcript-fork-divider:${dividerId}`}
      iconName="git-branch"
      title={title}
      subtitle={t('session.forking.dividerSubtitle')}
      rightAccessory={transcriptSource.navigate !== null ? (
        <HappierPressable
          testID={`transcript-fork-divider-open-parent:${dividerId}`}
          onPress={handleOpenParent}
          accessibilityRole="button"
          accessibilityLabel={t('session.forking.openParentA11y')}
          style={({ pressed }) => [styles.openButton, pressed ? { opacity: motionTokens.press.opacity } : null]}
        >
          <Text style={[styles.openButtonText, { color: theme.colors.text.link }]}>{t('session.forking.openParent')}</Text>
        </HappierPressable>
      ) : null}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  openButton: {
    paddingHorizontal: theme.space.s10,
    paddingVertical: theme.space.s6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border.default,
  },
  openButtonText: {
    ...Typography.variant('meta', 'semiBold'),
  },
}));
