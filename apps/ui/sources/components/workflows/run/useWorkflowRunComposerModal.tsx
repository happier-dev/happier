import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover/Popover';
import { t } from '@/text';

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
    props: WorkflowRunComposerModalProps & CustomModalInjectedProps,
): React.ReactElement {
    // The modal's own close control dismisses it (`onRequestClose`); the composer has no Cancel row.
    return <WorkflowRunComposer {...props} />;
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
    const { theme } = useUnistyles();
    useWorkflowCardModal({
        open: params.open && params.anchorRef === undefined,
        component: WorkflowRunComposerModal,
        props: params.props,
        title: params.props?.workflowName ?? t('workflows.start.workflow'),
        testID: params.testID ?? 'workflow-run-inputs-modal',
        ...(params.props === null ? {} : { onRequestClose: params.props.onCancel }),
    });
    if (!params.open || params.props === null || params.anchorRef === undefined) return null;
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
                    containerStyle={{ width: Math.min(maxWidth, 520), padding: theme.margins.md }}>
                    <WorkflowRunComposer {...composerProps} />
                </FloatingOverlay>
            )}
        </Popover>
    );
}
