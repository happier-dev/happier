import * as React from 'react';
import { View } from 'react-native';

import type { CustomModalInjectedProps } from '@/modal';
import { createAnchoredSheetChrome } from '@/modal/components/card/anchoredSheetChrome';
import { t } from '@/text';
import { COMPOSER_CONTENT_HORIZONTAL_INSET } from '@/components/sessions/agentInput/composerContentInset';
import { KeyboardShortcutContextBridge, useKeyboardShortcutContextSnapshot, type KeyboardShortcutContextSnapshot } from '@/keyboard';

import { useWorkflowCardModal } from './useWorkflowCardModal';
import { WorkflowRunComposer } from './WorkflowRunComposer';
import { WorkflowAccountLifetimeProvider, useWorkflowAccountLifetime } from '../workflowAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

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
    props: WorkflowRunComposerModalProps & CustomModalInjectedProps & Readonly<{
        keyboardContext: KeyboardShortcutContextSnapshot;
        accountLifetime?: ServerAccountScopeLifetime | null;
    }>,
): React.ReactElement {
    // The modal's own close control dismisses it (`onRequestClose`); the composer has no Cancel row.
    const { keyboardContext, accountLifetime, ...composerProps } = props;
    return <WorkflowAccountLifetimeProvider value={accountLifetime}><KeyboardShortcutContextBridge snapshot={keyboardContext}>
        {/* The sheet's form keeps the sheet header's edge at every width (lab flWork `libP`). */}
        <WorkflowRunComposer {...composerProps} autoFocusComposer={composerProps.autoFocusComposer ?? true}
            contentPaddingHorizontal={composerProps.contentPaddingHorizontal ?? COMPOSER_CONTENT_HORIZONTAL_INSET} />
    </KeyboardShortcutContextBridge></WorkflowAccountLifetimeProvider>;
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
    accountLifetime?: ServerAccountScopeLifetime | null;
}>): React.ReactElement | null {
    const keyboardContext = useKeyboardShortcutContextSnapshot();
    const accountLifetime = useWorkflowAccountLifetime(params.accountLifetime);
    const hostedIntentRef = React.useRef(false);
    hostedIntentRef.current = params.open && params.props !== null;
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
        : { ...params.props, onRun: runForCurrentIntent, keyboardContext, accountLifetime }, [accountLifetime, keyboardContext, params.props, runForCurrentIntent]);
    useWorkflowCardModal({
        open: params.open,
        component: WorkflowRunComposerModal,
        props: modalProps,
        title: params.props?.workflowName ?? t('workflows.start.workflow'),
        testID: params.testID ?? 'workflow-run-inputs-modal',
        chrome: createAnchoredSheetChrome({
            title: params.props?.workflowName ?? t('workflows.start.workflow'),
            testID: params.testID ?? 'workflow-run-inputs-modal',
            ...(params.anchorRef?.current ? { anchor: { kind: 'view', ref: params.anchorRef } as const } : {}),
        }),
        focusReturnRef: params.anchorRef,
        ...(params.props === null ? {} : { onRequestClose: cancelHostedIntent }),
    });
    return null;
}
