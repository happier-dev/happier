import type { ChatFooterExternalControlState } from '@/components/sessions/transcript/ChatFooter';
import type { ExternalSessionIdentityPresentation } from '@/components/sessions/presentation/externalSessionIdentityPresentation';
import type { ExternalSessionRuntimePresentation } from '@/components/sessions/presentation/externalSessionRuntimePresentation';

export type SessionViewExternalControlFooter = ChatFooterExternalControlState;

type ExternalControlFooterState = NonNullable<SessionViewExternalControlFooter>;

type Input = Readonly<{
    externalSessionOperationRunning?: boolean;
    externalSessionOperationBlocksNewOperation?: boolean;
    externalSessionLink: Readonly<{ machineId: string }> | null;
    externalSessionRuntimePresentation: Readonly<{
        externalAgent: Pick<
            ExternalSessionRuntimePresentation['externalAgent'],
            'state' | 'labelKey'
        >;
    }> | null;
    externalSessionIdentity: Pick<
        ExternalSessionIdentityPresentation,
        'agentLabel' | 'machineLabel'
    >;
    materializeNeeded?: boolean;
    hasWriteAccess?: boolean;
    externalSessionRuntime: Readonly<{
        status?: Readonly<{
            machineOnline?: boolean;
            runnerActive?: boolean;
            activity?: string;
            canTakeOverDirect?: boolean;
            canTakeOverPersist?: boolean;
            trustedPid?: number | null;
        }> | null;
    }>;
    externalSessionTakeover: Readonly<{
        takeoverInFlight: 'direct' | 'persisted' | null;
        takeoverPreflightInFlight: boolean;
        requestTakeoverPreflight: () => void | Promise<void | boolean>;
    }>;
    externalSessionMaterialize?: Readonly<{
        materializeInFlight: boolean;
        requestMaterialize: () => void | Promise<void | boolean>;
    }>;
    isHiddenSystemSessionSession: boolean;
}>;

function normalizeExternalControlActivity(value: string | null | undefined): ExternalControlFooterState['activity'] {
    if (value === 'running' || value === 'active_recently' || value === 'idle' || value === 'unknown') {
        return value;
    }
    return 'unknown';
}

function createTakeoverPreflightCallback(
    input: Input,
): () => Promise<void> {
    return async () => {
        await input.externalSessionTakeover.requestTakeoverPreflight();
    };
}

function createMaterializeCallback(
    input: Input,
): () => Promise<void> {
    return async () => {
        await input.externalSessionMaterialize?.requestMaterialize();
    };
}

export function resolveSessionViewExternalControlFooter(input: Input): SessionViewExternalControlFooter | null {
    if (input.isHiddenSystemSessionSession || input.externalSessionOperationRunning === true) {
        return null;
    }
    if (!input.externalSessionLink) {
        return null;
    }

    const status = input.externalSessionRuntime.status;
    return {
        externalAgentPresentation: {
            state: input.externalSessionRuntimePresentation?.externalAgent.state ?? 'unknown',
            labelKey:
                input.externalSessionRuntimePresentation?.externalAgent.labelKey
                ?? 'status.externalStatusUnknown',
            agentLabel: input.externalSessionIdentity.agentLabel,
            machineLabel: input.externalSessionIdentity.machineLabel,
        },
        statusKnown: status != null,
        machineOnline: status?.machineOnline ?? false,
        runnerActive: status?.runnerActive ?? false,
        trustedPid:
            typeof status?.trustedPid === 'number'
            && Number.isSafeInteger(status.trustedPid)
            && status.trustedPid > 0
                ? status.trustedPid
                : null,
        activity: normalizeExternalControlActivity(status?.activity),
        canTakeOverDirect: status?.canTakeOverDirect === true,
        canTakeOverPersist: status?.canTakeOverPersist === true,
        takeoverPreflightInFlight: input.externalSessionTakeover.takeoverPreflightInFlight,
        takeoverInFlight: input.externalSessionTakeover.takeoverInFlight,
        onRequestTakeoverPreflight:
            input.externalSessionOperationBlocksNewOperation === true
                ? undefined
                : createTakeoverPreflightCallback(input),
        materialize:
            input.materializeNeeded === true && input.externalSessionMaterialize
                && input.externalSessionOperationBlocksNewOperation !== true
                ? {
                    requestEnabled:
                        input.hasWriteAccess === true
                        && (status == null || status.machineOnline === true)
                        && !input.externalSessionMaterialize.materializeInFlight,
                    inFlight: input.externalSessionMaterialize.materializeInFlight,
                    onRequest: createMaterializeCallback(input),
                }
                : null,
    };
}
