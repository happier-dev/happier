import * as React from 'react';
import type {
  DatabaseCellV1,
  DatabaseNamedCellV1,
  DatabaseRelationV1,
  DatabaseValueV1,
} from '@happier-dev/database-protocol';
import {
  Button,
  CodeBlock,
  ErrorState,
  IconButton,
  Icon,
  Item,
  ItemGroup,
  Row,
  Stack,
  Text,
  TextField,
  usePluginTranslation,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';
import {
  Collection,
  useHappierCollection,
  useListMultiSelectionController,
} from '@happier-dev/plugin-ui/components';
import {
  WorkbenchProvider,
  useRelationPage,
  useWorkbenchCellState,
  useWorkbenchDraft,
  useWorkbenchInstance,
  useWorkbenchLocation,
} from '../hooks.js';
import type { WorkbenchChange, WorkbenchLocation } from '../models.js';
import { CellText, presentCell } from './cells.js';
import { isIdentifierColumn, useGridAnatomy } from './grid.js';
import { RowFilters } from './RowFilters.js';
import { RowsExport } from './RowsExport.js';
import { countLabel } from './sizes.js';

type PageColumn = ReturnType<typeof useRelationPage>['columns'][number];
type PageRow = ReturnType<typeof useRelationPage>['rows'][number];

const EMPTY_SET: ReadonlySet<string> = new Set();


function StagedCell(
  props: Readonly<{
    row: PageRow;
    column: PageColumn;
    index: number;
    translate: PluginTranslate;
  }>,
) {
  const state = useWorkbenchCellState(props.row.rowKey, props.column.name);
  const instance = useWorkbenchInstance();
  if (state.kind === 'edited' || state.kind === 'inserted') {
    const location = instance.local.get('location');
    const held = location.relation
      ? instance.drafts.get(
          instance.draftKey({
            targetKey: location.targetKey,
            relation: location.relation,
            rowKey: props.row.rowKey,
          }),
        )
      : undefined;
    const staged =
      held && held.change.kind !== 'delete'
        ? held.change.values.find((value) => value.column === props.column.name)
            ?.value
        : undefined;
    const cell: DatabaseCellV1 | undefined =
      staged?.kind === 'value' ? staged.cell : undefined;
    return (
      <Row gap="xsmall" align="center">
        <Icon name="edit" tone="attention" size="small" />
        {staged?.kind === 'default' ? (
          <Text
            value={props.translate('plugins.database.cell.default', 'default')}
            tone="muted"
            variant="code"
          />
        ) : (
          <CellText cell={cell} translate={props.translate} identifier={isIdentifierColumn(props.column)} />
        )}
      </Row>
    );
  }
  const cell = props.row.cells[props.index];
  if (state.kind === 'removed')
    return (
      <Text
        value={presentCell(cell, props.translate).text}
        tone="danger"
        numberOfLines={1}
      />
    );
  return <CellText cell={cell} translate={props.translate} identifier={isIdentifierColumn(props.column)} />;
}

/** The row pane: every column, so nothing the table drops is out of reach; editable cells stage locally. */
function RowDetail(
  props: Readonly<{
    row: PageRow;
    columns: readonly PageColumn[];
    relation: DatabaseRelationV1;
    editable: boolean;
    reason?: string;
    tools: ValueTools;
  }>,
) {
  const translate = usePluginTranslation();
  const instance = useWorkbenchInstance();
  const location = useWorkbenchLocation();
  const draft = useWorkbenchDraft(instance);
  const identity = props.row.identity;
  const label = identity
    ? identity.key
        .map((cell) => presentCell(cell.value, translate).text)
        .join(' · ')
    : props.row.rowKey;
  const stage = React.useCallback(
    (column: string, value: DatabaseValueV1 | null) => {
      if (!identity) return;
      const base = {
        targetKey: location.targetKey,
        relation: props.relation,
        rowKey: props.row.rowKey,
        label,
      };
      const held = instance.drafts.get(instance.draftKey(base));
      const previous = held?.change.kind === 'update' ? held.change : undefined;
      const original =
        props.row.cells[
          props.columns.findIndex((candidate) => candidate.name === column)
        ];
      const values = [
        ...(previous?.values.filter((item) => item.column !== column) ?? []),
        ...(value
          ? [{ column, value: { kind: 'value' as const, cell: value } }]
          : []),
      ];
      if (values.length === 0) {
        draft.takeBack(base);
        return;
      }
      const originals: DatabaseNamedCellV1[] = [
        ...(previous?.original.filter((item) => item.column !== column) ?? []),
        ...(original && original.type !== 'partial'
          ? [{ column, value: original }]
          : []),
      ];
      const change: WorkbenchChange = {
        ...base,
        change: {
          kind: 'update',
          key: identity.key,
          values,
          original: originals,
        },
      };
      draft.stage(change);
    },
    [
      draft,
      identity,
      instance,
      label,
      location.targetKey,
      props.columns,
      props.relation,
      props.row,
    ],
  );
  const remove = React.useCallback(() => {
    if (!identity) return;
    draft.stage({
      targetKey: location.targetKey,
      relation: props.relation,
      rowKey: props.row.rowKey,
      label,
      change: { kind: 'delete', key: identity.key },
    });
  }, [
    draft,
    identity,
    label,
    location.targetKey,
    props.relation,
    props.row.rowKey,
  ]);
  return (
    <Stack gap="medium">
      <ItemGroup surface="sheet">
        {props.columns.map((column, index) => (
          <RowField
            key={column.name}
            column={column}
            cell={props.row.cells[index]}
            editable={props.editable && identity !== undefined}
            rowKey={props.row.rowKey}
            onStage={stage}
            translate={translate}
            tools={props.tools}
            foreignKey={column.foreignKey}
          />
        ))}
      </ItemGroup>
      {props.editable && identity ? (
        <Row gap="small">
          <Button
            variant="destructive"
            size="small"
            title={translate('plugins.database.row.delete', 'Delete row')}
            onPress={remove}
          />
        </Row>
      ) : (
        <Text
          tone="secondary"
          variant="meta"
          value={
            props.reason ??
            (identity
              ? translate(
                  'plugins.database.row.readOnly',
                  'Editing is off for this database.',
                )
              : translate(
                  'plugins.database.row.noKey',
                  'This table has no primary key, so its rows can’t be edited here.',
                ))
          }
        />
      )}
    </Stack>
  );
}

type ForeignKey = NonNullable<PageColumn['foreignKey']>;
/** What the row pane can do with a loaded value: the page's own producers (D27 #3, #7). */
type ValueTools = Readonly<{
  inspectJson: (rowKey: string, column: string) => Promise<JsonCellInspection>;
  openReference: (rowKey: string, constraintName: string) => void;
}>;
type JsonCellInspection = Awaited<ReturnType<NonNullable<ReturnType<typeof useRelationPage>['inspectJson']>>>;

/** A JSON value, read whole on request and shown formatted; a value the database cut is read to its end first. */
function JsonValue(
  props: Readonly<{ rowKey: string; column: string; tools: ValueTools; translate: PluginTranslate }>,
) {
  const [shown, setShown] = React.useState<JsonCellInspection | 'reading' | null>(null);
  if (shown === null || shown === 'reading') {
    return (
      <Button
        variant="secondary"
        size="small"
        busy={shown === 'reading'}
        title={props.translate('plugins.database.row.formatJson', 'Show formatted')}
        onPress={() => {
          setShown('reading');
          props.tools.inspectJson(props.rowKey, props.column).then(setShown, () =>
            setShown({ status: 'unavailable', reason: 'not_json' }),
          );
        }}
      />
    );
  }
  if (shown.status === 'complete')
    return (
      <CodeBlock
        code={shown.formatted}
        language="json"
        copyLabel={props.translate('plugins.database.row.copyValue', 'Copy value')}
      />
    );
  return (
    <Text
      tone="secondary"
      variant="meta"
      value={
        shown.status === 'incomplete'
          ? props.translate('plugins.database.row.jsonIncomplete', 'The whole value couldn’t be read, so it isn’t formatted.')
          : props.translate('plugins.database.row.jsonInvalid', 'This value isn’t valid JSON.')
      }
    />
  );
}

function RowField(
  props: Readonly<{
    column: PageColumn;
    cell: DatabaseCellV1 | undefined;
    editable: boolean;
    rowKey: string;
    onStage: (column: string, value: DatabaseValueV1 | null) => void;
    translate: PluginTranslate;
    tools: ValueTools;
    foreignKey: ForeignKey | undefined;
  }>,
) {
  const state = useWorkbenchCellState(props.rowKey, props.column.name);
  const shown = presentCell(props.cell, props.translate, { identifier: isIdentifierColumn(props.column) });
  // Text-like values edit in place; other kinds, cut values and binary stay read-only here.
  const textual =
    props.editable &&
    !shown.incomplete &&
    props.column.kind === 'text' &&
    (props.cell?.type === 'text' || props.cell?.type === 'null');
  const [value, setValue] = React.useState(
    props.cell?.type === 'text' ? props.cell.value : '',
  );
  const title = props.column.primaryKey
    ? `${props.column.name} · ${props.translate('plugins.database.column.key', 'key')}`
    : props.column.name;
  const reference = props.foreignKey && props.cell?.type !== 'null' ? props.foreignKey : undefined;
  const referenceAction = reference ? (
    // A quiet jump beside the value, not a second call to action in the row (lab dbBrowse/longValue).
    <Button
      variant="plain"
      size="small"
      title={props.translate('plugins.database.row.openReference', 'Open in {table}', { table: reference.table })}
      onPress={() => props.tools.openReference(props.rowKey, reference.name)}
    />
  ) : null;
  if (!textual || props.column.primaryKey) {
    const json = props.column.kind === 'json' && props.cell?.type !== 'null';
    return (
      <Item
        title={title}
        subtitle={shown.incomplete ? `${shown.text}…` : shown.text}
        detail={props.column.typeLabel}
        subtitleNumberOfLines={4}
        {...(json || reference
          ? {
              accessoryBelow: true,
              accessory: json ? (
                <JsonValue rowKey={props.rowKey} column={props.column.name} tools={props.tools} translate={props.translate} />
              ) : referenceAction,
            }
          : {})}
      />
    );
  }
  return (
    <Item
      title={title}
      detail={
        state.kind === 'edited'
          ? props.translate('plugins.database.cell.edited', 'Edited')
          : props.column.typeLabel
      }
      detailTone={state.kind === 'edited' ? 'attention' : undefined}
      accessoryBelow
      accessory={
        <Stack gap="small">
          <TextField
            label={props.column.name}
            value={value}
            onChange={setValue}
            autoCorrect={false}
            autoCapitalize="none"
            onSubmitEditing={() =>
              props.onStage(
                props.column.name,
                value === (props.cell?.type === 'text' ? props.cell.value : '') &&
                  props.cell?.type !== 'null'
                  ? null
                  : { type: 'text', value },
              )
            }
          />
          {referenceAction}
        </Stack>
      }
    />
  );
}

/** The relation's rows: a table with every column a field, the row pane holding all of them. */
export function RelationData(
  props: Readonly<{ relation: DatabaseRelationV1 }>,
) {
  const translate = usePluginTranslation();
  const instance = useWorkbenchInstance();
  const location = useWorkbenchLocation();
  const page = useRelationPage(location);
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const [previous, setPrevious] = React.useState<
    readonly WorkbenchLocation['page'][]
  >([]);
  const renderCell = React.useCallback((row: PageRow, column: PageColumn, index: number) => (
    <StagedCell row={row} column={column} index={index} translate={translate} />
  ), [translate]);
  const anatomy = useGridAnatomy<PageRow, PageColumn>(page.columns, translate, renderCell, true);
  const tools = React.useMemo<ValueTools>(() => ({
    inspectJson: async (rowKey, column) => {
      if (!page.inspectJson) throw new Error('Rows are not loaded');
      return page.inspectJson(rowKey, column);
    },
    openReference: (rowKey, constraintName) => {
      const target = page.foreignKey?.(rowKey, constraintName);
      if (target?.status === 'ready') void location.navigate(target.location);
    },
  }), [location, page]);
  const model = useHappierCollection({
    items: page.rows,
    keyOf: (row) => row.rowKey,
    openKey,
    onOpenChange: setOpenKey,
  });
  // D27 #8: rows chosen for export; the List owns which loaded rows can be chosen.
  const selection = useListMultiSelectionController({
    scopeKey: `${props.relation.schema}.${props.relation.name}:${location.page.offset}`,
    rows: 'collection',
  });
  const sortKey = location.sort[0];
  const sort = React.useMemo(
    () => ({
      key: sortKey?.column ?? '',
      direction:
        sortKey?.direction === 'desc'
          ? ('descending' as const)
          : ('ascending' as const),
      onChange: (column: string) => {
        const direction =
          sortKey?.column === column && sortKey.direction === 'asc'
            ? ('desc' as const)
            : ('asc' as const);
        void location.navigate({ sort: [{ column, direction }] });
      },
    }),
    [location, sortKey],
  );
  const completeness = 'completeness' in page ? page.completeness : undefined;
  const next = React.useCallback(() => {
    const continuation =
      completeness && !completeness.complete && (completeness.continuation?.kind === 'keyset' || completeness.continuation?.kind === 'offset')
        ? completeness.continuation
        : undefined;
    if (!continuation) return;
    setPrevious((held) => [...held, location.page]);
    void location.navigate({
      page: {
        rows: location.page.rows,
        offset: location.page.offset + page.rows.length,
        continuation,
      },
    });
  }, [completeness, location, page.rows.length]);
  const back = React.useCallback(() => {
    const last = previous[previous.length - 1];
    if (!last) return;
    setPrevious((held) => held.slice(0, -1));
    void location.navigate({ page: last });
  }, [location, previous]);
  if (page.status === 'unavailable') {
    return (
      <ErrorState
        kind="unavailable"
        title={translate(
          'plugins.database.rows.failed',
          'Rows could not be read',
        )}
        details={page.error instanceof Error ? page.error.message : undefined}
        onRetry={page.refresh}
        retryLabel={translate('plugins.database.retry', 'Try again')}
      />
    );
  }
  const open = openKey
    ? page.rows.find((row) => row.rowKey === openKey)
    : undefined;
  const first = location.page.offset + 1;
  const shownTo = location.page.offset + page.rows.length;
  const total = page.page.approxTotal;
  const footer = (
    <Row gap="small" align="center" justify="space-between">
      <Text
        tone="secondary"
        variant="meta"
        value={
          page.rows.length === 0
            ? ''
            : total
              ? translate(
                  'plugins.database.rows.range',
                  '~{total} rows · showing {from}–{to}',
                  { total: countLabel(total), from: String(first), to: String(shownTo) },
                )
              : translate(
                  'plugins.database.rows.rangeOpen',
                  'Showing {from}–{to}',
                  { from: String(first), to: String(shownTo) },
                )
        }
      />
      <Row gap="xsmall">
        <IconButton
          accessibilityLabel={translate(
            'plugins.database.rows.previous',
            'Previous rows',
          )}
          icon={<Icon name="back" />}
          disabled={previous.length === 0}
          onPress={back}
        />
        <IconButton
          accessibilityLabel={translate(
            'plugins.database.rows.next',
            'Next rows',
          )}
          icon={<Icon name="forward" />}
          disabled={!page.page.hasNext}
          onPress={next}
        />
      </Row>
    </Row>
  );
  return (
    <Collection
      accessibilityLabel={props.relation.name}
      model={model}
      anatomy={anatomy}
      presentation="table"
      detail="auto"
      detailOpenIntent="explicit"
      sort={sort}
      selection={{ multiple: { store: selection } }}
      collapsedGroups={EMPTY_SET}
      loading={page.status === 'loading' && page.rows.length === 0}
      empty={
        <Text
          tone="secondary"
          value={translate('plugins.database.rows.empty', 'No rows')}
        />
      }
      header={
        <Row gap="small" align="center" justify="space-between" wrap>
          <RowFilters
            columns={page.columns}
            conditions={location.conditions}
            onChange={(conditions) => {
              setPrevious([]);
              void location.navigate({ conditions, page: { rows: location.page.rows, offset: 0 } });
            }}
          />
          <RowsExport page={page} selection={selection} />
        </Row>
      }
      footer={footer}
      minListWidth={360}
      minDetailWidth={320}
      preferredListRatio={0.66}
      renderDetail={() =>
        open ? (
          <WorkbenchProvider instance={instance}>
            <RowDetail
              row={open}
              columns={page.columns}
              relation={props.relation}
              tools={tools}
              editable={page.capabilities.edit}
              {...(page.capabilities.reason
                ? { reason: page.capabilities.reason }
                : {})}
            />
          </WorkbenchProvider>
        ) : null
      }
    />
  );
}
