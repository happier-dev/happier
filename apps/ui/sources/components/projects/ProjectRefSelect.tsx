import * as React from 'react';

import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';
import { t } from '@/text';

const DEFAULT_ID = 'ref:@default';
const OTHER_ID = 'ref:@other';

/**
 * A branch or revision as a field select (plan 11 `OPEN_N` "`DropdownMenu` branch", plan 10 Sources
 * "Default branch or revision"): the default first, the chosen ref when it differs, and "Other
 * branch or revision…" which asks for any ref. Nothing here lists remote refs; the default plus
 * Other is the truthful set while no checkout-free ref listing exists.
 *
 * On a phone (`compact`) it is a value row — the label, the chosen ref and a chevron (lab
 * p-open OPENp, p-sources LISTp) — whose press opens the same menu; a short ref is the phone rule's
 * "short value", so it stays on the label's line instead of a field stacked beneath it.
 */
export const ProjectRefSelect = React.memo(function ProjectRefSelect(
  props: Readonly<{
    testID: string;
    title: string;
    /** The chosen ref; null follows the default. */
    value: string | null;
    /** What "the default" reads as ("v0.3 (default)", "Repository default"). */
    defaultLabel: string;
    /** A ref suggestion for the Other prompt (the default ref). */
    placeholder?: string;
    disabled?: boolean;
    compact?: boolean;
    onChange: (value: string | null) => void;
  }>,
) {
  const { onChange, placeholder, title, value } = props;
  const [open, setOpen] = React.useState(false);
  const items = React.useMemo(
    (): DropdownMenuItem[] => [
      { id: DEFAULT_ID, title: props.defaultLabel, checked: value === null },
      ...(value !== null
        ? [{ id: `ref:${value}`, title: value, checked: true }]
        : []),
      { id: OTHER_ID, title: t('projects.open.otherRef') },
    ],
    [props.defaultLabel, value],
  );
  const select = React.useCallback(
    (id: string) => {
      setOpen(false);
      if (id === DEFAULT_ID) {
        onChange(null);
        return;
      }
      if (id !== OTHER_ID) return;
      void (async () => {
        const typed = await Modal.prompt(title, undefined, {
          defaultValue: value ?? '',
          ...(placeholder ? { placeholder } : {}),
          confirmText: t('common.done'),
        });
        if (typed === null) return;
        onChange(typed.trim() || null);
      })();
    },
    [onChange, placeholder, title, value],
  );
  return (
    <DropdownMenu
      testID={props.testID}
      open={open && props.disabled !== true}
      onOpenChange={(next) => setOpen(props.disabled === true ? false : next)}
      items={items}
      selectedId={value === null ? DEFAULT_ID : `ref:${value}`}
      onSelect={select}
      {...(props.compact
        ? {
            trigger: ({ toggle }: { toggle: () => void }) => (
              <Item
                testID={`${props.testID}.row`}
                title={title}
                detail={value ?? props.defaultLabel}
                disabled={props.disabled}
                onPress={toggle}
                showChevron
              />
            ),
          }
        : {
            itemTrigger: {
              title,
              showSelectedSubtitle: false,
              itemProps: { disabled: props.disabled },
            },
          })}
    />
  );
});
