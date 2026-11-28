import * as React from 'react';
import type { DatabaseAccessSummaryV1, DatabaseRelationV1 } from '@happier-dev/plugin-sdk/database';
import {
  Action,
  Button,
  DiffViewer,
  ErrorState,
  Icon,
  Item,
  ItemGroup,
  ModalCardFooterActions,
  PageHeader,
  Row,
  Stack,
  Surface,
  Text,
  usePluginTranslation,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';
import { projectPluginActionRejectionV1, useHostDatabaseWorkbench } from '@happier-dev/plugin-ui/hostApi';
import { useDatabaseAccess, useWorkbenchDraft, useWorkbenchInstance } from '../hooks.js';
import type { WorkbenchApplyOutcome, WorkbenchConflictReloadFailure, WorkbenchReview } from '../models.js';
import { presentCell } from './cells.js';
import { translateUnverifiedServerNotice } from './connectionCopy.js';
import { formatMoment } from './insights/format.js';
import { renderWorkbenchWriteSetup } from './writeSetup.js';

function countLine(
  counts: Readonly<{ edits: number; inserts: number; removals: number }>,
  translate: PluginTranslate,
): string {
  return [
    counts.edits
      ? translate('plugins.database.staged.edits', '{count} edited', {
          count: String(counts.edits),
        })
      : null,
    counts.inserts
      ? translate('plugins.database.staged.inserts', '{count} new', {
          count: String(counts.inserts),
        })
      : null,
    counts.removals
      ? translate('plugins.database.staged.removals', '{count} deleted', {
          count: String(counts.removals),
        })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function outcomeLine(
  outcome: WorkbenchApplyOutcome | undefined,
  translate: PluginTranslate,
): Readonly<{ text: string; tone: 'success' | 'danger' | 'attention' }> | null {
  if (!outcome) return null;
  switch (outcome.kind) {
    case 'applied':
      return {
        text: outcome.count === '1'
          ? translate('plugins.database.apply.appliedOne', '1 change applied')
          : translate(
            'plugins.database.apply.applied',
            '{count} changes applied',
            { count: outcome.count },
          ),
        tone: 'success',
      };
    case 'conflict':
      // Says what happened in words, never the producer's reason code, and how to go on (lab dbEdit/conflict).
      return {
        text: outcome.why === 'row_missing'
          ? translate('plugins.database.apply.conflictRemoved',
            'Nothing was applied: someone removed a row after you loaded it. Your changes are kept. Take that change back, or reload this row.')
          : outcome.why === 'relation_changed'
            ? translate('plugins.database.apply.conflictRelation',
              'Nothing was applied: the table changed after you loaded it. Your changes are kept. Take these changes back and reload the table before editing again.')
            : translate('plugins.database.apply.conflictChanged',
              'Nothing was applied: someone changed a row after you loaded it. Your changes are kept. Take that change back, or reload this row.'),
        tone: 'attention',
      };
    case 'refused':
      if ('execution' in outcome) return null;
      return {
        text:
          ('reason' in outcome.failure ? outcome.failure.reason : undefined) ??
          (outcome.constraint
            ? translate(
                'plugins.database.apply.constraint',
                'The database refused a change ({constraint}). Your changes are kept.',
                { constraint: outcome.constraint },
              )
            : translate(
                'plugins.database.apply.refused',
                'The database refused these changes. Your changes are kept.',
              )),
        tone: 'danger',
      };
    case 'unknown':
      return {
        text: translate(
          'plugins.database.apply.unknown',
          'The connection dropped before the result came back. Reload the table to see what was saved.',
        ),
        tone: 'attention',
      };
  }
}

/** The floating bar while changes are staged: what's waiting, and the one way forward. */
export function StagedBar(props: Readonly<{ onReview: () => void }>) {
  const translate = usePluginTranslation();
  const draft = useWorkbenchDraft(useWorkbenchInstance());
  const total =
    draft.counts.edits + draft.counts.inserts + draft.counts.removals;
  const outcome = outcomeLine(draft.outcome, translate);
  if (total === 0) {
    // The bar becomes the receipt (lab dbEdit-applied): what was written, together, and when.
    return outcome?.tone === 'success' && draft.outcome?.kind === 'applied' ? (
      <Row justify="center">
      <Stack>
      <Surface materialRole="floating" floatingRole="panel" padding="small">
        <Row gap="small" align="center">
          <Icon name="check" tone="success" />
          <Text value={outcome.text} />
          <Text
            tone="secondary"
            value={translate('plugins.database.apply.appliedWhen', 'in one transaction · {time}', {
              time: formatMoment(Date.parse(draft.outcome.at)),
            })}
          />
        </Row>
      </Surface>
      </Stack>
      </Row>
    ) : null;
  }
  return (
    <Surface materialRole="floating" floatingRole="panel" padding="small">
      <Row gap="small" align="center">
        <Text value={countLine(draft.counts, translate)} />
        <Stack grow />
        <Button
          variant="plain"
          size="small"
          title={translate('plugins.database.staged.discard', 'Discard')}
          onPress={draft.discard}
        />
        <Button
          variant="primary"
          size="small"
          title={translate('plugins.database.staged.review', 'Review')}
          onPress={props.onReview}
        />
      </Row>
    </Surface>
  );
}

/** One change as a diff: the old value in the removed role, the new one in the added role; a new row has only new. */
function valueDiff(column: string, old: string | undefined, next: string): string {
  const before = old === undefined ? [] : old.split('\n');
  const after = next.split('\n');
  return [
    `--- ${column}`,
    `+++ ${column}`,
    `@@ -${before.length === 0 ? 0 : 1},${before.length} +1,${after.length} @@`,
    ...before.map((line) => `-${line}`),
    ...after.map((line) => `+${line}`),
  ].join('\n');
}

function changesLabel(count: number, translate: PluginTranslate): string {
  return count === 1
    ? translate('plugins.database.review.oneChange', '1 change')
    : translate('plugins.database.review.changes', '{count} changes', { count: String(count) });
}

/** One table's staged rows (lab dbEdit-review): each row by its key and name, each column old → new, a take-back on each. */
function ReviewGroup(
  props: Readonly<{
    group: WorkbenchReview[number];
    translate: PluginTranslate;
    conflict?: Readonly<{ rowKey: string; notice: string; reloadFailure?: WorkbenchConflictReloadFailure }>;
    onReload: (rowKey: string) => Promise<void>;
    onTakeBack: (rowKey: string) => void;
  }>,
) {
  const { translate } = props;
  return (
    <ItemGroup
      title={props.group.relation.name}
      description={changesLabel(props.group.rows.length, translate)}
    >
      {props.group.rows.map((row) => {
        const conflict = props.conflict?.rowKey === row.rowKey ? props.conflict : undefined;
        const reloadFailure = conflict?.reloadFailure;
        const canReload = conflict !== undefined && row.kind !== 'insert';
        const takeBack = (
          <Button
            variant="plain"
            size="small"
            title={translate('plugins.database.review.takeBack', 'Take back')}
            onPress={() => props.onTakeBack(row.rowKey)}
          />
        );
        return (
          <Item
            key={row.rowKey}
            testID="database-workbench-review-row"
            accessoryWraps={canReload}
            icon={
              <Icon
                name={row.kind === 'insert' ? 'add' : row.kind === 'delete' ? 'close' : 'edit'}
                tone={row.kind === 'insert' ? 'success' : row.kind === 'delete' ? 'danger' : 'info'}
              />
            }
            title={
              row.kind === 'insert'
                ? translate('plugins.database.review.insert', 'New row')
                : row.label
            }
            {...(row.kind === 'delete'
              ? { subtitle: translate('plugins.database.review.delete', 'Delete row') }
              : {})}
            accessory={canReload ? (
              <Row gap="small">
                {takeBack}
                <Button
                  variant="secondary"
                  size="small"
                  title={translate('plugins.database.review.reloadRow', 'Reload')}
                  onPress={() => props.onReload(row.rowKey)}
                />
              </Row>
            ) : takeBack}
          >
            {conflict || row.kind !== 'delete' ? (
              <Stack gap="small">
                {conflict ? (
                  <ErrorState layout="line" title={canReload ? conflict.notice : translate(
                    'plugins.database.review.conflictInsert',
                    'Nothing was applied. The new row is still staged. Take it back to continue.',
                  )} />
                ) : null}
                {reloadFailure?.kind === 'failed' ? (
                  <Action.Failure execution={projectPluginActionRejectionV1(reloadFailure.error, translate)} />
                ) : reloadFailure ? (
                  <Text tone="secondary" value={reloadFailure.kind === 'missing'
                    ? translate('plugins.database.review.reloadMissing', 'This row is no longer there.')
                    : translate('plugins.database.review.reloadIncomplete', 'The full row could not be read.')} />
                ) : null}
                {row.kind === 'delete' ? null : row.changes.map((change) => {
                  const next =
                    change.new?.kind === 'default'
                      ? translate('plugins.database.cell.default', 'default')
                      : presentCell(change.new?.kind === 'value' ? change.new.cell : undefined, translate).text;
                  return (
                    <DiffViewer
                      key={change.column}
                      label={change.column}
                      unifiedDiff={valueDiff(
                        change.column,
                        change.old === undefined ? undefined : presentCell(change.old, translate).text,
                        next,
                      )}
                    />
                  );
                })}
              </Stack>
            ) : null}
          </Item>
        );
      })}
    </ItemGroup>
  );
}

/**
 * The access decider's person refusals: they stand until the Environment's manager changes its database access. While
 * a refusal stands its recovery is the way forward and Apply, which would refuse again, steps back.
 */
const POLICY_REFUSALS: ReadonlySet<string> = new Set<NonNullable<DatabaseAccessSummaryV1['reason']>>([
  'database_editing_off', 'database_not_an_editor',
]);

/**
 * Review old → new before anything is written. Apply is the single committing control; on Production it says so.
 * Changes stay staged through a conflict or refusal, so nothing typed is lost.
 */
export function StagedReview(
  props: Readonly<{
    relation: DatabaseRelationV1;
    targetKey: string;
    onClose: () => void;
  }>,
) {
  const translate = usePluginTranslation();
  const instance = useWorkbenchInstance();
  const draft = useWorkbenchDraft(instance, props);
  const { groups: review, input: reviewedInput } = React.useMemo(
    () => draft.review(),
    [draft],
  );
  const descriptor = instance.target(props.targetKey);
  const host = useHostDatabaseWorkbench();
  const target = descriptor.target.kind === 'deployment_service' || descriptor.target.kind === 'managed_deployment'
    ? descriptor.target : null;
  const production = descriptor.origin.environment === 'production';
  const apply = draft.apply(props.relation);
  const outcome = outcomeLine(draft.outcome, translate);
  const rowConflict = draft.outcome?.kind === 'conflict' && draft.outcome.why !== 'relation_changed' ? draft.outcome : undefined;
  const refusal = draft.outcome?.kind === 'refused' ? draft.outcome : undefined;
  const execution = refusal && 'execution' in refusal ? refusal.execution : undefined;
  const refusalCode = refusal && 'failure' in refusal ? refusal.failure.code : execution?.code;
  // The host reports when this refusal has been resolved.
  const [recoveredFor, setRecoveredFor] = React.useState<typeof refusal>(undefined);
  const refusalRef = React.useRef(refusal);
  refusalRef.current = refusal;
  const onConfigured = React.useCallback(() => setRecoveredFor(refusalRef.current), []);
  const writeSetup = renderWorkbenchWriteSetup(host, target, refusalCode, onConfigured);
  const policyRefusal = refusalCode !== undefined && POLICY_REFUSALS.has(refusalCode);
  const policyLifted = policyRefusal && recoveredFor === refusal;
  const refusalStands = writeSetup != null ? recoveredFor !== refusal : policyRefusal && !policyLifted;
  const access = useDatabaseAccess(props.targetKey, false);
  const { refresh: refreshAccess } = access;
  // Resolve the policy owner's address on refusal, including after an earlier Access read failed.
  React.useEffect(() => {
    if (policyRefusal) refreshAccess();
  }, [policyRefusal, refusal, refreshAccess]);
  const onEditingAllowed = React.useCallback(() => setRecoveredFor(refusal), [refusal]);
  const policy = access.value?.setBy === 'environment' ? access.value : null;
  const engineIsMysql = descriptor.engine === 'mysql';
  const total = draft.counts.edits + draft.counts.inserts + draft.counts.removals;
  // A new Apply result belongs to this Review. The relation can still hold an older result.
  const openedWith = React.useRef(draft.outcome);
  const { onClose } = props;
  React.useEffect(() => {
    if (total === 0 || (draft.outcome !== openedWith.current && draft.outcome?.kind === 'applied')) onClose();
  }, [draft.outcome, onClose, total]);
  if (total === 0) return null;

  const count = String(total);
  const environmentName = target?.kind === 'managed_deployment' ? descriptor.origin.environmentName
    : target?.kind === 'deployment_service' ? descriptor.origin.label : undefined;
  return (
    <Stack gap="large">
      {/* The Review stands in the page's column, so its title is a page title on the content edge; Cancel ends it. */}
      <PageHeader
        title={
          total === 1
            ? translate('plugins.database.review.titleOne', 'Review 1 change')
            : translate('plugins.database.review.titleCount', 'Review {count} changes', { count })
        }
        // The one guarantee the review states (D22): one transaction everywhere; on MySQL, writes that triggers make to
        // non-transactional (MyISAM) tables are the exception, said here rather than in a second note.
        description={
          production
            ? environmentName
              ? engineIsMysql
                ? translate(
                    'plugins.database.review.productionInMysql',
                    'These changes go to {name} in {environment} on Production. They apply together, except writes that triggers make to MyISAM tables.',
                    { name: descriptor.label, environment: environmentName },
                  )
                : translate(
                    'plugins.database.review.productionIn',
                    'These changes go to {name} in {environment} on Production.',
                    { name: descriptor.label, environment: environmentName },
                  )
              : engineIsMysql
                ? translate(
                    'plugins.database.review.productionMysql',
                    'These changes go to {name} on Production. They apply together, except writes that triggers make to MyISAM tables.',
                    { name: descriptor.label },
                  )
                : translate(
                    'plugins.database.review.production',
                    'These changes go to {name} on Production.',
                    { name: descriptor.label },
                  )
            : environmentName
              ? engineIsMysql
                ? translate(
                    'plugins.database.review.togetherInMysql',
                    'Changes to {name} in {environment} apply together, or not at all, except writes that triggers make to MyISAM tables.',
                    { name: descriptor.label, environment: environmentName },
                  )
                : translate(
                    'plugins.database.review.togetherIn',
                    'Changes to {name} in {environment} apply together, or not at all.',
                    { name: descriptor.label, environment: environmentName },
                  )
              : engineIsMysql
                ? translate(
                    'plugins.database.review.togetherToMysql',
                    'Changes to {name} apply together, or not at all, except writes that triggers make to MyISAM tables.',
                    { name: descriptor.label },
                  )
                : translate(
                    'plugins.database.review.togetherTo',
                    'Changes to {name} apply together, or not at all.',
                    { name: descriptor.label },
                  )
        }
      />
      {production && target ? host?.renderProductionBackup?.(target) : null}
      {review.map((group) => (
        <ReviewGroup
          key={`${group.relation.schema}.${group.relation.name}`}
          group={group}
          translate={translate}
          {...(rowConflict && outcome ? { conflict: { ...rowConflict, notice: outcome.text } } : {})}
          onReload={(rowKey) => instance.reloadConflict({ targetKey: props.targetKey, relation: group.relation, rowKey })}
          onTakeBack={(rowKey) =>
            draft.takeBack({
              rowKey,
              relation: group.relation,
              targetKey: props.targetKey,
            })
          }
        />
      ))}
      {writeSetup || (policyLifted ? null : execution ? <Action.Failure execution={execution} />
        : !rowConflict && outcome && outcome.tone !== 'success'
          ? <ErrorState layout="line" kind="error" title={outcome.text} details={refusalCode} />
          : null)}
      {refusalStands && policyRefusal && policy && target ? host?.renderEnvironmentAccessObserver?.({
        target, environment: descriptor.origin.environment, policyEnvironmentId: policy.environmentId, onChanged: refreshAccess,
      }) : null}
      {refusalStands && policyRefusal && policy && target ? host?.renderEnvironmentAccessSettings?.({ target, policy, onEditingAllowed }) : null}
      {descriptor.endpointTrust === 'encrypted_unverified'
        ? <Text tone="secondary" value={translateUnverifiedServerNotice(translate)} />
        : null}
      <ModalCardFooterActions cancel={{ onPress: props.onClose }}>
        <Action.Control
          {...apply}
          reviewedInput={reviewedInput}
          variant={refusalStands ? 'secondary' : production ? 'destructive' : 'primary'}
          title={
            production
              ? translate('plugins.database.review.applyProduction', 'Apply to Production')
              : total === 1
                ? translate('plugins.database.review.applyOne', 'Apply 1 change')
                : translate('plugins.database.review.applyCount', 'Apply {count} changes', { count })
          }
        />
      </ModalCardFooterActions>
    </Stack>
  );
}
