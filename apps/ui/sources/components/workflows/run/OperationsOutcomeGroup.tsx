import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { ApprovalReviewFacts } from '@/components/approvals/ApprovalReviewFacts';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useOperationsRunOutcome } from '@/hooks/workflows/useOperationsRunOutcome';
import type { OperationsRunOutcomeInput } from '@/sync/domains/workflows/operationsRunOutcome';
import { t } from '@/text';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';

import { presentOperationsOutcomeRows, type OperationsOutcomeLink } from './operationsOutcomeRows';

type ReceiptOpener = Readonly<{ serverId: string; open: (environmentId: string, deploymentId: string) => void }>;

function linkKey(link: OperationsOutcomeLink): string {
  switch (link.kind) {
    case 'pullRequest': return `pullRequest.${link.pullRequest.url}`;
    case 'approval': return `approval.${link.artifactId}`;
    case 'operation': return `operation.${link.operationId}`;
    case 'receipt': return `receipt.${link.deploymentId}`;
  }
}

/**
 * D3 outcome: finding, proposal, applied effect and recovery as distinct rows, composed from the
 * result owners the page already opened. The finding opens its Session; recovery is live health.
 */
export const OperationsOutcomeGroup = React.memo(
  function OperationsOutcomeGroup(
    props: Readonly<{ input: OperationsRunOutcomeInput; testID: string; openReceipt?: ReceiptOpener }>,
  ) {
    const outcome = useOperationsRunOutcome(props.input);
    const rows = React.useMemo(
      () => presentOperationsOutcomeRows(outcome),
      [outcome],
    );
    const navigateToSession = useNavigateToSession();
    const router = useRouter();
    const { openReceipt } = props;
    const proposedApproval = outcome.finding.kind === 'investigate'
      ? outcome.produced.approvals.find(({ request }) => request === outcome.proposal.approval)
      : undefined;
    const reviewProps = (link: OperationsOutcomeLink | undefined) => {
      if (!proposedApproval?.review || link?.kind !== 'approval'
        || link.artifactId !== proposedApproval.request.artifactId || link.serverId !== proposedApproval.serverId) return undefined;
      const { actionId, actionArgs, preview } = proposedApproval.review;
      return {
        bottomElement: <ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs} preview={preview} status="open" serverId={link.serverId}
          artifactId={link.artifactId} testID={`${props.testID}.proposal.review`} />,
        bottomElementOutsidePressable: true,
      };
    };
    // Each kind opens where it already lives; a receipt on another Home has no page here, so it stays a fact.
    const linkOpener = (link: OperationsOutcomeLink): (() => void) | undefined => {
      switch (link.kind) {
        case 'pullRequest': return () => openExternalUrl(link.pullRequest.url);
        case 'approval': return () => router.pushRetainingCurrent(buildApprovalHref(link.artifactId, link.serverId));
        case 'operation': return () => openActionOperationDetail({ serverId: link.serverId, operationId: link.operationId });
        case 'receipt': return openReceipt?.serverId === link.serverId
          ? () => openReceipt.open(link.environmentId, link.deploymentId) : undefined;
      }
    };
    const renderedRows = rows.map(row => {
      const session = row.session;
      return {
        row,
        onPress: session
          ? () => void navigateToSession(session.sessionId, { serverId: session.serverId })
          : row.opens ? linkOpener(row.opens) : undefined,
        links: row.links.filter(link => link !== row.opens).map(link => ({ link, onPress: linkOpener(link) })),
      };
    });
    useCurrentUiContextLocalCommands(renderedRows.flatMap(({ row, onPress, links }) => [
      ...(!row.session && row.opens?.kind === 'approval' && onPress
        ? [{ key: `${row.key}.${linkKey(row.opens)}`, title: row.title, invoke: onPress }] : []),
      ...links.flatMap(({ link, onPress: open }) => link.kind === 'approval' && open
        ? [{ key: `${row.key}.${linkKey(link)}`, title: link.title, invoke: open }] : []),
    ]), { contextKey: props.testID });
    const factProps = (value: string | undefined, tone: 'danger' | 'attention' | undefined) => tone && value
      ? { rightElement: <Text variant="body" style={tone === 'danger' ? styles.danger : styles.attention} numberOfLines={1}>{value}</Text> }
      : { detail: value };
    return (
      <ItemGroup
        testID={props.testID}
        title={t('workflows.triggers.guided.outcome.title')}
        description={t('workflows.triggers.guided.outcome.description')}
      >
        {renderedRows.flatMap(({ row, onPress, links }) => {
          return [
            <Item
              key={row.key}
              testID={`${props.testID}.${row.key}`}
              title={row.title}
              detail={row.session ? t('runs.openSession') : undefined}
              // A finding is the agent's own words, drawn in full as its Markdown; its links stay its own, outside the row's press.
              {...(row.key === 'finding'
                ? row.markdown
                  ? {
                      bottomElement: <MarkdownView markdown={row.markdown} selectable profile="document" testID={`${props.testID}.${row.key}.markdown`} />,
                      bottomElementOutsidePressable: true,
                    }
                  : { subtitle: row.value, subtitleLines: 3 }
                : factProps(row.value, row.tone))}
              {...reviewProps(row.opens)}
              showChevron={Boolean(onPress)}
              {...(onPress ? { onPress } : {})}
            />,
            ...links.map(({ link, onPress: open }) => {
              return (
                <Item
                  key={`${row.key}.${linkKey(link)}`}
                  testID={`${props.testID}.${row.key}.link.${linkKey(link)}`}
                  title={link.title}
                  {...factProps(link.detail, link.tone)}
                  {...reviewProps(link)}
                  showChevron={Boolean(open)}
                  {...(open ? { onPress: open } : {})}
                />
              );
            }),
          ];
        })}
      </ItemGroup>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  danger: { color: theme.colors.state.danger.textForeground },
  attention: { color: theme.colors.state.warning.textForeground },
}));
