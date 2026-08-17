import { Modal } from '@/modal';
import { t } from '@/text';
import type { SessionForkStrategyAvailability } from '@/sync/domains/sessionFork/forkUiSupport';
import type { SessionForkStrategyRequest } from '@/sync/domains/sessionFork/useSessionForkStrategyFlow';

import {
    SESSION_FORK_STRATEGY_MODAL_TEST_ID,
    SessionForkStrategyModal,
} from './SessionForkStrategyModal';

export type OpenSessionForkStrategyModalParams = Readonly<{
    request: SessionForkStrategyRequest;
    availability: SessionForkStrategyAvailability;
    /** Short quotation of the message this fork branches from, when there is one. */
    sourcePreview?: string | null;
    navigate: (childSessionId: string) => void | Promise<void>;
    /** Navigates to the canonical New Session screen with this fork point attached. */
    configureNewSession: () => void;
}>;

/**
 * The one launcher for the fork strategy modal. Every fork entry point — the
 * Session header, the Session info screen and a transcript message — goes
 * through it, so none can issue a fork effect before the user has chosen a
 * strategy.
 *
 * The backdrop does not close it: the modal owns a real, effectful operation and
 * a stray tap must not orphan it. Escape, native back and the card close button
 * stay available, so the surface is never a trap.
 */
export function openSessionForkStrategyModal(params: OpenSessionForkStrategyModalParams): string {
    return Modal.show({
        component: SessionForkStrategyModal,
        props: {
            request: params.request,
            availability: params.availability,
            sourcePreview: params.sourcePreview ?? null,
            navigate: params.navigate,
            onConfigureNewSession: params.configureNewSession,
        },
        chrome: {
            kind: 'card',
            title: t('session.forking.strategy.title'),
            // The framing always stays here. The quotation is unbounded user
            // content and the card subtitle has no line clamp, so the preview is
            // rendered clamped in the body instead of replacing this line.
            subtitle: params.request.forkPoint.type === 'seq'
                ? t('session.forking.strategy.subtitleFromMessage')
                : t('session.forking.strategy.subtitleLatest'),
            testID: SESSION_FORK_STRATEGY_MODAL_TEST_ID,
            bodyScroll: 'auto',
            dimensions: { size: 'md', width: 460, maxHeightRatio: 0.86 },
        },
        closeOnBackdrop: false,
    });
}
