import * as React from 'react';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';

export type CaptureWindowMoreActions = Readonly<{
    onAttachRecent?: () => void;
    onCopyWindowText?: () => void;
    onResetTrim?: () => void;
    onOpenSettings?: () => void;
}>;

/** The ⋯ menu (lab `cw`): the rare ways out of this capture. Items whose owner hasn't landed stay out. */
export function CaptureWindowMoreMenu(props: CaptureWindowMoreActions) {
    const [open, setOpen] = React.useState(false);
    const actions = React.useMemo(() => new Map<string, () => void>([
        ...(props.onAttachRecent ? [['recent', props.onAttachRecent] as const] : []),
        ...(props.onCopyWindowText ? [['text', props.onCopyWindowText] as const] : []),
        ...(props.onResetTrim ? [['trim', props.onResetTrim] as const] : []),
        ...(props.onOpenSettings ? [['settings', props.onOpenSettings] as const] : []),
    ]), [props.onAttachRecent, props.onCopyWindowText, props.onOpenSettings, props.onResetTrim]);
    const items = React.useMemo(() => [...actions.keys()].map((id) => ({
        id,
        title: id === 'recent'
            ? t('screenCapture.window.attachRecent')
            : id === 'text' ? t('screenCapture.window.copyWindowText')
            : id === 'trim' ? t('screenCapture.recording.resetTrim') : t('screenCapture.window.settings'),
    })), [actions]);
    if (items.length === 0) return null;
    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={items}
            matchTriggerWidth={false}
            placement="bottom"
            onSelect={(id: string) => actions.get(id)?.()}
            trigger={({ toggle, open: expanded }) => (
                <IconButton
                    variant="plain"
                    iconName="dots-three"
                    accessibilityLabel={t('screenCapture.window.more')}
                    tooltip={t('screenCapture.window.more')}
                    tooltipPlacement="bottom"
                    tooltipHidden={expanded}
                    hasPopup="menu"
                    expanded={expanded}
                    selected={expanded}
                    onPress={toggle}
                    testID="capture-window-more"
                />
            )}
        />
    );
}
