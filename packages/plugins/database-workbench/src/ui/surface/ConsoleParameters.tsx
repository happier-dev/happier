import * as React from 'react';
import {
  Button,
  IconButton,
  Icon,
  Row,
  Select,
  Stack,
  Text,
  TextField,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import {
  readConsoleParameter,
  type ConsoleParameterInput,
} from '../consoleParameters.js';

const TYPES: readonly ConsoleParameterInput['type'][] = [
  'text',
  'integer',
  'decimal',
  'boolean',
  'null',
];

/**
 * Console parameter inputs (D27 #8): typed values bound to the statement's placeholders and sent separately from
 * it, so a query can be rerun with new values without editing the SQL. The controller owns the values; this edits
 * the first statement's list in place.
 */
export function ConsoleParameters(
  props: Readonly<{
    inputs: readonly ConsoleParameterInput[];
    engine: string;
    onChange: (inputs: readonly ConsoleParameterInput[]) => void;
  }>,
) {
  const translate = usePluginTranslation();
  const typeOptions = React.useMemo(
    () =>
      TYPES.map((type) => ({
        value: type,
        label: type === 'null' ? 'NULL' : type,
      })),
    [],
  );
  const placeholder = (index: number) =>
    props.engine === 'postgresql' ? `$${index + 1}` : `? ${index + 1}`;
  const replace = (index: number, next: ConsoleParameterInput) =>
    props.onChange(
      props.inputs.map((input, at) => (at === index ? next : input)),
    );
  const add = (
    <Button
      variant="plain"
      size="small"
      title={translate(
        'plugins.database.console.addParameter',
        'Add parameter',
      )}
      onPress={() =>
        props.onChange([...props.inputs, { type: 'text', text: '' }])
      }
    />
  );
  if (props.inputs.length === 0) return <Row>{add}</Row>;
  // One wrapping line of compact typed fields, each named by its placeholder (lab p7AddNow/params); what they are
  // for is said once under them.
  return (
    <Stack gap="xsmall">
      <Row gap="medium" align="center" wrap>
        {props.inputs.map((input, index) => {
          const invalid =
            input.type !== 'null' &&
            input.text !== '' &&
            readConsoleParameter(input) === undefined;
          return (
            // A narrow pane wraps a parameter's value under its type rather than past the edge.
            <Row key={index} gap="xsmall" align="center" wrap>
              <Text variant="code" tone="secondary" value={placeholder(index)} />
              <Select
                label={translate(
                  'plugins.database.console.parameterType',
                  'Type of {placeholder}',
                  { placeholder: placeholder(index) },
                )}
                presentation="field"
                options={typeOptions}
                value={input.type}
                onChange={(next) => {
                  const type = TYPES.find((candidate) => candidate === next);
                  if (type) replace(index, { ...input, type });
                }}
              />
              {input.type === 'null' ? null : (
                <TextField
                  label={translate(
                    'plugins.database.console.parameterValue',
                    'Value of {placeholder}',
                    { placeholder: placeholder(index) },
                  )}
                  placeholder={translate('plugins.database.console.parameterPlaceholder', 'Value')}
                  value={input.text}
                  onChange={(text) => replace(index, { ...input, text })}
                  autoCorrect={false}
                  autoCapitalize="none"
                />
              )}
              <IconButton
                accessibilityLabel={translate(
                  'plugins.database.console.removeParameter',
                  'Remove {placeholder}',
                  { placeholder: placeholder(index) },
                )}
                icon={<Icon name="close" tone="secondary" />}
                onPress={() =>
                  props.onChange(
                    props.inputs.filter((_input, at) => at !== index),
                  )
                }
              />
              {invalid ? (
                <Text
                  variant="meta"
                  tone="danger"
                  value={translate(
                    'plugins.database.console.parameterInvalid',
                    'Not a valid {type}',
                    { type: input.type },
                  )}
                />
              ) : null}
            </Row>
          );
        })}
        {add}
      </Row>
      <Text
        variant="meta"
        tone="secondary"
        value={translate(
          'plugins.database.console.parametersLine',
          'Sent separately from the statement, never pasted into it.',
        )}
      />
    </Stack>
  );
}
