import * as React from 'react';
import type { DatabaseFilterV1 } from '@happier-dev/database-protocol';
import {
  Button,
  Popover,
  Row,
  Select,
  Stack,
  TextField,
  usePluginTranslation,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';
import { CollectionConditionTokens } from '@happier-dev/plugin-ui/components';
import {
  readConsoleParameter,
  type ConsoleParameterInput,
} from '../consoleParameters.js';
import type { GridColumn } from './grid.js';

type Leaf = Extract<DatabaseFilterV1, { kind: 'comparison' | 'null' }>;
type Operator =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'contains'
  | 'empty'
  | 'notEmpty';

/** The page's conditions as the leaves the toolbar shows; anything richer stays one token. */
export function filterLeaves(
  filter: DatabaseFilterV1 | undefined,
): readonly DatabaseFilterV1[] {
  if (!filter) return [];
  return filter.kind === 'and' ? filter.filters : [filter];
}
function combine(
  leaves: readonly DatabaseFilterV1[],
): DatabaseFilterV1 | undefined {
  return leaves.length === 0
    ? undefined
    : leaves.length === 1
      ? leaves[0]
      : { kind: 'and', filters: [...leaves] };
}

/** Which comparisons a column's kind of value supports (D27 #3); JSON and bytes only test for a value. */
function operatorsFor(
  kind: GridColumn['kind'],
  translate: PluginTranslate,
): readonly Readonly<{ value: Operator; label: string }>[] {
  const empty = [
    {
      value: 'empty' as const,
      label: translate('plugins.database.filter.empty', 'is empty'),
    },
    {
      value: 'notEmpty' as const,
      label: translate('plugins.database.filter.notEmpty', 'is not empty'),
    },
  ];
  const is = {
    value: 'eq' as const,
    label: translate('plugins.database.filter.is', 'is'),
  };
  const isNot = {
    value: 'ne' as const,
    label: translate('plugins.database.filter.isNot', 'is not'),
  };
  switch (kind) {
    case 'text':
      return [
        is,
        isNot,
        {
          value: 'contains',
          label: translate('plugins.database.filter.contains', 'contains'),
        },
        ...empty,
      ];
    case 'number':
      return [
        is,
        isNot,
        { value: 'lt', label: '<' },
        { value: 'lte', label: '≤' },
        { value: 'gt', label: '>' },
        { value: 'gte', label: '≥' },
        ...empty,
      ];
    case 'time':
      return [
        is,
        {
          value: 'lt',
          label: translate('plugins.database.filter.before', 'is before'),
        },
        {
          value: 'gt',
          label: translate('plugins.database.filter.after', 'is after'),
        },
        ...empty,
      ];
    case 'bool':
      return [is, ...empty];
    default:
      return empty;
  }
}

/** The typed value a comparison binds; parsing is the Console parameter owner's, so both stay one rule. */
function valueInput(column: GridColumn, text: string): ConsoleParameterInput {
  switch (column.kind) {
    case 'number':
      return { type: 'decimal', text };
    case 'bool':
      return { type: 'boolean', text };
    case 'time':
      return { type: 'temporal', text, nativeType: column.typeLabel };
    default:
      return { type: 'text', text };
  }
}

function leafLabel(leaf: DatabaseFilterV1, translate: PluginTranslate): string {
  if (leaf.kind === 'null')
    return `${leaf.column} ${leaf.isNull ? translate('plugins.database.filter.empty', 'is empty') : translate('plugins.database.filter.notEmpty', 'is not empty')}`;
  if (leaf.kind !== 'comparison')
    return translate('plugins.database.filter.custom', 'Custom condition');
  const words: Readonly<
    Record<Leaf extends { operator: infer O } ? O & string : never, string>
  > = {
    eq: translate('plugins.database.filter.is', 'is'),
    ne: translate('plugins.database.filter.isNot', 'is not'),
    lt: '<',
    lte: '≤',
    gt: '>',
    gte: '≥',
    contains: translate('plugins.database.filter.contains', 'contains'),
  };
  const value = leaf.value.type === 'null' ? 'NULL' : String(leaf.value.value);
  return `${leaf.column} ${words[leaf.operator]} ${value}`;
}

/** Conditions in force as removable tokens, then Filter to add one. Every change reads from the first row again. */
export function RowFilters(
  props: Readonly<{
    columns: readonly GridColumn[];
    conditions: DatabaseFilterV1 | undefined;
    onChange: (conditions: DatabaseFilterV1 | undefined) => void;
  }>,
) {
  const translate = usePluginTranslation();
  const leaves = filterLeaves(props.conditions);
  const tokens = React.useMemo(
    () =>
      leaves.map((leaf, index) => ({
        id: String(index),
        label:
          leaf.kind === 'comparison' || leaf.kind === 'null' ? leaf.column : '',
        valueLabel: leafLabel(leaf, translate),
      })),
    [leaves, translate],
  );
  return (
    <Row gap="small" align="center" wrap>
      {tokens.length > 0 ? (
        <CollectionConditionTokens
          testIDPrefix="database-filter"
          tokens={tokens}
          onRemove={(id) =>
            props.onChange(
              combine(leaves.filter((_leaf, index) => String(index) !== id)),
            )
          }
          labels={{
            remove: (field) =>
              translate(
                'plugins.database.filter.remove',
                'Remove {field} filter',
                { field },
              ),
            save: '',
          }}
        />
      ) : null}
      <FilterAdder
        columns={props.columns}
        onAdd={(leaf) => props.onChange(combine([...leaves, leaf]))}
      />
    </Row>
  );
}

function FilterAdder(
  props: Readonly<{
    columns: readonly GridColumn[];
    onAdd: (leaf: DatabaseFilterV1) => void;
  }>,
) {
  const translate = usePluginTranslation();
  const [open, setOpen] = React.useState(false);
  const [columnName, setColumnName] = React.useState<string | null>(null);
  const column =
    props.columns.find((candidate) => candidate.name === columnName) ??
    props.columns[0];
  const operators = column ? operatorsFor(column.kind, translate) : [];
  const [operator, setOperator] = React.useState<Operator | null>(null);
  const chosen =
    operators.find((candidate) => candidate.value === operator)?.value ??
    operators[0]?.value;
  const [text, setText] = React.useState('');
  const needsValue = chosen !== 'empty' && chosen !== 'notEmpty';
  const value =
    column && needsValue
      ? readConsoleParameter(valueInput(column, text))
      : undefined;
  const ready =
    column !== undefined &&
    chosen !== undefined &&
    (!needsValue || value !== undefined);
  const add = () => {
    if (!column || !chosen) return;
    if (chosen === 'empty' || chosen === 'notEmpty')
      props.onAdd({
        kind: 'null',
        column: column.name,
        isNull: chosen === 'empty',
      });
    else if (value)
      props.onAdd({
        kind: 'comparison',
        column: column.name,
        operator: chosen,
        value,
      });
    setText('');
    setOpen(false);
  };
  const label = translate('plugins.database.filter.add', 'Filter');
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={label}
      triggerAccessibilityLabel={label}
      triggerIcon="filter"
      triggerSize="small"
    >
      <Stack gap="small">
        <Select
          label={translate('plugins.database.filter.column', 'Column')}
          presentation="field"
          options={props.columns.map((candidate) => ({
            value: candidate.name,
            label: `${candidate.name} · ${candidate.typeLabel}`,
          }))}
          value={column?.name ?? ''}
          onChange={(next) => {
            setColumnName(next);
            setOperator(null);
          }}
        />
        <Select
          label={translate('plugins.database.filter.operator', 'Condition')}
          presentation="field"
          options={operators}
          value={chosen ?? ''}
          onChange={(next) => setOperator(next as Operator)}
        />
        {needsValue ? (
          <TextField
            label={translate('plugins.database.filter.value', 'Value')}
            value={text}
            onChange={setText}
            autoCorrect={false}
            autoCapitalize="none"
            onSubmitEditing={() => {
              if (ready) add();
            }}
          />
        ) : null}
        <Button
          size="small"
          title={translate('plugins.database.filter.apply', 'Add filter')}
          disabled={!ready}
          onPress={add}
        />
      </Stack>
    </Popover>
  );
}
