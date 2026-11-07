import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolCall } from '@happier-dev/session-core/messages';
import type { BotTemplateDraftResultV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { HappierWorkUpdateCard } from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import {
  renderWorkUpdateCardSurface,
  useWorkTheme,
  WORK_HOST,
} from '@/components/work/map/WorkMapView';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { Modal } from '@/modal';
import { t } from '@/text';
import { readBotTemplateDraftResult } from './readBotTemplateDraftResult';
import { usePresentBotTemplate } from './openBotTemplate';

/** The face the Work update card's mark slot carries for Bot results (matches the saved-skill card). */
const DRAFT_CARD_FACE_SIZE = 24;

export function BotTemplateDraftCard(props: Readonly<{ tool: ToolCall }>) {
  const result = readBotTemplateDraftResult(props.tool);
  return result ? <DraftOutcome result={result} /> : null;
}

function DraftOutcome({
  result,
}: Readonly<{ result: BotTemplateDraftResultV1 }>) {
  const theme = useWorkTheme();
  const present = usePresentBotTemplate(
    result.sourceSessionRef.sessionId,
    result.sourceSessionRef.serverId,
  );
  const executorOptions = React.useMemo(
    () => ({ openBotTemplate: present }),
    [present],
  );
  const { execute } = useMountedActionExecution(
    result.sourceSessionRef.serverId,
    { executorOptions },
  );
  const review = async () => {
    const opened = await execute('template.open', {
      draftArtifactId: result.draftArtifactId,
      sourceSessionRef: result.sourceSessionRef,
      presentation: 'pane',
    });
    if (!opened.ok)
      Modal.alert(t('common.error'), t('botTemplates.unavailable'));
  };
  const { identity, includes, leftOut } = result.summary;
  const needs =
    includes.software + includes.connectedAccounts + includes.mcpServers;
  return (
    <HappierWorkUpdateCard
      testID="bot-template-draft-card"
      slotTestIDPrefix="bot-template-draft"
      tone="neutral"
      theme={theme}
      host={WORK_HOST}
      renderSurface={renderWorkUpdateCardSurface}
      mark={
        <SessionBotFace
          facts={{ seed: identity.name, face: identity.face ?? null }}
          size={DRAFT_CARD_FACE_SIZE}
          motion={false}
        />
      }
      title={identity.name}
      meta={t('botTemplates.draftKind')}
      leadingAction={
        <Text variant="meta" style={styles.quiet}>
          {t('botTemplates.nothingShared')}
        </Text>
      }
      actions={
        <RoundButton
          testID="bot-template-draft-review"
          size="small"
          title={t('botTemplates.reviewShort')}
          onPress={() => {
            void review();
          }}
        />
      }
    >
      <View style={styles.columns}>
        <Column
          title={t('botTemplates.whatPeopleGet')}
          lines={[
            t('botTemplates.getsInstructions'),
            includes.memoryRules > 0
              ? t('botTemplates.getsMemory', { count: includes.memoryRules })
              : null,
            includes.skills > 0
              ? t('botTemplates.getsSkills', { count: includes.skills })
              : null,
            needs > 0 ? t('botTemplates.getsNeeds', { count: needs }) : null,
          ]}
        />
        <Column
          title={t('botTemplates.leftOut')}
          lines={[
            leftOut.memoryRules > 0
              ? t('botTemplates.leftOutMemory', { count: leftOut.memoryRules })
              : null,
            leftOut.skills > 0
              ? t('botTemplates.leftOutSkills', { count: leftOut.skills })
              : null,
            t('botTemplates.leftOutConversations'),
            t('botTemplates.leftOutMachines'),
          ]}
        />
      </View>
    </HappierWorkUpdateCard>
  );
}

function Column(
  props: Readonly<{ title: string; lines: readonly (string | null)[] }>,
) {
  return (
    <View style={styles.column}>
      <Text variant="meta" style={styles.quiet}>
        {props.title}
      </Text>
      {props.lines.map((line) =>
        line ? (
          <Text key={line} variant="body" style={styles.ink}>
            {line}
          </Text>
        ) : null,
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  quiet: { color: theme.colors.text.secondary },
  ink: { color: theme.colors.text.primary },
  columns: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: theme.space.s24,
    rowGap: theme.space.s16,
    paddingTop: theme.space.s8,
  },
  column: { flexGrow: 1, flexBasis: 220, gap: theme.space.s4 },
}));
