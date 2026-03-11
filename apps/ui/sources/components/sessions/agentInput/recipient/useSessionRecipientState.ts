import * as React from 'react';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';

export type ExecutionRunDeliveryMode = 'prompt' | 'steer_if_supported' | 'interrupt';

function recipientsEqual(a: ParticipantRecipientV1 | null, b: ParticipantRecipientV1 | null): boolean {
    if (!a || !b) return a === b;
    if (a.kind !== b.kind) return false;
    if (a.kind === 'execution_run') {
        const bb = b as Extract<ParticipantRecipientV1, { kind: 'execution_run' }>;
        return a.runId === bb.runId;
    }
    if (a.kind === 'agent_team_broadcast') {
        const bb = b as Extract<ParticipantRecipientV1, { kind: 'agent_team_broadcast' }>;
        return a.teamId === bb.teamId;
    }
    const bb = b as Extract<ParticipantRecipientV1, { kind: 'agent_team_member' }>;
    // Claude can emit an internal runtime team id in teammate tool payloads while the user-facing
    // team id in participant targets comes from TeamCreate input. Member ids are globally unique
    // within a session (`name@internal-team-id`), so prefer member-id equality for matching.
    return a.memberId === bb.memberId;
}

function isRecipientAvailable(targets: readonly SessionParticipantTarget[], recipient: ParticipantRecipientV1): boolean {
    return targets.some((t) => recipientsEqual(t.recipient, recipient));
}

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
        if (isRecipientAvailable(params.targets, manualRecipient)) return;
        setManualRecipientState(null);
        setDidManualOverride(false);
    }, [manualRecipient, params.targets]);

    const effectiveRecipient = React.useMemo(() => {
        if (manualRecipient) return manualRecipient;
        if (didManualOverride) return null;
        const auto = params.autoRecipient;
        if (!auto) return null;
        if (!isRecipientAvailable(params.targets, auto)) return null;
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
