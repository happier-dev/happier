import * as React from 'react';
import { TextField } from '@happier-dev/plugin-ui';
import type { LocalRunSelection } from '../../../actions/local/contracts.js';

type FieldProps<Value> = Omit<React.ComponentProps<typeof TextField>, 'value' | 'onChange'> & {
  value: Value;
  onChange: (value: Value) => void;
};

/** Keep unfinished operands until their parsed selection changes outside this field. */
function OperandTextField(props: Omit<FieldProps<string>, 'onChange'> & { onChange: (text: string) => string }) {
  const { value, onChange, ...fieldProps } = props;
  const [draft, setDraft] = React.useState({ text: value, publishedText: value });
  if (draft.publishedText !== value) setDraft({ text: value, publishedText: value });
  return (
    <TextField
      {...fieldProps}
      value={draft.publishedText === value ? draft.text : value}
      onChange={(text) => {
        const publishedText = onChange(text);
        setDraft({ text, publishedText });
      }}
    />
  );
}

export function LocalActMatrixField(props: FieldProps<LocalRunSelection['matrix']>) {
  const { value, onChange, ...fieldProps } = props;
  return (
    <OperandTextField
      {...fieldProps}
      value={(value ?? []).join(', ')}
      onChange={(text) => {
        const entries = text.split(',').map((entry) => entry.trim()).filter(Boolean);
        onChange(entries.length ? entries : undefined);
        return entries.join(', ');
      }}
    />
  );
}

export function LocalActVariablesField(props: FieldProps<LocalRunSelection['variables']>) {
  const { value, onChange, ...fieldProps } = props;
  return (
    <OperandTextField
      {...fieldProps}
      value={(value ?? []).map((row) => `${row.name}=${row.value}`).join('\n')}
      onChange={(text) => {
        const rows = text.split('\n')
          .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line.trim()))
          .filter((match): match is RegExpExecArray => match !== null)
          .map((match) => ({ name: match[1]!, value: match[2]! }));
        onChange(rows.length ? rows : undefined);
        return rows.map((row) => `${row.name}=${row.value}`).join('\n');
      }}
    />
  );
}
