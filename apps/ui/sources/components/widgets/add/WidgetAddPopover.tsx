import * as React from 'react';
import { View } from 'react-native';

import { AnchoredWidgetShell, WIDGET_FLOW_WIDTH_PX, WidgetSheetShell } from '@/components/widgets/flow/WidgetFlowShell';
import { useDeviceType } from '@/utils/platform/responsive';

import { WidgetAddPanel, type WidgetAddPanelProps } from './WidgetAddPanel';
import { WidgetSetupStep } from './WidgetSetupStep';
import type { WidgetSetup } from './widgetSetupModel';
import { useWidgetAddView } from './useWidgetAddView';

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
    // The surface reshapes from its trailing edge as the step changes (gallery → Set up, Gallery ↔ List).
    const width = setupOpen ? WIDGET_FLOW_WIDTH_PX.setup : view === 'gallery' ? WIDGET_FLOW_WIDTH_PX.gallery : WIDGET_FLOW_WIDTH_PX.list;
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
    /** A repair opens the step at the input it names, its choices open. */
    focusPath?: string;
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
            onClose={props.onRequestClose}
            onDone={props.onRequestClose}
            {...(props.serverId ? { serverId: props.serverId } : {})}
            {...(props.sessionId ? { sessionId: props.sessionId } : {})}
            {...(props.focusPath ? { focusPath: props.focusPath } : {})}
            testID={props.testID}
        />
    );
    return props.phone ? (
        <WidgetSheetShell title={setup.title} onRequestClose={props.onRequestClose} testID={`${props.testID}.sheet`}>{step}</WidgetSheetShell>
    ) : (
        <AnchoredWidgetShell anchorRef={props.anchorRef} placement={props.placement} width={WIDGET_FLOW_WIDTH_PX.setup} onRequestClose={props.onRequestClose}>
            {step}
        </AnchoredWidgetShell>
    );
}
