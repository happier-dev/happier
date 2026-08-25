export type SessionGoalExecutionCapabilities = Readonly<{
    canSet: boolean;
    canClear: boolean;
}>;

type SessionGoalRuntimeLike = Readonly<{
    active?: boolean;
    agentState?: Readonly<{
        capabilities?: Readonly<{
            sessionGoalSetSupported?: boolean | null;
            sessionGoalClearSupported?: boolean | null;
        }> | null;
    }> | null;
}>;

type SessionGoalMachineLike = Readonly<{
    metadata?: Readonly<{
        daemonSessionGoalControlsSupported?: boolean | null;
    }> | null;
}> | null | undefined;

const NO_SESSION_GOAL_EXECUTION_CAPABILITIES: SessionGoalExecutionCapabilities = {
    canSet: false,
    canClear: false,
};

export function resolveMachineSessionGoalExecutionCapabilities(
    machine: SessionGoalMachineLike,
): SessionGoalExecutionCapabilities {
    if (machine?.metadata?.daemonSessionGoalControlsSupported !== true) {
        return NO_SESSION_GOAL_EXECUTION_CAPABILITIES;
    }
    return { canSet: true, canClear: true };
}

export function resolveSessionGoalExecutionCapabilities(input: Readonly<{
    session: SessionGoalRuntimeLike;
    machine?: SessionGoalMachineLike;
}>): SessionGoalExecutionCapabilities {
    if (input.session.active !== true) {
        return resolveMachineSessionGoalExecutionCapabilities(input.machine);
    }
    const capabilities = input.session.agentState?.capabilities;
    return {
        canSet: capabilities?.sessionGoalSetSupported === true,
        canClear: capabilities?.sessionGoalClearSupported === true,
    };
}
