import * as React from 'react';
import { BROWSER_VIEWPORT_PRESETS, type BrowserViewportEmulationV1 } from '@happier-dev/protocol/browser/input/v1';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';

export type BrowserViewportChoice = Readonly<{ id: string; emulation: BrowserViewportEmulationV1; title: string; subtitle?: string }>;

/** The page sizes a managed page offers, wherever they are drawn (this picker, or a narrow pane's ⋯). */
export function browserViewportChoices(): readonly BrowserViewportChoice[] {
    return [
        { id: 'fitViewer', emulation: { kind: 'fitViewer' }, title: t('browserShell.viewport.fitViewer') },
        ...Object.entries(BROWSER_VIEWPORT_PRESETS).map(([id, preset]) => ({
            id,
            emulation: { kind: 'preset' as const, presetId: id as keyof typeof BROWSER_VIEWPORT_PRESETS },
            title: preset.deviceName,
            subtitle: `${preset.width} × ${preset.height}`,
        })),
    ];
}

/** The applied size's choice id. */
export function selectedBrowserViewportChoiceId(emulation: BrowserViewportEmulationV1): string {
    return emulation.kind === 'preset' ? emulation.presetId : 'fitViewer';
}

/** Chrome consumes the daemon's applied viewport; selecting a device uses the existing command owner. */
export function BrowserViewportPicker(props: Readonly<{
    emulation: BrowserViewportEmulationV1;
    onSelect: (emulation: BrowserViewportEmulationV1) => void;
    size: number;
    iconSize: number;
    spread: boolean;
    testID: string;
}>): React.ReactElement {
    const [open, setOpen] = React.useState(false);
    const selectedId = selectedBrowserViewportChoiceId(props.emulation);
    const choices = browserViewportChoices();
    const items: readonly DropdownMenuItem[] = choices.map((choice) => ({
        id: choice.id, title: choice.title, subtitle: choice.subtitle,
        testID: `${props.testID}-${choice.id}`, checked: choice.id === selectedId,
    }));

    return <DropdownMenu
        open={open}
        onOpenChange={setOpen}
        items={items}
        selectedId={selectedId}
        matchTriggerWidth={false}
        placement={props.spread ? 'top' : 'bottom'}
        onSelect={(id) => {
            const choice = choices.find((candidate) => candidate.id === id);
            if (choice) props.onSelect(choice.emulation);
        }}
        trigger={({ toggle }) => <IconButton
            testID={props.testID}
            iconName="device-mobile"
            variant="plain"
            size={props.size}
            iconSize={props.iconSize}
            interactiveTargetGapPx={props.spread ? undefined : 4}
            accessibilityLabel={t('browserShell.viewport.title')}
            tooltip={t('browserShell.viewport.title')}
            tooltipHidden={open}
            expanded={open}
            hasPopup="menu"
            onPress={toggle}
        />}
    />;
}
