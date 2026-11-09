import { Modal } from '@/modal';
import { t } from '@/text';
import { createAnchoredSheetChrome } from '@/modal/components/card/anchoredSheetChrome';
import type { PopoverAnchor } from '@/components/ui/popover';

import type {
    SessionServerStartDraftPresentation,
    SessionServerStartDraftSeed,
    SessionServerStartDraftTarget,
} from './serverStartDraftComposer';
import { SessionServerStartDraftComposerModal } from './SessionServerStartDraftComposerModal';

/**
 * The one transient UI presentation for the literal host Session draft arm.
 * It owns only modal completion; Session draft construction remains with U1's
 * shared recipe model and the outer composer owns cancellation/currentness settlement.
 */
export function presentSessionServerStartDraftComposer(params: Readonly<{
    seed: SessionServerStartDraftSeed;
    target: SessionServerStartDraftTarget;
    anchor?: PopoverAnchor;
}>): SessionServerStartDraftPresentation {
    let modalId = '';
    let settled = false;
    let hideAfterShow = false;
    let resolveResult!: (value: unknown | null) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<unknown | null>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
    });
    const settle = (value: unknown | null) => {
        if (settled) return;
        settled = true;
        resolveResult(value);
        if (modalId) {
            Modal.hide(modalId);
        } else {
            hideAfterShow = true;
        }
    };
    const close = () => settle(null);

    modalId = Modal.show({
        component: SessionServerStartDraftComposerModal,
        props: {
            seed: params.seed,
            target: params.target,
            anchor: params.anchor,
            onResolve: settle,
        },
        onRequestClose: close,
        onHostUnmount: close,
        closeOnBackdrop: true,
        chrome: createAnchoredSheetChrome({ title: t('newSession.recipeComposerTitle'), anchor: params.anchor }),
    });
    if (!modalId) {
        if (!settled) {
            settled = true;
            rejectResult(new Error('Session server-start draft composer is unavailable'));
        }
    } else if (hideAfterShow) {
        Modal.hide(modalId);
    }

    return { result, close };
}
