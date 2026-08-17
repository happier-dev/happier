import type {
    AgentAcpRuntimeOptions,
    AgentRuntimeFactory,
} from '@happier-dev/plugin-sdk/agents/runtime';

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
            });
        },
    },
});
