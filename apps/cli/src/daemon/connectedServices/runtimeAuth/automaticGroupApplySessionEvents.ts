import type { ConnectedServiceGenerationExecutionAuthority } from '../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';

export function shouldCommitAutomaticGroupApplySessionEvent(
    event: unknown,
    policy: Readonly<{
        commitAccountSwitchEvents: boolean;
        executionAuthority?: ConnectedServiceGenerationExecutionAuthority;
    }>,
): boolean {
    const record = event && typeof event === 'object' ? event as {
        type?: unknown;
        fromProfileId?: unknown;
        toProfileId?: unknown;
    } : null;
    if (
        policy.executionAuthority === 'passive_projection'
        && typeof record?.type === 'string'
        && record.type.startsWith('connected_service_account_switch')
    ) return false;
    if (record?.type !== 'connected_service_account_switch') return true;
    const fromProfileId = typeof record.fromProfileId === 'string' ? record.fromProfileId.trim() : '';
    const toProfileId = typeof record.toProfileId === 'string' ? record.toProfileId.trim() : '';
    if (fromProfileId && toProfileId && fromProfileId === toProfileId) return false;
    return policy.commitAccountSwitchEvents;
}
