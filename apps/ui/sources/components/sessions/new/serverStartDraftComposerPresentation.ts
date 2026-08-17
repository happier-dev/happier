import { Modal } from '@/modal';

import type {
    SessionServerStartDraftPresentation,
    SessionServerStartDraftSeed,
    SessionServerStartDraftTarget,
} from './serverStartDraftComposer';
import { SessionServerStartDraftComposerModal } from './SessionServerStartDraftComposerModal';

/**
 * The one transient UI presentation for the literal host Session draft arm.
 * It owns only modal completion; Session draft construction remains in the
 * modal and the outer composer owns cancellation/currentness settlement.
 */
export function presentSessionServerStartDraftComposer(params: Readonly<{
    seed: SessionServerStartDraftSeed;
    target: SessionServerStartDraftTarget;
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
            onResolve: settle,
        },
        onRequestClose: close,
        onHostUnmount: close,
        closeOnBackdrop: true,
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
