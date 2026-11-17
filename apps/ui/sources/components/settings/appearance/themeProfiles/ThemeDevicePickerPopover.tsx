import * as React from 'react';
import { Popover } from '@/components/ui/popover/Popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { t } from '@/text';

/** One responsive placement for the connected-device body, including static design specimens. */
export function ThemeDevicePickerPopover(props: Readonly<{
    themeName: string;
    anchorRef: React.RefObject<unknown>;
    onDismiss: () => void;
    children: React.ReactNode;
}>) {
    return <Popover open anchorRef={props.anchorRef} onRequestClose={props.onDismiss} placement="bottom"
        phonePresentation="sheet" accessibilityLabel={t('themeDevices.title', { name: props.themeName })}
        sheetHeader="none" portal={{ web: true, native: true, matchAnchorWidth: false, sizeToContent: true }}>
        {/* The recycler needs a definite viewport; the existing overlay cap still bounds this room. */}
        {({ maxHeight }) => <FloatingOverlay scrollEnabled={false} scrollViewStyle={{ height: maxHeight, minHeight: 0 }}>
            {props.children}
        </FloatingOverlay>}
    </Popover>;
}
