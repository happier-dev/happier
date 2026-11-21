import * as React from 'react';
import { View } from 'react-native';

import { Modal } from '@/modal';
import { createAnchoredSheetChrome } from '@/modal/components/card/anchoredSheetChrome';
import type { PopoverAnchor } from '@/components/ui/popover';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import { useSheetDismiss } from '@/modal/components/card/sheetDragDismiss';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';

import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';

import type { ReviewInputSelection, ReviewInputSelectionProjection } from './useReviewExecutionRunLaunchOptions';
import { SessionInteractiveExecutionRunDraftView } from './SessionInteractiveExecutionRunDraftView';

type LaunchSelection = ReviewInputSelection;
export type ReviewInputSelectionRequest = Readonly<{
    anchor?: PopoverAnchor;
    sessionId: string | null;
    serverId: string;
    draft: Readonly<Record<string, unknown>>;
    /** Omitting a projection starts the authored Review; projections return input without invoking it. */
    projection?: ReviewInputSelectionProjection;
    isCurrent: () => boolean;
}>;

/** Global Review authoring and no-invoke projections share one body and modal lifecycle. */
export function ReviewExecutionRunLaunchSelectionModal(props: CustomModalInjectedProps & ReviewInputSelectionRequest & Readonly<{
    onResolve: (selection: LaunchSelection | null) => void;
}>) {
    const { onResolve, setChrome } = props;
    // The composer owns the primary action, so the footer holds only Cancel; a phone sheet's close and drag
    // already dismiss it, which leaves that footer empty.
    const phoneSheet = useSheetDismiss() !== null;
    const footer = React.useMemo(() => phoneSheet ? null : (
        <ModalCardFooterActions cancel={{ onPress: () => onResolve(null), testID: 'review-execution-run-launch-cancel' }} />
    ), [onResolve, phoneSheet]);
    useModalCardChrome(setChrome, React.useMemo(() => ({
        ...createAnchoredSheetChrome({ title: t('runPage.launcher.titles.review'), anchor: props.anchor }),
        footer,
    }), [footer, props.anchor]));
    return <View testID="review-execution-run-launch-selection" style={{ maxHeight: '100%', flexShrink: 1 }}>
        <SessionInteractiveExecutionRunDraftView sessionId={props.sessionId} serverId={props.serverId}
            intent="review" initialActionInput={props.draft}
            initialText={typeof props.draft.instructions === 'string' ? props.draft.instructions : undefined}
            reviewSelectionProjection={props.projection} selectionIsCurrent={props.isCurrent} onLaunchSelection={onResolve}
            onStartAccepted={() => onResolve(null)} onRunStarted={() => onResolve(null)} />
    </View>;
}

/** Native/modal lifecycle boundary; dismissal never admits a review or carries a readiness receipt. */
export function presentReviewExecutionRunLaunchSelection(request: ReviewInputSelectionRequest) {
    let modalId = '';
    let settled = false;
    let hideAfterShow = false;
    let resolveResult!: (selection: LaunchSelection | null) => void;
    const result = new Promise<LaunchSelection | null>((resolve) => { resolveResult = resolve; });
    const settle = (selection: LaunchSelection | null) => {
        if (settled) return;
        settled = true;
        resolveResult(selection);
        if (modalId) Modal.hide(modalId);
        else hideAfterShow = true;
    };
    const close = () => settle(null);
    modalId = Modal.show({
        component: ReviewExecutionRunLaunchSelectionModal,
        props: { ...request, onResolve: settle },
        onRequestClose: close,
        onHostUnmount: close,
        closeOnBackdrop: true,
        chrome: createAnchoredSheetChrome({ title: t('runPage.launcher.titles.review'), anchor: request.anchor }),
    });
    if (!modalId) close();
    else if (hideAfterShow) Modal.hide(modalId);
    return { result, close };
}
