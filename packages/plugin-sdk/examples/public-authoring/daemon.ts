import type {
    PluginActionHandler,
    PluginApiV1,
    PluginHookHandler,
    PluginLifecycleHandler,
} from '@happier-dev/plugin-sdk';
import { defineAcpBackend } from '@happier-dev/plugin-sdk/agent-runtime';

type ReviewSummaryInput = Readonly<{
    transcript: string;
    maxBullets: number;
}>;

type ReviewSummaryData = Readonly<{
    summary: string;
    bullets: readonly string[];
}>;

const DEFAULT_MAX_BULLETS = 3;

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

export const runReviewSummary: PluginActionHandler<unknown, ReviewSummaryData> = (request) => {
    const input = readReviewSummaryInput(request.input);
    const source = input.transcript || 'No transcript was provided.';
    const firstSentence = source.split(/[.!?]\s/u)[0]?.trim() || source;

    return {
        ok: true,
        data: {
            summary: firstSentence,
            bullets: source
                .split(/\n+/u)
                .map((line) => line.trim())
                .filter(Boolean)
                .slice(0, input.maxBullets),
        },
    };
};

export const observeAgentResponse: PluginHookHandler<'agent.response.after'> = async (
    payload,
    context,
) => {
    await Promise.resolve();
    void payload;
    void context.signal;
};

export const recordActivation: PluginLifecycleHandler = async (request) => {
    await Promise.resolve();
    void request.pluginId;
    void request.generation;
};

export function activate(api: PluginApiV1): void {
    api.registerAction({
        id: 'examples.publicSdk.reviewSummary',
        handler: runReviewSummary,
    });

    api.registerHook({
        hookId: 'agent.response.after',
        category: 'lifecycle',
        scope: 'agent',
        executionKind: 'observe',
        priority: 50,
        handler: observeAgentResponse,
    });

    api.registerLifecycleHandler({
        id: 'examples.publicSdk.activation',
        event: 'activated',
        priority: 10,
        handler: recordActivation,
    });

    api.registerAgentRuntime({
        agentId: 'examples.publicSdk.reviewAcp',
        create: () => defineAcpBackend({
            backendId: 'examples.publicSdk.reviewAcp',
            transport: {
                kind: 'stdio',
                launch: {
                    kind: 'executable',
                    command: 'acme-review-agent',
                    args: ['acp'],
                },
                timeouts: {
                    initMs: 10_000,
                    idleMs: 120_000,
                },
            },
            ux: {
                title: 'Acme Review ACP',
                defaultMode: 'review',
            },
            capabilities: {
                supportsResume: true,
                supportsStreaming: true,
                supportsToolUse: true,
                supportsPermissionRequests: true,
            },
            mcp: {
                policy: 'drop',
            },
        }),
    });
}
