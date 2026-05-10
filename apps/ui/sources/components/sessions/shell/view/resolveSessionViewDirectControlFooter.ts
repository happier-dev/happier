import type { ChatFooterDirectControlState } from '@/components/sessions/transcript/ChatFooter';

export type SessionViewDirectControlFooter = ChatFooterDirectControlState;

type DirectControlFooterState = NonNullable<SessionViewDirectControlFooter>;

type Input = Readonly<{
    externalSessionLink: Readonly<{ machineId: string }> | null;
    externalSessionRuntime: Readonly<{
        status?: Readonly<{
            machineOnline?: boolean;
            runnerActive?: boolean;
            activity?: string;
            canTakeOverDirect?: boolean;
            canTakeOverPersist?: boolean;
        }> | null;
    }>;
    externalSessionTakeover: Readonly<{
        takeoverInFlight: 'direct' | 'persisted' | null;
        requestTakeover: (kind: 'direct' | 'persisted') => void | Promise<void | boolean>;
    }>;
    isHiddenSystemSessionSession: boolean;
}>;

function normalizeDirectControlActivity(value: string | null | undefined): DirectControlFooterState['activity'] {
    if (value === 'running' || value === 'active_recently' || value === 'idle' || value === 'unknown') {
        return value;
    }
    return 'unknown';
}

export function resolveSessionViewDirectControlFooter(input: Input): SessionViewDirectControlFooter | null {
    if (input.isHiddenSystemSessionSession) {
        return null;
    }
    if (!input.externalSessionLink) {
        return null;
    }

    const status = input.externalSessionRuntime.status;
    return {
        machineOnline: status?.machineOnline ?? true,
        runnerActive: status?.runnerActive ?? false,
        activity: normalizeDirectControlActivity(status?.activity),
        canTakeOverDirect: status?.canTakeOverDirect ?? false,
        canTakeOverPersist: status?.canTakeOverPersist ?? false,
        takeoverInFlight: input.externalSessionTakeover.takeoverInFlight,
        onRequestTakeOverDirect: (status?.canTakeOverDirect ?? false)
            ? () => { void input.externalSessionTakeover.requestTakeover('direct'); }
            : undefined,
        onRequestTakeOverPersist: (status?.canTakeOverPersist ?? false)
            ? () => { void input.externalSessionTakeover.requestTakeover('persisted'); }
            : undefined,
    };
}
