import * as React from 'react';
import type { DatabaseColumnV1, DatabaseEditV1, DatabaseRelationV1 } from '@happier-dev/plugin-sdk/database';
import { Button, Popover, Row, Select, Stack, Text, TextField, usePluginTranslation } from '@happier-dev/plugin-ui';
import { readConsoleParameter } from '../consoleParameters.js';
import { useWorkbenchInstance } from '../hooks.js';

type Insert = Extract<DatabaseEditV1, { kind: 'insert' }>;
type FieldMode = 'default' | 'value' | 'null';
type Field = Readonly<{ mode: FieldMode; text: string }>;
const EMPTY_FIELD: Field = { mode: 'default', text: '' };

function NewRowFields(props: Readonly<{
  columns: readonly DatabaseColumnV1[];
  onStage: (values: Insert['values']) => void;
}>) {
  const translate = usePluginTranslation();
  const [fields, setFields] = React.useState<ReadonlyMap<string, Field>>(() => new Map());
  const setField = (name: string, field: Field) => setFields(current => new Map(current).set(name, field));
  const writable = props.columns.filter(column => !column.generated);
  const values: Insert['values'] = [];
  const invalid = new Set<string>();
  for (const column of writable) {
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
  const stage = () => {
    if (invalid.size === 0) props.onStage(values);
  };
  const modes = [
    { value: 'default' as const, label: translate('plugins.database.row.default', 'Default') },
    { value: 'value' as const, label: translate('plugins.database.row.value', 'Value') },
  ];
  const nullableModes = [...modes, { value: 'null' as const, label: translate('plugins.database.row.null', 'SQL NULL') }];

  return (
    <Stack gap="small">
      {writable.map(column => {
        const field = fields.get(column.name) ?? EMPTY_FIELD;
        const options = column.nullable ? nullableModes : modes;
        return (
          <Stack key={column.name} gap="xsmall">
            <Row gap="small" align="flex-end" wrap>
              <TextField
                label={column.name}
                value={field.mode === 'value' ? field.text : ''}
                placeholder={column.semanticType === 'binary' ? translate('plugins.database.row.base64', 'Base64') : column.nativeType}
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
            {invalid.has(column.name) ? <Text variant="meta" tone="danger" value={translate(
              'plugins.database.row.invalidValue', 'Enter a valid {type} value', { type: column.nativeType },
            )} /> : null}
          </Stack>
        );
      })}
      <Button size="small" title={translate('plugins.database.row.stage', 'Stage row')} disabled={invalid.size > 0} onPress={stage} />
    </Stack>
  );
}

export function NewRow(props: Readonly<{
  columns: readonly DatabaseColumnV1[];
  targetKey: string;
  relation: DatabaseRelationV1;
}>) {
  const translate = usePluginTranslation();
  const instance = useWorkbenchInstance();
  const [open, setOpen] = React.useState(false);
  const controlId = React.useId();
  const nextRow = React.useRef(0);
  const label = translate('plugins.database.row.new', 'New row');
  return (
    <Popover open={open} onOpenChange={setOpen} trigger={label} triggerAccessibilityLabel={label}
      triggerAppearance="control" triggerSize="small" sheet={{ title: label }}>
      {open ? <NewRowFields columns={props.columns} onStage={values => {
        const proposal = {
          targetKey: props.targetKey,
          relation: props.relation,
          rowKey: `insert:${controlId}:${nextRow.current++}`,
          label,
          change: { kind: 'insert' as const, values },
        };
        instance.drafts.stage(instance.draftKey(proposal), proposal);
        setOpen(false);
      }} /> : null}
    </Popover>
  );
}
