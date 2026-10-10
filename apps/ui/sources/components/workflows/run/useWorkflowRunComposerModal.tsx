import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';

import type { CustomModalInjectedProps } from '@/modal';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover/Popover';
import { t } from '@/text';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { KeyboardShortcutContextBridge, useKeyboardShortcutContextSnapshot, type KeyboardShortcutContextSnapshot } from '@/keyboard';

import { useWorkflowCardModal } from './useWorkflowCardModal';
import { WorkflowRunComposer } from './WorkflowRunComposer';

/**
 * The focused-modal presenter for the workflow start composer.
 *
 * Run now anchors to its button; other entry points use the canonical modal.
 * Both presentations share the same composer and preserve the caller's draft.
 *
 * Closing (outside press, Escape, the modal's close) cancels only the unsubmitted command. The caller's draft, values and
 * pending Run id are untouched.
 */
export type WorkflowRunComposerModalProps = React.ComponentProps<typeof WorkflowRunComposer>;

function WorkflowRunComposerModal(
    props: WorkflowRunComposerModalProps & CustomModalInjectedProps & Readonly<{ keyboardContext: KeyboardShortcutContextSnapshot }>,
): React.ReactElement {
    // The modal's own close control dismisses it (`onRequestClose`); the composer has no Cancel row.
    const { keyboardContext, ...composerProps } = props;
    return <KeyboardShortcutContextBridge snapshot={keyboardContext}>
        <WorkflowRunComposer {...composerProps} />
    </KeyboardShortcutContextBridge>;
}

export function useWorkflowRunComposerModal(params: Readonly<{
    /** The caller's explicit intent to review and start this workflow. */
    open: boolean;
    /**
     * Composer props, or `null` while the definition they describe is unread.
     * A null value closes the presentation rather than showing an empty form.
     */
    props: WorkflowRunComposerModalProps | null;
    testID?: string;
    anchorRef?: React.RefObject<View | null>;
}>): React.ReactElement | null {
    const { width } = useWindowDimensions();
    const keyboardContext = useKeyboardShortcutContextSnapshot();
    const anchored = params.anchorRef !== undefined && !isMobileLayoutWidth(width);
    const hostedIntentRef = React.useRef(false);
    hostedIntentRef.current = params.open && !anchored && params.props !== null;
    const onRunRef = React.useRef(params.props?.onRun);
    onRunRef.current = params.props?.onRun;
    // The canonical host retains content for its exit motion. Its retired Start must not
    // admit a new command; an already pending/reconciling command remains caller-owned.
    const runForCurrentIntent = React.useCallback<WorkflowRunComposerModalProps['onRun']>((...args) => {
        if (hostedIntentRef.current) onRunRef.current?.(...args);
    }, []);
    const onCancel = params.props?.onCancel;
    const cancelHostedIntent = React.useCallback(() => {
        hostedIntentRef.current = false;
        onCancel?.();
    }, [onCancel]);
    const modalProps = React.useMemo(() => params.props === null ? null
        : { ...params.props, onRun: runForCurrentIntent, keyboardContext }, [keyboardContext, params.props, runForCurrentIntent]);
    useWorkflowCardModal({
        open: params.open && !anchored,
        component: WorkflowRunComposerModal,
        props: modalProps,
        title: params.props?.workflowName ?? t('workflows.start.workflow'),
        testID: params.testID ?? 'workflow-run-inputs-modal',
        phonePresentation: 'sheet',
        material: 'solid',
        focusReturnRef: params.anchorRef,
        ...(params.props === null ? {} : { onRequestClose: cancelHostedIntent }),
    });
    if (!params.open || params.props === null || !anchored || params.anchorRef === undefined) return null;
    const composerProps = params.props;
    return (
        <Popover
            open
            anchorRef={params.anchorRef}
            focusReturnRef={params.anchorRef}
            // Anchored under Run now, right edges aligned (convo-N7); it flips above only when the
            // space below cannot hold it, and never covers the page from the window's top edge.
            placement="bottom"
            flip
            portal={{ web: { target: 'body' }, native: true, matchAnchorWidth: false, anchorAlign: 'end' }}
            maxWidthCap={520}
            onRequestClose={params.props.onCancel}
        >
            {({ maxHeight, maxWidth }) => (
                <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme"
                    containerStyle={{ width: Math.min(maxWidth, 520) }}>
                    <WorkflowRunComposer {...composerProps} />
                </FloatingOverlay>
            )}
        </Popover>
    );
}
