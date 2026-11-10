import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

const CUSTOM_ID = 'custom';

export type PolicyValueChoice = Readonly<{ id: string; title: string }>;

/**
 * One machine-policy value as a compact bordered select that sits inside a rule sentence ("When pressure
 * stays [Critical] for [5 min]", lab `rv` AL): the presets, and — for a continuous value — "Custom…" last,
 * which asks for any value in the field's own meaningful range (R43). The trigger always shows the stored
 * value, including one no preset matches. Choosing calls back; the policy owner saves and reconciles.
 */
export const PolicyValueSelect = React.memo(function PolicyValueSelect(
  props: Readonly<{
    testID: string;
    /** What is being chosen, for the trigger's accessible name ("Pressure level"). */
    label: string;
    /** The stored value as the trigger shows it ("5 min", "Critical", "20 GB"). */
    value: string;
    choices: readonly PolicyValueChoice[];
    /** The choice equal to the stored value, if one is. */
    selectedId: string | null;
    onSelect: (id: string) => void;
    /** Present for continuous values: asks for a custom one (and saves it) when "Custom…" is chosen. */
    onCustom?: () => void;
    disabled?: boolean;
    /** The last save did not land: the field reads as invalid until the control returns to truth. */
    invalid?: boolean;
  }>,
) {
  const language = usePreferredLanguage();
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const items = React.useMemo(
    () => [
      ...props.choices.map((choice) => ({
        id: choice.id,
        title: choice.title,
        testID: `${props.testID}:${choice.id}`,
      })),
      ...(props.onCustom
        ? [
            {
              id: CUSTOM_ID,
              title: t('machineVitals.alerts.custom'),
              testID: `${props.testID}:${CUSTOM_ID}`,
            },
          ]
        : []),
    ],
    [language, props.choices, props.onCustom, props.testID],
  );
  const { onSelect, onCustom } = props;
  return (
    <DropdownMenu
      testID={props.testID}
      open={open && props.disabled !== true}
      onOpenChange={setOpen}
      items={items}
      selectedId={props.selectedId ?? (props.onCustom ? CUSTOM_ID : null)}
      onSelect={(id) => {
        setOpen(false);
        if (id === CUSTOM_ID) onCustom?.();
        else onSelect(id);
      }}
      placement="bottom"
      variant="slim"
      matchTriggerWidth={false}
      maxWidthCap={280}
      showCategoryTitles={false}
      popoverPortalWebTarget="body"
      popoverAccessibilityLabel={props.label}
      trigger={({ toggle }) => (
        <HappierPressable
          testID={`${props.testID}.trigger`}
          onPress={toggle}
          disabled={props.disabled}
          accessibilityRole="button"
          accessibilityLabel={`${props.label}: ${props.value}`}
          expanded={open}
          hasPopup="menu"
          style={{ justifyContent: 'center' }}
        >
          {renderDropdownItemTriggerRightElement({
            detail: props.value,
            open,
            detailColor: theme.colors.text.primary,
            chevronColor: theme.colors.text.secondary,
            field: resolveFieldBoxColors(
              theme,
              props.invalid ? 'invalid' : 'idle',
            ),
            fieldSpan: 'intrinsic',
          })}
        </HappierPressable>
      )}
    />
  );
});
