import * as React from 'react';
import type { DatabaseColumnV1, DatabaseEditV1, DatabaseRelationV1 } from '@happier-dev/plugin-sdk/database';
import { Button, Field, Row, Select, SheetMenu, Stack, Text, TextField, usePluginTranslation } from '@happier-dev/plugin-ui';
import { readConsoleParameter } from '../consoleParameters.js';
import { useWorkbenchInstance } from '../hooks.js';

type Insert = Extract<DatabaseEditV1, { kind: 'insert' }>;
type FieldMode = 'default' | 'value' | 'null';
type Field = Readonly<{ mode: FieldMode; text: string }>;
const EMPTY_FIELD: Field = { mode: 'default', text: '' };

/** The values the fields stage, and the columns whose text does not read as their type. */
function readNewRow(columns: readonly DatabaseColumnV1[], fields: ReadonlyMap<string, Field>) {
  const values: Insert['values'] = [];
  const invalid = new Set<string>();
  for (const column of columns.filter(candidate => !candidate.generated)) {
    const field = fields.get(column.name);
    if (!field || field.mode === 'default') continue;
    const cell = readConsoleParameter({
      type: field.mode === 'null' ? 'null' : column.semanticType === 'unknown' ? 'text' : column.semanticType,
      text: field.text,
      nativeType: column.nativeType,
    });
    if (cell) values.push({ column: column.name, value: { kind: 'value', cell } });
    else invalid.add(column.name);
  }
  return { values, invalid };
}

function NewRowFields(props: Readonly<{
  columns: readonly DatabaseColumnV1[];
  /** The anchored surface names itself; the phone sheet's own title band names it there. */
  heading: string | null;
  fields: ReadonlyMap<string, Field>;
  invalid: ReadonlySet<string>;
  onField: (name: string, field: Field) => void;
  onStage: () => void;
}>) {
  const translate = usePluginTranslation();
  const { fields, invalid } = props;
  const setField = props.onField;
  const stage = props.onStage;
  const writable = props.columns.filter(column => !column.generated);

  const modes = [
    { value: 'default' as const, label: translate('plugins.database.row.default', 'Default') },
    { value: 'value' as const, label: translate('plugins.database.row.value', 'Value') },
  ];
  const nullableModes = [...modes, { value: 'null' as const, label: translate('plugins.database.row.null', 'SQL NULL') }];

  return (
    <Stack gap="small">
      {props.heading === null ? null : <Text variant="heading" value={props.heading} />}
      {writable.map(column => {
        const field = fields.get(column.name) ?? EMPTY_FIELD;
        const options = column.nullable ? nullableModes : modes;
        return (
          // The column names its field and its type says what it takes (TRACKING 1360); the value and its mode share the row.
          <Field key={column.name} label={column.name} description={column.nativeType}
            {...(invalid.has(column.name) ? { issue: translate(
              'plugins.database.row.invalidValue', 'Enter a valid {type} value', { type: column.nativeType },
            ) } : {})}>
            <Row gap="small" align="flex-end" wrap>
              <TextField
                label={column.name}
                value={field.mode === 'value' ? field.text : ''}
                {...(column.semanticType === 'binary' ? { placeholder: translate('plugins.database.row.base64', 'Base64') } : {})}
                disabled={field.mode === 'null'}
                autoCorrect={false}
                autoCapitalize="none"
                onChange={text => setField(column.name, { mode: 'value', text })}
                onSubmitEditing={stage}
              />
              <Select
                label={translate('plugins.database.row.valueMode', '{column} value mode', { column: column.name })}
                presentation="field"
                options={options}
                value={field.mode}
                onChange={mode => {
                  const selected = options.find(option => option.value === mode);
                  if (selected) setField(column.name, { mode: selected.value, text: field.text });
                }}
              />
            </Row>
          </Field>
        );
      })}
    </Stack>
  );
}

const EMPTY_FIELDS: ReadonlyMap<string, Field> = new Map();

export function NewRow(props: Readonly<{
  columns: readonly DatabaseColumnV1[];
  targetKey: string;
  relation: DatabaseRelationV1;
}>) {
  const translate = usePluginTranslation();
  const instance = useWorkbenchInstance();
  const [open, setOpen] = React.useState(false);
  const [fields, setFields] = React.useState<ReadonlyMap<string, Field>>(EMPTY_FIELDS);
  const controlId = React.useId();
  const nextRow = React.useRef(0);
  const label = translate('plugins.database.row.new', 'New row');
  const { values, invalid } = readNewRow(props.columns, fields);
  const stage = () => {
    if (invalid.size > 0) return;
    const proposal = {
      targetKey: props.targetKey,
      relation: props.relation,
      rowKey: `insert:${controlId}:${nextRow.current++}`,
      label,
      change: { kind: 'insert' as const, values },
    };
    instance.drafts.stage(instance.draftKey(proposal), proposal);
    setOpen(false);
  };
  // Stage row is the sheet's footer: the phone sheet pins it under the fields however many columns there are, and the
  // anchored surface ends with it (design review D11). The sheet keeps its own title band and close (N3).
  const footer = <Button size="small" title={translate('plugins.database.row.stage', 'Stage row')} disabled={invalid.size > 0}
    onPress={stage} />;
  return (
    <SheetMenu open={open} onOpenChange={next => { if (next) setFields(EMPTY_FIELDS); setOpen(next); }}
      trigger={label} triggerAccessibilityLabel={label}
      triggerAppearance="control" triggerSize="small" placement="auto" sheet={{ title: label, footer }}
      content={({ sheet }) => <NewRowFields columns={props.columns}
        heading={sheet ? null : label} fields={fields} invalid={invalid}
        onField={(name, field) => setFields(current => new Map(current).set(name, field))} onStage={stage} />} />
  );
}
