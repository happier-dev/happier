import type { ChatFooterDirectControlState } from '@/components/sessions/transcript/ChatFooter';

export type SessionViewDirectControlFooter = ChatFooterDirectControlState;

type DirectControlFooterState = NonNullable<SessionViewDirectControlFooter>;

type Input = Readonly<{
    directSessionLink: Readonly<{ machineId: string }> | null;
    directSessionRuntime: Readonly<{
        status?: Readonly<{
            machineOnline?: boolean;
            runnerActive?: boolean;
            activity?: string;
            canTakeOverDirect?: boolean;
            canTakeOverPersist?: boolean;
        }> | null;
    }>;
    directSessionTakeover: Readonly<{
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

function buildFooterEntry(input: Input): DirectControlFooterState {
    const status = input.directSessionRuntime.status;
    return {
        machineOnline: status?.machineOnline ?? true,
        runnerActive: status?.runnerActive ?? false,
        activity: normalizeDirectControlActivity(status?.activity),
        canTakeOverDirect: status?.canTakeOverDirect ?? false,
        canTakeOverPersist: status?.canTakeOverPersist ?? false,
        takeoverInFlight: input.directSessionTakeover.takeoverInFlight,
        onRequestTakeOverDirect: (status?.canTakeOverDirect ?? false)
            ? () => { void input.directSessionTakeover.requestTakeover('direct'); }
            : undefined,
        onRequestTakeOverPersist: (status?.canTakeOverPersist ?? false)
            ? () => { void input.directSessionTakeover.requestTakeover('persisted'); }
            : undefined,
    };
}

export function resolveSessionViewDirectControlFooter(input: Input): SessionViewDirectControlFooter | null {
    if (input.isHiddenSystemSessionSession) {
        return null;
    }
    if (!input.directSessionLink) {
        return null;
    }

    return buildFooterEntry(input);
}
