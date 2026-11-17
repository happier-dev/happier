import * as React from 'react';
import {
  Button,
  IconButton,
  Icon,
  ItemGroup,
  Item,
  Row,
  Select,
  Stack,
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
      variant="secondary"
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
  return (
    <Stack gap="small">
    <ItemGroup
      title={translate('plugins.database.console.parameters', 'Parameters')}
      description={translate(
        'plugins.database.console.parametersLine',
        'Sent separately from the statement, never pasted into it.',
      )}
    >
      {props.inputs.map((input, index) => {
        const invalid =
          input.type !== 'null' &&
          input.text !== '' &&
          readConsoleParameter(input) === undefined;
        return (
          <Item
            key={index}
            title={placeholder(index)}
            {...(invalid
              ? {
                  detail: translate(
                    'plugins.database.console.parameterInvalid',
                    'Not a valid {type}',
                    { type: input.type },
                  ),
                  detailTone: 'danger' as const,
                }
              : {})}
            accessoryBelow
            accessory={
              <Row gap="small" align="center">
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
                  icon={<Icon name="close" />}
                  onPress={() =>
                    props.onChange(
                      props.inputs.filter((_input, at) => at !== index),
                    )
                  }
                />
              </Row>
            }
          />
        );
      })}
    </ItemGroup>
      <Row>{add}</Row>
    </Stack>
  );
}
