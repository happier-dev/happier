import * as React from 'react';
import { View } from 'react-native';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { BaseModal } from '@/modal/components/BaseModal';
import { ModalCardFrame } from '@/modal/components/card/ModalCardFrame';
import { useDeviceType } from '@/utils/platform/responsive';

import { WidgetAddPanel, type WidgetAddPanelProps } from './WidgetAddPanel';
import { WidgetSetupStep } from './WidgetSetupStep';
import type { WidgetSetup } from './widgetSetupModel';
import { useWidgetAddView } from './useWidgetAddView';

/** The gallery is wide enough for two live tiles; the list is a menu's width. */
const GALLERY_WIDTH_PX = 560;
const LIST_WIDTH_PX = 420;
/** Set up / Edit inputs: an inputs column and the live preview beside it (inputs first). */
const SETUP_WIDTH_PX = 800;
const MAX_HEIGHT_PX = 640;
/** The sheet leaves the top of the screen visible, so the Board it adds to stays in view. */
const SHEET_MAX_HEIGHT_RATIO = 0.9;

export type WidgetAddPopoverProps = Omit<WidgetAddPanelProps, 'view' | 'onViewChange' | 'phone' | 'onSetupOpenChange'> & Readonly<{
    open: boolean;
    anchorRef: React.RefObject<View | null>;
    placement?: 'top' | 'bottom';
}>;

/**
 * The one Add popover for widgets, anchored to the placement's Add control: the Board's Add, the
 * Companion's "Add to Companion" (or the phone's +). On a phone it is the app's bottom sheet (the
 * modal card's `sheet` presentation, in thumb reach) rather than an anchored popover. Its view is
 * remembered on this device. The content is built only while it is open, so a closed popover mounts
 * no preview and reads nothing.
 */
export function WidgetAddPopover(props: WidgetAddPopoverProps): React.ReactElement | null {
    const phone = useDeviceType() === 'phone';
    if (!props.open) return null;
    return phone ? <WidgetAddSheet {...props} /> : <AnchoredWidgetAddPopover {...props} />;
}

function AnchoredWidgetAddPopover(props: WidgetAddPopoverProps): React.ReactElement {
    const [view, setView] = useWidgetAddView();
    const [setupOpen, setSetupOpen] = React.useState(false);
    const { open: _open, anchorRef, placement, ...panel } = props;
    const width = setupOpen ? SETUP_WIDTH_PX : view === 'gallery' ? GALLERY_WIDTH_PX : LIST_WIDTH_PX;
    return (
        <AnchoredWidgetShell anchorRef={anchorRef} placement={placement} width={width} onRequestClose={props.onRequestClose}>
            <WidgetAddPanel {...panel} view={view} onViewChange={setView} onSetupOpenChange={setSetupOpen} />
        </AnchoredWidgetShell>
    );
}

/** The phone's bottom sheet (lab WGp/WLp): title and Done, the Gallery | List switch on its own row. */
function WidgetAddSheet(props: WidgetAddPopoverProps): React.ReactElement {
    const [view, setView] = useWidgetAddView();
    const { open: _open, anchorRef: _anchorRef, placement: _placement, ...panel } = props;
    return (
        <WidgetSheetShell title={props.title} onRequestClose={props.onRequestClose} testID={`${props.testID}.sheet`}>
            <WidgetAddPanel {...panel} view={view} onViewChange={setView} phone />
        </WidgetSheetShell>
    );
}

/**
 * Edit inputs and in-card repair (lab dbind E/Ep, dagent ST): the same step as Set up, in the same
 * popover and sheet, anchored to the widget's ⋯ (or its repair action). Only this copy changes.
 */
export function WidgetSetupPopover(props: Readonly<{
    open: boolean;
    anchorRef: React.RefObject<View | null>;
    placement?: 'top' | 'bottom';
    /** Built when it opens; nothing reads while it is closed. */
    setup: () => WidgetSetup;
    onRequestClose: () => void;
    serverId?: string | null;
    sessionId?: string | null;
    testID: string;
}>): React.ReactElement | null {
    const phone = useDeviceType() === 'phone';
    if (!props.open) return null;
    return <OpenWidgetSetupPopover {...props} phone={phone} />;
}

function OpenWidgetSetupPopover(props: React.ComponentProps<typeof WidgetSetupPopover> & Readonly<{ phone: boolean }>): React.ReactElement {
    const [setup] = React.useState(props.setup);
    const step = (
        <WidgetSetupStep
            setup={setup}
            phone={props.phone}
            onCancel={props.onRequestClose}
            onDone={props.onRequestClose}
            {...(props.serverId ? { serverId: props.serverId } : {})}
            {...(props.sessionId ? { sessionId: props.sessionId } : {})}
            testID={props.testID}
        />
    );
    return props.phone ? (
        <WidgetSheetShell title={setup.title} onRequestClose={props.onRequestClose} testID={`${props.testID}.sheet`}>{step}</WidgetSheetShell>
    ) : (
        <AnchoredWidgetShell anchorRef={props.anchorRef} placement={props.placement} width={SETUP_WIDTH_PX} onRequestClose={props.onRequestClose}>
            {step}
        </AnchoredWidgetShell>
    );
}

/** The widget flows' anchored popover (desktop): Add, Set up, About, Save as your widget, Post a snapshot. */
export function AnchoredWidgetShell(props: Readonly<{
    anchorRef: React.RefObject<View | null>;
    placement: 'top' | 'bottom' | undefined;
    width: number;
    onRequestClose: () => void;
    children: React.ReactNode;
}>): React.ReactElement {
    return (
        <Popover
            open
            anchorRef={props.anchorRef}
            placement={props.placement ?? 'bottom'}
            gap={8}
            maxHeightCap={MAX_HEIGHT_PX}
            maxWidthCap={props.width}
            edgePadding={{ vertical: 8, horizontal: 8 }}
            portal={{ web: true, native: true, matchAnchorWidth: false }}
            onRequestClose={props.onRequestClose}
            backdrop={{ effect: 'none', closeOnPan: true }}
        >
            {({ maxHeight, maxWidth }) => (
                <FloatingOverlay
                    maxHeight={maxHeight}
                    keyboardShouldPersistTaps="always"
                    edgeFades={{ top: true, bottom: true, size: 24 }}
                    edgeIndicators={true}
                >
                    {/* A definite width, so the gallery's tiles share the row instead of shrinking to their text. */}
                    <View style={{ width: Math.min(maxWidth, props.width) }}>{props.children}</View>
                </FloatingOverlay>
            )}
        </Popover>
    );
}

/** The same flows as a bottom sheet on a phone. */
export function WidgetSheetShell(props: Readonly<{ title: string; onRequestClose: () => void; testID: string; children: React.ReactNode }>): React.ReactElement {
    const insets = useChromeSafeAreaInsets();
    return (
        <BaseModal
            visible
            placement="bottom"
            showBackdrop
            accessibilityLabel={props.title}
            onClose={props.onRequestClose}
        >
            <ModalCardFrame
                header="none"
                title={props.title}
                presentation="sheet"
                sheetBottomInset={insets.bottom}
                dimensions={{ maxHeightRatio: SHEET_MAX_HEIGHT_RATIO }}
                testID={props.testID}
            >
                {props.children}
            </ModalCardFrame>
        </BaseModal>
    );
}
