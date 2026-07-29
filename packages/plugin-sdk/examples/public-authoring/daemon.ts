import type {
    PluginApi,
} from '@happier-dev/plugin-sdk';
import type {
    ActionHandler,
    HookHandler,
    PluginConnectedAccountAuthenticationModeRuntime,
} from '@happier-dev/plugin-sdk/runtime';
import type {
    AgentAcpRuntimeOptions,
    AgentRuntimeFactory,
} from '@happier-dev/plugin-sdk/agent-runtime';

type ReviewSummaryInput = Readonly<{
    transcript: string;
    maxBullets: number;
}>;

type ReviewSummaryData = Readonly<{
    summary: string;
    bullets: readonly string[];
}>;

const DEFAULT_MAX_BULLETS = 3;

export const manualConnectedAccountAuthenticationMode = {
    kind: 'manual',
    async complete() {
        return {
            status: 'unavailable',
            diagnostic: {
                code: 'public_authoring_manual_auth_unavailable',
                severity: 'warning',
                message: 'The public-authoring fixture does not connect a real account.',
            },
        };
    },
} satisfies PluginConnectedAccountAuthenticationModeRuntime;

function readReviewSummaryInput(input: unknown): ReviewSummaryInput {
    const record = typeof input === 'object' && input !== null
        ? input as Readonly<Record<string, unknown>>
        : {};
    const transcript = typeof record.transcript === 'string' ? record.transcript.trim() : '';
    const maxBullets = typeof record.maxBullets === 'number' && Number.isInteger(record.maxBullets)
        ? Math.min(Math.max(record.maxBullets, 1), 8)
        : DEFAULT_MAX_BULLETS;

    return { transcript, maxBullets };
}

export const runReviewSummary: ActionHandler = async (value, context) => {
    await context.ui.status.set('review-summary', 'Summarizing review…');
    const input = readReviewSummaryInput(value);
    const source = input.transcript || 'No transcript was provided.';
    const firstSentence = source.split(/[.!?]\s/u)[0]?.trim() || source;

    try {
        return {
            summary: firstSentence,
            bullets: source
                .split(/\n+/u)
                .map((line) => line.trim())
                .filter(Boolean)
                .slice(0, input.maxBullets),
        };
    } finally {
        await context.ui.status.set('review-summary', null);
    }
};

export const observeSessionSpawned: HookHandler = async (
    payload,
    context,
) => {
    await Promise.resolve();
    void payload;
    void context.signal;
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
            });
        },
    },
});

export function activate(api: PluginApi): void {
    api.actions.register('review-summary', runReviewSummary);
    api.hooks.register('session-spawned', observeSessionSpawned);
    api.agents.register('review-agent', createReviewAgentRuntime);
};
