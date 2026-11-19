import * as React from 'react';
import type { DatabaseRelationV1 } from '@happier-dev/plugin-sdk/database';
import {
  Action,
  Button,
  DiffViewer,
  ErrorState,
  Icon,
  Item,
  ItemGroup,
  ModalCardFooterActions,
  ModalHeader,
  Row,
  Stack,
  Surface,
  Text,
  usePluginTranslation,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';
import { useWorkbenchDraft, useWorkbenchInstance } from '../hooks.js';
import type { WorkbenchApplyOutcome, WorkbenchReview } from '../models.js';
import { presentCell } from './cells.js';
import { formatMoment } from './insights/format.js';

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
      return {
        text: translate(
          'plugins.database.apply.conflict',
          'A row changed since you loaded it: {why}. Your changes are kept.',
          { why: outcome.why },
        ),
        tone: 'attention',
      };
    case 'refused':
      return {
        text:
          outcome.message ??
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
    onTakeBack: (rowKey: string) => void;
  }>,
) {
  const { translate } = props;
  return (
    <ItemGroup
      title={props.group.relation.name}
      description={changesLabel(props.group.rows.length, translate)}
    >
      {props.group.rows.map((row) => (
        <Item
          key={row.rowKey}
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
          accessory={
            <Button
              variant="plain"
              size="small"
              title={translate('plugins.database.review.takeBack', 'Take back')}
              onPress={() => props.onTakeBack(row.rowKey)}
            />
          }
        >
          {row.kind === 'delete' ? null : (
            <Stack gap="small">
              {row.changes.map((change) => {
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
          )}
        </Item>
      ))}
    </ItemGroup>
  );
}

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
  const production = descriptor.origin.environment === 'production';
  const apply = draft.apply(props.relation);
  const outcome = outcomeLine(draft.outcome, translate);
  const engineIsMysql = descriptor.engine === 'mysql';
  // Close on this review's own Apply, never on an earlier receipt still held for the relation.
  const openedWith = React.useRef(draft.outcome);
  const { onClose } = props;
  React.useEffect(() => {
    if (draft.outcome !== openedWith.current && draft.outcome?.kind === 'applied') onClose();
  }, [draft.outcome, onClose]);
  const total = draft.counts.edits + draft.counts.inserts + draft.counts.removals;
  const count = String(total);
  return (
    <Stack gap="large">
      <ModalHeader
        title={
          total === 1
            ? translate('plugins.database.review.titleOne', 'Review 1 change')
            : translate('plugins.database.review.titleCount', 'Review {count} changes', { count })
        }
        subtitle={
          production
            ? translate(
                'plugins.database.review.production',
                'These changes go to {name} on Production.',
                { name: descriptor.label },
              )
            : translate(
                'plugins.database.review.together',
                '{name}. Applied together, or not at all.',
                { name: descriptor.label },
              )
        }
        onClose={props.onClose}
      />
      {review.map((group) => (
        <ReviewGroup
          key={`${group.relation.schema}.${group.relation.name}`}
          group={group}
          translate={translate}
          onTakeBack={(rowKey) =>
            draft.takeBack({
              rowKey,
              relation: group.relation,
              targetKey: props.targetKey,
            })
          }
        />
      ))}
      {engineIsMysql ? (
        // D22: one transaction on MySQL too; only trigger writes to MyISAM tables escape the rollback.
        <Text
          tone="secondary"
          variant="meta"
          value={translate(
            'plugins.database.review.mysqlNote',
            'These changes apply together, but changes that triggers make to non-transactional (MyISAM) tables can’t be rolled back.',
          )}
        />
      ) : null}
      {outcome && outcome.tone !== 'success' ? (
        <ErrorState layout="line" kind="error" title={outcome.text} />
      ) : null}
      <ModalCardFooterActions cancel={{ onPress: props.onClose }}>
        <Action.Control
          {...apply}
          reviewedInput={reviewedInput}
          variant={production ? 'destructive' : 'primary'}
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
