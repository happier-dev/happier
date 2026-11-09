import type {
    AgentAcpInFlightSteerDefinition,
    AgentAcpRuntimeOptions,
    AgentRuntimeFactory,
} from '@happier-dev/plugin-sdk/agents/runtime';

const reviewSteer: AgentAcpInFlightSteerDefinition = {
    method: 'review/steer',
    isSupported: capabilities => capabilities !== null && typeof capabilities === 'object'
        && !Array.isArray(capabilities) && 'reviewSteering' in capabilities && capabilities.reviewSteering === true,
    buildParams: ({ providerSessionId, inputIds, input }) => ({
        sessionId: providerSessionId, inputId: inputIds[0], text: input.text,
    }),
    isAccepted: response => response === 'absorbed',
    isRejected: response => response === 'dropped',
};

const reviewAcpTransport = {
    kind: 'stdio',
    executable: { kind: 'systemTool', id: 'acme-review-agent' },
    args: ['acp'],
    timeouts: {
        initializeMs: 10_000,
        idleMs: 120_000,
    },
} as const satisfies AgentAcpRuntimeOptions['transport'];

export const createReviewAgentRuntime: AgentRuntimeFactory = () => ({
    sessions: {
        open(request, context) {
            return context.protocols.acp.open(request, {
                transport: reviewAcpTransport,
                definition: {
                    mcp: { policy: 'drop' },
                    delivery: { steer: reviewSteer },
                    // Prefer the current native id, accepting its older spelling
                    // only when this Session advertises it. No match refuses open.
                    permissionModeMapping: {
                        default: null,
                        'safe-yolo': ['review-auto', 'review-code'],
                        'read-only': ['review-ask'],
                    },
                },
            });
        },
    },
});
