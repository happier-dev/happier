import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import {
  listDesktopDisplays,
  type DesktopDisplaysList,
} from '@/activity/adapters/desktop/runtime/desktopDisplays';
import type { DesktopOverlayDisplayMode } from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

/** The display the notch is on right now, as native reports it in the overlay window state. */
export type DesktopNotchDisplayInUse = Readonly<{
  storageKey: string;
  name: string;
  fellBack: boolean;
  requestedName?: string;
}>;

const NAMED_PREFIX = 'named:';

function namedStorageKey(mode: string): string | null {
  return mode.startsWith(NAMED_PREFIX) ? mode.slice(NAMED_PREFIX.length) : null;
}

function quiet(label: string): React.ReactElement {
  return (
    <Text variant="meta" style={styles.quiet}>
      {label}
    </Text>
  );
}

/**
 * Display (lab ntset-A/D/DN): which display the notch lives on. Automatic, the built-in display, the
 * display with the Happier window, or a named display. The display inventory is read when the menu
 * opens, never on page mount, through the same native owner as `desktop.displays.list`. A named display
 * that is unplugged keeps the choice; native falls back to Automatic and the row says so.
 */
export function DesktopNotchDisplayRow(
  props: Readonly<{
    value: string;
    inUse: DesktopNotchDisplayInUse | null;
    onSelect: (value: DesktopOverlayDisplayMode) => void;
  }>,
): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [inventory, setInventory] = React.useState<DesktopDisplaysList | null>(
    null,
  );

  const onOpenChange = React.useCallback((next: boolean) => {
    setOpen(next);
    if (!next) return;
    void listDesktopDisplays()
      .then(setInventory)
      .catch(() => {});
  }, []);

  const selectedKey = namedStorageKey(props.value);
  const displays = inventory?.displays ?? [];
  const automaticName =
    displays.find(
      (display) => display.storageKey === inventory?.automaticResolvesTo,
    )?.name ?? null;
  const selectedName =
    selectedKey === null
      ? null
      : (displays.find((display) => display.storageKey === selectedKey)?.name ??
        props.inUse?.requestedName ??
        (props.inUse?.storageKey === selectedKey ? props.inUse.name : null));

  const items = React.useMemo((): readonly DropdownMenuItem[] => {
    const fixed: DropdownMenuItem[] = [
      {
        id: 'automatic',
        title: t('settingsDesktop.overlay.displayAutomatic'),
        rightElement: automaticName ? quiet(automaticName) : undefined,
      },
    ];
    // The built-in display is offered only where this computer has one.
    if (displays.some((display) => display.builtIn)) {
      fixed.push({
        id: 'built_in',
        title: t('settingsDesktop.overlay.displayBuiltIn'),
      });
    }
    fixed.push({ id: 'main', title: t('settingsDesktop.overlay.displayMain') });
    const named = displays.map((display): DropdownMenuItem => ({
      id: `${NAMED_PREFIX}${display.storageKey}`,
      title: display.name,
      category: t('settingsDesktop.overlay.displaysCategory'),
      rightElement: quiet(
        display.connected
          ? t('settingsDesktop.overlay.displayConnected')
          : t('settingsDesktop.overlay.displayNotConnected'),
      ),
    }));
    // A remembered display that is not in the inventory yet still names itself.
    if (
      selectedKey !== null &&
      !displays.some((display) => display.storageKey === selectedKey)
    ) {
      named.push({
        id: props.value,
        title: selectedName ?? selectedKey,
        category: t('settingsDesktop.overlay.displaysCategory'),
      });
    }
    return [...fixed, ...named];
  }, [automaticName, displays, props.value, selectedKey, selectedName]);

  const unplugged = selectedKey !== null && props.inUse?.fellBack === true;
  const subtitle = unplugged
    ? t('settingsDesktop.overlay.displayUnplugged', {
        name: selectedName ?? selectedKey,
      })
    : t('settingsDesktop.overlay.displaySubtitle');

  return (
    <DropdownMenu
      open={open}
      onOpenChange={onOpenChange}
      items={items}
      selectedId={props.value}
      showCategoryTitles
      onSelect={(itemId) => props.onSelect(itemId as DesktopOverlayDisplayMode)}
      itemTrigger={{
        title: t('settingsDesktop.overlay.displayTitle'),
        subtitle,
        showSelectedSubtitle: false,
        itemProps: { testID: 'settings-desktop-overlay-display' },
      }}
      rowKind="item"
      connectToTrigger
      variant="default"
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  quiet: {
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
}));
