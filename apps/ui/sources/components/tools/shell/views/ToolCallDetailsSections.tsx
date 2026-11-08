import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolCall } from '@happier-dev/session-core/messages';
import { bindContextualActionToolInput } from '@happier-dev/protocol/actions/actionToolContext';
import {
  isRecord,
  readHappierActionToolPayload,
} from '@happier-dev/protocol/actions/happierActionToolResult';

import {
  ActionApprovalFieldsCard,
  ApprovalTechnicalDetails,
} from '@/components/approvals/ActionApprovalFieldsCard';
import {
  describeActionResultFields,
  describeApprovalRequestFields,
} from '@/components/approvals/approvalFieldValues';
import {
  readHappierActionCallId,
  readHappierActionCallInput,
} from '@/components/sessions/transcript/references/happierActionToolResult';
import {
  readDecodedToolResult,
  resolveToolCallOutcome,
} from '@/components/tools/shell/presentation/resolveToolCallOutcome';
import { ToolError } from '@/components/tools/shell/presentation/ToolError';
import type { DeclinedApprovalDisposition } from '@/components/tools/shell/presentation/resolveToolStatusIndicatorKind';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { CodeView } from '@/components/ui/media/CodeView';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.keys(value).length === 0;
}

/** One row per field: a scalar reads as the row's value, a nested value as wrapped code under its name. */
// Returns the rows themselves (not a wrapper) so `ItemGroup` sees each one and draws its dividers.
function renderValueRows(value: unknown, testID: string): React.ReactNode {
  const props = { testID };
  if (isRecord(value)) {
    return Object.entries(value).map(([key, entry]) =>
          entry !== null && typeof entry === 'object' ? (
            <SectionContentRow key={key} testID={`${props.testID}:${key}`}>
              <View style={styles.block}>
                <Text style={styles.label}>{key}</Text>
                <CodeView code={JSON.stringify(entry, null, 2)} wrap />
              </View>
            </SectionContentRow>
          ) : (
            <Item
              key={key}
              testID={`${props.testID}:${key}`}
              title={key}
              subtitle={entry === undefined ? '' : String(entry)}
              subtitleLines={0}
              mode="info"
              showChevron={false}
            />
          ),
        );
  }
  const text =
    typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const looksStructured = typeof value !== 'string' || /^\s*[[{]/.test(value);
  return (
    <SectionContentRow testID={props.testID}>
      {looksStructured ? (
        <CodeView code={text} wrap />
      ) : (
        <Text selectable style={styles.text}>
          {text}
        </Text>
      )}
    </SectionContentRow>
  );
}

/**
 * The structured body of the tool-details page for a call without a richer renderer of its own (an MCP or
 * Happier Action call, an unknown tool): what it was asked to do, then what came back — or, for a typed
 * refusal or failure, the reason in words with its code one disclosure away. The raw transport envelope
 * never leads; it stays in the page's Debug disclosure.
 */
export const ToolCallDetailsSections = React.memo(
  function ToolCallDetailsSections(
    props: Readonly<{
      tool: ToolCall;
      serverId?: string | null;
      sessionId?: string | null;
      declinedApproval?: DeclinedApprovalDisposition | null;
    }>,
  ) {
    const { tool } = props;
    const actionId = readHappierActionCallId(tool.name, tool.input);
    const args = React.useMemo(
      () =>
        actionId
          ? bindContextualActionToolInput({
              actionId,
              input: readHappierActionCallInput(tool.name, tool.input),
              context: { defaultSessionId: props.sessionId },
            })
          : readHappierActionToolPayload(tool.input),
      [actionId, props.sessionId, tool.input, tool.name],
    );
    // The tool call is history even when it returned an approval reference;
    // that request's decision remains on its own linked approval page.
    const outcome = React.useMemo(() => resolveToolCallOutcome(tool), [tool]);
    const actionFields = React.useMemo(
      () =>
        actionId
          ? describeApprovalRequestFields({ actionId, actionArgs: args,
              ...(outcome.kind === 'failure' ? { status: 'failed' as const }
                : tool.state === 'completed' ? { status: 'executed' as const } : {}) })
          : null,
      [actionId, args, outcome.kind, tool.state],
    );
    // Keep the returned approval reference navigable; its current decision comes from the header's matched disposition.
    const failure = outcome.kind === 'failure' ? outcome.failure : null;
    const failureMessage = failure?.message ?? null;
    const approvalRequest = actionId && outcome.kind === 'approval_requested' ? outcome : null;
    const pending = outcome.kind === 'pending' ? outcome : null;
    const decoded = React.useMemo(
      () =>
        outcome.kind === 'status' && tool.state === 'completed' && tool.result != null
          ? readDecodedToolResult(tool)
          : undefined,
      [outcome.kind, tool],
    );
    // An Action's result reads by meaning through the same owner as its arguments; raw keys stay in Debug.
    const resultFields = React.useMemo(
      () =>
        actionId && decoded !== undefined
          ? describeActionResultFields({ result: decoded, actionArgs: args })
          : null,
      [actionId, args, decoded],
    );
    const pendingDetails = React.useMemo(
      () =>
        pending
          ? (describeActionResultFields({ result: pending.details, actionArgs: args })?.rows ?? [])
              .filter((row) => row.kind === 'value')
              .map((row) => ({ key: row.path, label: row.title, value: row.value }))
          : [],
      [args, pending],
    );

    return (
      <>
        {actionFields && actionFields.rows.length > 0 ? (
          <ActionApprovalFieldsCard
            presentation={actionFields}
            anatomy="page"
            serverId={props.serverId ?? null}
            exactSessionReads
          />
        ) : !isEmptyValue(args) ? (
          <ItemGroup title={t('toolView.input')} testID="tool-details-input">
            {renderValueRows(args, 'tool-details-input-row')}
          </ItemGroup>
        ) : null}

        {failure ? (
          <ItemGroup
            title={t('tools.structuredResult.result')}
            testID="tool-details-failure"
          >
            <Item
              testID="tool-details-failure-reason"
              title={
                failure.summary ??
                failureMessage ??
                (failure.outcome === 'refused'
                  ? t('toolView.actionOutcome.refusedReason')
                  : t('toolView.actionOutcome.failedReason'))
              }
              subtitle={
                failure.summary && failureMessage ? failureMessage : undefined
              }
              subtitleLines={0}
              mode="info"
              showChevron={false}
            />
            <ApprovalTechnicalDetails
              lines={[
                {
                  key: 'failure-code',
                  label: t('common.error'),
                  value: failure.cause
                    ? `${failure.code} · ${failure.cause}`
                    : failure.code,
                },
              ]}
            />
          </ItemGroup>
        ) : tool.state === 'error' && tool.result != null ? (
          <ItemGroup
            title={t('tools.fullView.error')}
            testID="tool-details-error"
          >
            <SectionContentRow>
              <ToolError
                message={
                  typeof tool.result === 'string'
                    ? tool.result
                    : JSON.stringify(tool.result, null, 2)
                }
              />
            </SectionContentRow>
          </ItemGroup>
        ) : pending ? (
          <ItemGroup
            title={t('tools.structuredResult.result')}
            testID="tool-details-result"
          >
            <Item
              testID="tool-details-pending"
              title={pending.confirmed ? t('toolView.pending.title') : t('toolView.pending.unknownTitle')}
              subtitle={pending.confirmed ? t('toolView.pending.description') : t('toolView.pending.unknownDescription')}
              subtitleLines={0}
              mode="info"
              showChevron={false}
            />
            {pendingDetails.length > 0 ? <ApprovalTechnicalDetails lines={pendingDetails} /> : null}
          </ItemGroup>
        ) : approvalRequest ? (
          <ItemGroup
            title={t('tools.structuredResult.result')}
            testID="tool-details-result"
          >
            <ApprovalRequestRow
              artifactId={approvalRequest.artifactId}
              serverId={props.serverId ?? null}
              declinedApproval={props.declinedApproval ?? null}
            />
          </ItemGroup>
        ) : resultFields ? (
          resultFields.rows.length > 0 ? (
            <ActionApprovalFieldsCard
              presentation={resultFields}
              anatomy="page"
              title={t('tools.structuredResult.result')}
              testID="tool-details-result"
              serverId={props.serverId ?? null}
              exactSessionReads
            />
          ) : (
            <ItemGroup
              title={t('tools.structuredResult.result')}
              testID="tool-details-result"
            >
              <Item
                testID="tool-details-result-empty"
                title={t('tools.fullView.noOutput')}
                mode="info"
                showChevron={false}
              />
            </ItemGroup>
          )
        ) : decoded !== undefined && !isEmptyValue(decoded) ? (
          <ItemGroup
            title={t('tools.structuredResult.result')}
            testID="tool-details-result"
          >
            {renderValueRows(decoded, 'tool-details-result-row')}
          </ItemGroup>
        ) : null}
      </>
    );
  },
);

/** The approval an Action asked for, opening that request where its decision lives. */
function ApprovalRequestRow(
  props: Readonly<{ artifactId: string; serverId: string | null; declinedApproval: DeclinedApprovalDisposition | null }>,
) {
  const router = useDestinationRouter();
  const { artifactId, serverId, declinedApproval } = props;
  return (
    <Item
      testID="tool-details-approval-request"
      title={declinedApproval ? t(`approvals.status.${declinedApproval}`) : t('toolView.approvalRequested.title')}
      subtitle={declinedApproval ? undefined : t('toolView.approvalRequested.description')}
      subtitleLines={0}
      onPress={
        serverId
          ? () => router.push(buildApprovalHref(artifactId, serverId))
          : undefined
      }
      mode={serverId ? undefined : 'info'}
      showChevron={Boolean(serverId)}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  block: {
    gap: theme.space.s6,
  },
  label: {
    ...Typography.variant('body', 'semiBold'),
    color: theme.colors.text.primary,
  },
  text: {
    ...Typography.variant('body'),
    color: theme.colors.text.primary,
  },
}));
