import * as React from 'react';
import {
  Menu,
  Row,
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
  // The block's lead says what these are for (lab p7AddNow/params "Parameters · sent separately…"); then one wrapping
  // line of compact fields, each named by its placeholder, its type a quiet word before its value.
  return (
    <Stack gap="xsmall">
      <Text
        variant="meta"
        tone="secondary"
        value={translate(
          'plugins.database.console.parametersLead',
          'Parameters · sent separately from the statement, never pasted into it',
        )}
      />
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
              <SlotType
                placeholder={slot.placeholder}
                type={input.type}
                options={typeOptions}
                onChange={(type) => replace(slot, { ...input, type })}
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
    </Stack>
  );
}

/**
 * A slot's type: quiet words with a caret ("text ⌄") qualifying the value beside it, opening the shared menu of
 * types, rather than a field box that outweighs the value it qualifies.
 */
function SlotType(
  props: Readonly<{
    placeholder: string;
    type: ConsoleParameterInput['type'];
    options: readonly Readonly<{ value: ConsoleParameterInput['type']; label: string }>[];
    onChange: (type: ConsoleParameterInput['type']) => void;
  }>,
) {
  const translate = usePluginTranslation();
  const [open, setOpen] = React.useState(false);
  const label = translate('plugins.database.console.parameterType', 'Type of {placeholder}', { placeholder: props.placeholder });
  const current = props.options.find((option) => option.value === props.type)?.label ?? props.type;
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      trigger={current}
      triggerAccessibilityLabel={`${label}: ${current}`}
      triggerAppearance="text"
      triggerSize="small"
      triggerDisclosure
      groups={[{
        id: 'types',
        accessibilityLabel: label,
        items: props.options.map((option) => ({ id: option.value, kind: 'radio' as const, radioGroupId: 'type', label: option.label })),
      }]}
      radioGroups={[{ id: 'type', accessibilityLabel: label, selectedId: props.type }]}
      onSelect={(id) => {
        const type = TYPES.find((candidate) => candidate === id);
        if (type) props.onChange(type);
        setOpen(false);
      }}
    />
  );
}
