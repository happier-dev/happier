import type { z } from '../../zodRuntimePolicy.js';
import type { SessionTargetV1 } from '../../actions/sessionTargetV1.js';
import type { SessionPermissionModeSetInputSchema, SessionModelSetInputSchema } from '../../actions/specs/session/state.js';
import type { SessionConfigOptionSetInputSchema, SessionConnectedServicesAuthSetInputSchema } from '../../actions/specs/session/interaction.js';
import type { SessionCapabilitiesSetInputV1 } from '../../actions/specs/sessionCapabilities.js';
import type { SessionAgentTransitionInputV1, SessionAgentTransitionRequestV1 } from '../agentTransition.js';

type Target<T extends SessionTargetV1> = Readonly<{ sessionId: T }>;
type PermissionInput = z.input<typeof SessionPermissionModeSetInputSchema>;
type ModelInput = z.input<typeof SessionModelSetInputSchema>;
type ConfigInput = z.input<typeof SessionConfigOptionSetInputSchema>;
type ConnectedAuthInput = z.infer<typeof SessionConnectedServicesAuthSetInputSchema>;

export function buildExistingSessionPermissionModeActionInput<T extends SessionTargetV1>(
    params: Target<T> & Pick<PermissionInput, 'permissionMode' | 'applyTiming'>,
): typeof params {
    return { ...params };
}

/** A synthetic default clears the override; an advertised default remains a real mode. */
export function buildExistingSessionModeActionInput<T extends SessionTargetV1>(
    params: Target<T> & Readonly<{ modeId: string; availableModeIds?: readonly string[] }>,
): { sessionId: T; modeId: string } {
    const normalized = typeof params.modeId === 'string' ? params.modeId.trim() : '';
    return {
        sessionId: params.sessionId,
        modeId: normalized === 'default' && params.availableModeIds !== undefined && !params.availableModeIds.includes('default')
            ? '' : normalized,
    };
}

export function buildExistingSessionConfigOptionActionInput<T extends SessionTargetV1>(
    params: Target<T> & Pick<ConfigInput, 'configId' | 'valueId'>,
): typeof params {
    return { ...params };
}

export function buildExistingSessionModelActionInput<T extends SessionTargetV1>(
    params: Target<T> & Pick<ModelInput, 'modelId' | 'providerConnectionId' | 'teamCredentialModel' | 'teamVisibilityGrantConsent' | 'applyTiming' | 'captureBefore' | 'expected'>,
): typeof params {
    return { ...params };
}

export function buildExistingSessionCapabilitiesActionInput<T extends SessionTargetV1>(
    params: Target<T> & Omit<SessionCapabilitiesSetInputV1, 'sessionId'>,
): typeof params {
    return { ...params };
}

export function buildExistingSessionConnectedServicesAuthActionInput<T extends SessionTargetV1>(
    params: Target<T> & Omit<ConnectedAuthInput, 'sessionId'>,
): typeof params {
    return { ...params };
}

/** The Action owns the request version; its operand is the unversioned request body. */
export function buildExistingSessionAgentTransitionActionInput<T extends SessionTargetV1>(
    params: Target<T> & Omit<SessionAgentTransitionRequestV1, 'v' | 'sessionId'> & { input: SessionAgentTransitionInputV1 },
): typeof params;
export function buildExistingSessionAgentTransitionActionInput<T extends SessionTargetV1>(
    params: Target<T> & Omit<SessionAgentTransitionRequestV1, 'v' | 'sessionId'>,
): typeof params;
export function buildExistingSessionAgentTransitionActionInput<T extends SessionTargetV1>(
    params: Target<T> & Omit<SessionAgentTransitionRequestV1, 'v' | 'sessionId'>,
): typeof params {
    const { input, ...request } = params;
    return { ...request, ...(input === undefined ? {} : { input }) };
}
