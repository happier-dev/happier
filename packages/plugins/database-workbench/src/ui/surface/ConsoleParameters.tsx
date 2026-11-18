import * as React from 'react';
import {
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
import type { ConsoleParameterSlot } from '../consoleSelection.js';

const TYPES: readonly ConsoleParameterInput['type'][] = [
  'text',
  'integer',
  'decimal',
  'boolean',
  'null',
];

/**
 * Console parameters (D27 #8, D41): one typed field per placeholder the statement holds, in its native bind order,
 * sent separately from the SQL so a query reruns with new values without editing it. The slots come from the
 * dialect lexer (`useDatabaseConsole().parameterSlots`); the person picks each type, text by default, and nothing is
 * inferred. Values stay index-ordered by bind (`$3` is the third value), so a numbered gap keeps its place.
 */
export function ConsoleParameters(
  props: Readonly<{
    slots: readonly ConsoleParameterSlot[];
    inputs: readonly ConsoleParameterInput[];
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
  if (props.slots.length === 0) return null;
  const inputAt = (slot: ConsoleParameterSlot) => props.inputs[slot.index - 1] ?? slot.defaultInput;
  const replace = (slot: ConsoleParameterSlot, next: ConsoleParameterInput) => {
    const length = Math.max(props.inputs.length, ...props.slots.map((candidate) => candidate.index));
    props.onChange(Array.from({ length }, (_unused, at) => {
      if (at === slot.index - 1) return next;
      return props.inputs[at] ?? props.slots.find((candidate) => candidate.index === at + 1)?.defaultInput
        ?? { type: 'text' as const, text: '' };
    }));
  };
  // One wrapping line of compact typed fields, each named by its placeholder (lab p7AddNow/params); what they are
  // for is said once under them.
  return (
    <Stack gap="xsmall">
      <Row gap="medium" align="center" wrap>
        {props.slots.map((slot) => {
          const input = inputAt(slot);
          const invalid =
            input.type !== 'null' &&
            input.text !== '' &&
            readConsoleParameter(input) === undefined;
          return (
            // A narrow pane wraps a parameter's value under its type rather than past the edge.
            <Row key={`${slot.index}:${slot.placeholder}`} gap="xsmall" align="center" wrap>
              <Text variant="code" tone="secondary" value={slot.placeholder} />
              <Select
                label={translate(
                  'plugins.database.console.parameterType',
                  'Type of {placeholder}',
                  { placeholder: slot.placeholder },
                )}
                presentation="field"
                options={typeOptions}
                value={input.type}
                onChange={(next) => {
                  const type = TYPES.find((candidate) => candidate === next);
                  if (type) replace(slot, { ...input, type });
                }}
              />
              {input.type === 'null' ? null : (
                <TextField
                  label={translate(
                    'plugins.database.console.parameterValue',
                    'Value of {placeholder}',
                    { placeholder: slot.placeholder },
                  )}
                  placeholder={translate('plugins.database.console.parameterPlaceholder', 'Value')}
                  value={input.text}
                  onChange={(text) => replace(slot, { ...input, text })}
                  autoCorrect={false}
                  autoCapitalize="none"
                />
              )}
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
