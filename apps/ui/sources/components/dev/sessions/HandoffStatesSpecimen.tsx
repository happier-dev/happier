import * as React from 'react';
import { router } from 'expo-router';

import { Modal } from '@/modal';
import { openSessionHandoffPicker } from '@/components/sessions/handoff/openSessionHandoffPicker';
import { SessionHandoffProgressModal } from '@/components/sessions/handoff/SessionHandoffProgressModal';
import { SESSION_HANDOFF_SANDBOX_PRESET_REQUIRED } from '@/sync/domains/sessionHandoff/executeSessionHandoffAction';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';

export type HandoffSpecimenFrame = 'sheet' | 'refused' | 'creating' | 'failed';

const MACHINE_NAME = 'Boat · Node 22';
const noop = () => {};

/**
 * Dev-only: the real handoff sheet and progress dialog over a real Session page, in the states a lab frame
 * draws (lab ideas-1118-platform scene 4). The sheet is the shipped picker (nothing it submits runs here);
 * the progress frames mount the shipped progress dialog with an acquisition owner's typed progress.
 */
export function HandoffStatesSpecimen(props: Readonly<{ sessionId: string | null; frame: HandoffSpecimenFrame }>) {
    const serverId = useActiveServerSnapshot().serverId || null;
    const { sessionId, frame } = props;
    React.useEffect(() => {
        if (!sessionId || !serverId) return;
        router.replace(`/session/${encodeURIComponent(sessionId)}` as never);
        if (frame === 'sheet' || frame === 'refused') {
            void openSessionHandoffPicker({
                sessionId, serverId, retainOnSubmit: true, onSubmitAgain: noop,
                onRetained: (_close, _pending, _isOpen, setInlineError) => {
                    if (frame === 'refused') setInlineError(SESSION_HANDOFF_SANDBOX_PRESET_REQUIRED);
                },
            });
            return;
        }
        Modal.show({
            component: SessionHandoffProgressModal,
            props: frame === 'creating'
                ? { serverId, machineCreation: { name: MACHINE_NAME, progress: { kind: 'acquiring' as const } } }
                : {
                    serverId,
                    machineCreation: { name: MACHINE_NAME, progress: { kind: 'failed' as const, code: 'controller_unavailable' } },
                    requestFailure: { ok: false as const, error: 'controller_unavailable', errorCode: 'controller_unavailable' },
                    onRetry: noop,
                },
            closeOnBackdrop: false,
        });
    }, [frame, serverId, sessionId]);
    return null;
}
