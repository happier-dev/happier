import * as React from 'react';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import { isParticipantRecipientAvailable } from '@/sync/domains/input/participants/resolveParticipantRoutedSend';

export type ExecutionRunDeliveryMode = 'prompt' | 'steer_if_supported' | 'interrupt';

export function useSessionRecipientState(params: Readonly<{
    targets: readonly SessionParticipantTarget[];
    autoRecipient: ParticipantRecipientV1 | null;
}>): Readonly<{
    recipient: ParticipantRecipientV1 | null;
    didManualOverride: boolean;
    setManualRecipient: (next: ParticipantRecipientV1 | null) => void;
    executionRunDelivery: ExecutionRunDeliveryMode;
    setExecutionRunDelivery: (next: ExecutionRunDeliveryMode) => void;
}> {
    const [manualRecipient, setManualRecipientState] = React.useState<ParticipantRecipientV1 | null>(null);
    const [didManualOverride, setDidManualOverride] = React.useState(false);
    const [executionRunDelivery, setExecutionRunDelivery] = React.useState<ExecutionRunDeliveryMode>('steer_if_supported');

    // If the manually selected recipient disappears (run completes/team removed), clear it and
    // allow auto-recipient to apply again.
    React.useEffect(() => {
        if (!manualRecipient) return;
        if (isParticipantRecipientAvailable({ targets: params.targets, recipient: manualRecipient })) return;
        setManualRecipientState(null);
        setDidManualOverride(false);
    }, [manualRecipient, params.targets]);

    const effectiveRecipient = React.useMemo(() => {
        if (manualRecipient) return manualRecipient;
        if (didManualOverride) return null;
        const auto = params.autoRecipient;
        if (!auto) return null;
        if (!isParticipantRecipientAvailable({ targets: params.targets, recipient: auto })) return null;
        return auto;
    }, [didManualOverride, manualRecipient, params.autoRecipient, params.targets]);

    const setManualRecipient = React.useCallback((next: ParticipantRecipientV1 | null) => {
        setDidManualOverride(true);
        setManualRecipientState(next);
    }, []);

    return {
        recipient: effectiveRecipient,
        didManualOverride,
        setManualRecipient,
        executionRunDelivery,
        setExecutionRunDelivery,
    };
}
