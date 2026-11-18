import type { PluginAgentExternalLinkedTakeoverWriterSafetyV1 } from '@happier-dev/protocol/plugins/backendDefinitionV1';

import type { ChatFooterExternalControlState } from '@/components/sessions/transcript/ChatFooter';
import {
    chatFooterExternalControlOffersWayForward,
    resolveChatFooterExternalControlActions,
} from '@/components/sessions/transcript/chatFooterExternalControlActions';
import type { ExternalSessionIdentityPresentation } from '@/components/sessions/presentation/externalSessionIdentityPresentation';
import {
    externalAgentStateNeedsAttention,
    type ExternalSessionRuntimePresentation,
} from '@/components/sessions/presentation/externalSessionRuntimePresentation';

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
        writerSafety?: PluginAgentExternalLinkedTakeoverWriterSafetyV1;
        takeoverInFlight: 'direct' | 'persisted' | null;
        takeoverPreflightInFlight: boolean;
        requestTakeoverPreflight: () => void | Promise<void | boolean>;
    }>;
    externalSessionMaterialize?: Readonly<{
        materializeInFlight: boolean;
        requestMaterialize: () => void | Promise<unknown>;
    }>;
    externalSessionContinueInNewSession?: Readonly<{
        available: boolean;
        inFlight: boolean;
        requestContinue: () => void | Promise<void>;
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

function createContinueInNewSessionCallback(
    input: Input,
): () => Promise<void> {
    return async () => {
        await input.externalSessionContinueInNewSession?.requestContinue();
    };
}

/**
 * Continue in a new session replaces the takeover dead end: the status is known, the outside Agent is
 * not running (a running one keeps Re-check, since takeover may open once it stops) and neither
 * takeover mode is available. Derived from the takeover facts alone, never from the Agent's id.
 */
function resolveContinueInNewSession(
    input: Input,
    status: Input['externalSessionRuntime']['status'],
): ExternalControlFooterState['continueInNewSession'] {
    const owner = input.externalSessionContinueInNewSession;
    if (!owner || (!owner.available && !owner.inFlight)) return null;
    if (input.externalSessionOperationBlocksNewOperation === true) return null;
    if (status == null || status.runnerActive === true) return null;
    if (status.canTakeOverDirect === true || status.canTakeOverPersist === true) return null;
    return {
        requestEnabled:
            input.hasWriteAccess === true
            && status.machineOnline === true
            && !owner.inFlight
            && input.externalSessionMaterialize?.materializeInFlight !== true,
        inFlight: owner.inFlight,
        onRequest: createContinueInNewSessionCallback(input),
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
    const externalAgentState = input.externalSessionRuntimePresentation?.externalAgent.state ?? 'unknown';
    const footer: ExternalControlFooterState = {
        externalAgentPresentation: {
            state: externalAgentState,
            needsAttention: externalAgentStateNeedsAttention(externalAgentState),
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
            input.externalSessionTakeover.writerSafety === 'native_prevention'
            && input.externalSessionOperationBlocksNewOperation !== true
                ? createTakeoverPreflightCallback(input)
                : undefined,
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
        continueInNewSession: resolveContinueInNewSession(input, status),
    };
    // The row speaks only with a way forward (or the reader's request in flight): where the Session runs is
    // already in the header, and the Session's notice then speaks alone (one message per state).
    return chatFooterExternalControlOffersWayForward(resolveChatFooterExternalControlActions(footer)) ? footer : null;
}
