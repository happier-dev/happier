import type { MemoryStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';

export type ArchivedMemoryStatusRequestState = 'unresolved' | 'loading' | 'resolved' | 'unreachable';

export type ArchivedMemoryEligibilityControlV1 = Readonly<{
    state: 'loading' | 'unreachable' | 'unsupported' | 'supported';
    /** Whether this daemon advertises implementation support for the setting. */
    supported: boolean;
    /** The eligibility the daemon actually applies; never the desired setting. */
    value: boolean;
}>;

/**
 * Older daemons preserve and echo the additive `includeArchivedSessions`
 * setting while ignoring it, so a desired-settings readback proves nothing.
 * Only the daemon's own `includeArchivedSessionsEffective` advertisement can
 * say the setting is implemented, and its value is what the daemon applies.
 */
export function resolveArchivedMemoryEligibilityControl(params: Readonly<{
    status: MemoryStatusV1 | null | undefined;
    statusRequestState: ArchivedMemoryStatusRequestState;
}>): ArchivedMemoryEligibilityControlV1 {
    if (params.statusRequestState === 'loading' || params.statusRequestState === 'unresolved') {
        return {
            state: 'loading',
            supported: false,
            value: params.status?.includeArchivedSessionsEffective === true,
        };
    }
    if (params.statusRequestState === 'unreachable') {
        return { state: 'unreachable', supported: false, value: false };
    }
    const effective = params.status?.includeArchivedSessionsEffective;
    return typeof effective === 'boolean'
        ? { state: 'supported', supported: true, value: effective }
        : { state: 'unsupported', supported: false, value: false };
}
