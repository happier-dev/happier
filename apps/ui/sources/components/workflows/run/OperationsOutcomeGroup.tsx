import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useOperationsRunOutcome } from '@/hooks/workflows/useOperationsRunOutcome';
import type { OperationsRunOutcomeInput } from '@/sync/domains/workflows/operationsRunOutcome';
import { t } from '@/text';

import { presentOperationsOutcomeRows } from './operationsOutcomeRows';

/**
 * D3 outcome: finding, proposal, applied effect and recovery as distinct rows, composed from the
 * result owners the page already opened. The finding opens its Session; recovery is live health.
 */
export const OperationsOutcomeGroup = React.memo(
  function OperationsOutcomeGroup(
    props: Readonly<{ input: OperationsRunOutcomeInput; testID: string }>,
  ) {
    const outcome = useOperationsRunOutcome(props.input);
    const rows = React.useMemo(
      () => presentOperationsOutcomeRows(outcome),
      [outcome],
    );
    const navigateToSession = useNavigateToSession();
    return (
      <ItemGroup
        testID={props.testID}
        title={t('workflows.triggers.guided.outcome.title')}
        description={t('workflows.triggers.guided.outcome.description')}
      >
        {rows.map((row) => {
          const session = row.session;
          const long = row.key === 'finding';
          return (
            <Item
              key={row.key}
              testID={`${props.testID}.${row.key}`}
              title={row.title}
              // A finding is the agent's own words, drawn as its Markdown (lists stay lists); the other rows are one short fact.
              {...(long && row.markdown
                ? { bottomElement: <MarkdownView markdown={row.markdown} profile="widget" testID={`${props.testID}.${row.key}.markdown`} /> }
                : long
                ? { subtitle: row.value, subtitleLines: 3 }
                : row.tone
                  ? {
                      rightElement: (
                        <Text
                          variant="body"
                          style={
                            row.tone === 'danger'
                              ? styles.danger
                              : styles.attention
                          }
                          numberOfLines={1}
                        >
                          {row.value}
                        </Text>
                      ),
                    }
                  : { detail: row.value })}
              showChevron={Boolean(session)}
              {...(session
                ? {
                    onPress: () =>
                      void navigateToSession(session.sessionId, {
                        serverId: session.serverId,
                      }),
                  }
                : {})}
            />
          );
        })}
      </ItemGroup>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  danger: { color: theme.colors.state.danger.foreground },
  attention: { color: theme.colors.state.warning.foreground },
}));
