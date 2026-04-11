import nacl from 'tweetnacl';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_SERVER_URL = 'http://127.0.0.1:53288';
const DEFAULT_SOURCE = 'local_demo_seed';

const DEMO_SESSIONS = Object.freeze([
    { key: 'claude-ops', tag: 'usage-demo-claude-ops', title: 'Claude operations review' },
    { key: 'codex-build', tag: 'usage-demo-codex-build', title: 'Codex build sprint' },
    { key: 'opencode-docs', tag: 'usage-demo-opencode-docs', title: 'OpenCode docs pass' },
    { key: 'acp-research', tag: 'usage-demo-acp-research', title: 'ACP research lane' },
    { key: 'mixed-launch', tag: 'usage-demo-mixed-launch', title: 'Launch readiness' },
    { key: 'mixed-polish', tag: 'usage-demo-mixed-polish', title: 'Polish and fixes' },
]);

const DEMO_EVENTS = Object.freeze([
    createEvent('claude-ops', '2025-11-14T09:00:00.000Z', {
        providerId: 'anthropic',
        backendMode: 'claude-sdk',
        modelId: 'claude-3.5-sonnet',
        projectKey: 'workspace-sync',
        workspaceId: 'workspace-core',
        tokens: 920_000,
        reportedUsd: 14.2,
    }),
    createEvent('codex-build', '2025-12-03T08:00:00.000Z', {
        providerId: 'openai',
        backendMode: 'codex-app-server',
        modelId: 'gpt-5.4',
        projectKey: 'build-automation',
        workspaceId: 'workspace-release',
        tokens: 1_450_000,
        estimatedUsd: 24.8,
    }),
    createEvent('claude-ops', '2026-01-17T10:00:00.000Z', {
        providerId: 'anthropic',
        backendMode: 'claude-sdk',
        modelId: 'claude-3.7-sonnet',
        projectKey: 'workspace-sync',
        workspaceId: 'workspace-core',
        tokens: 1_180_000,
        reportedUsd: 19.6,
    }),
    createEvent('acp-research', '2026-02-09T14:00:00.000Z', {
        providerId: 'google',
        backendMode: 'acp-remote',
        modelId: 'gemini-2.5-pro',
        projectKey: 'agent-research',
        workspaceId: 'workspace-labs',
        tokens: 760_000,
        estimatedUsd: 8.1,
    }),
    createEvent('opencode-docs', '2026-02-27T07:00:00.000Z', {
        providerId: 'opencode',
        backendMode: 'opencode-server',
        modelId: 'gpt-4.1',
        projectKey: 'docs-rewrite',
        workspaceId: 'workspace-docs',
        tokens: 580_000,
        reportedUsd: 6.4,
    }),
    createEvent('codex-build', '2026-03-10T08:00:00.000Z', {
        providerId: 'openai',
        backendMode: 'codex-app-server',
        modelId: 'gpt-5.4',
        projectKey: 'build-automation',
        workspaceId: 'workspace-release',
        tokens: 4_400_000,
        estimatedUsd: 61.4,
    }),
    createEvent('claude-ops', '2026-03-12T08:00:00.000Z', {
        providerId: 'anthropic',
        backendMode: 'claude-sdk',
        modelId: 'claude-3.7-sonnet',
        projectKey: 'workspace-sync',
        workspaceId: 'workspace-core',
        tokens: 2_980_000,
        reportedUsd: 39.2,
    }),
    createEvent('acp-research', '2026-03-15T09:00:00.000Z', {
        providerId: 'google',
        backendMode: 'acp-remote',
        modelId: 'gemini-2.5-pro',
        projectKey: 'agent-research',
        workspaceId: 'workspace-labs',
        tokens: 1_950_000,
        estimatedUsd: 17.3,
    }),
    createEvent('opencode-docs', '2026-03-18T15:00:00.000Z', {
        providerId: 'opencode',
        backendMode: 'opencode-server',
        modelId: 'gpt-4.1',
        projectKey: 'docs-rewrite',
        workspaceId: 'workspace-docs',
        tokens: 1_160_000,
        reportedUsd: 11.8,
    }),
    createEvent('mixed-launch', '2026-03-22T08:00:00.000Z', {
        providerId: 'openai',
        backendMode: 'codex-app-server',
        modelId: 'o3',
        projectKey: 'launch-readiness',
        workspaceId: 'workspace-release',
        tokens: 1_220_000,
        estimatedUsd: 26.4,
    }),
    createEvent('mixed-polish', '2026-03-25T07:00:00.000Z', {
        providerId: 'anthropic',
        backendMode: 'claude-sdk',
        modelId: 'claude-3.7-sonnet',
        projectKey: 'desktop-polish',
        workspaceId: 'workspace-product',
        tokens: 1_540_000,
        reportedUsd: 18.9,
    }),
    createEvent('mixed-polish', '2026-03-27T07:00:00.000Z', {
        providerId: 'openai',
        backendMode: 'codex-app-server',
        modelId: 'gpt-5.4',
        projectKey: 'desktop-polish',
        workspaceId: 'workspace-product',
        tokens: 2_240_000,
        estimatedUsd: 31.2,
    }),
    createEvent('codex-build', '2026-03-31T08:00:00.000Z', {
        providerId: 'openai',
        backendMode: 'codex-app-server',
        modelId: 'gpt-5.4',
        projectKey: 'build-automation',
        workspaceId: 'workspace-release',
        tokens: 3_820_000,
        estimatedUsd: 54.1,
    }),
    createEvent('codex-build', '2026-04-02T08:00:00.000Z', {
        providerId: 'openai',
        backendMode: 'codex-app-server',
        modelId: 'gpt-5.4',
        projectKey: 'build-automation',
        workspaceId: 'workspace-release',
        tokens: 8_420_000,
        estimatedUsd: 117.3,
    }),
    createEvent('claude-ops', '2026-04-03T09:00:00.000Z', {
        providerId: 'anthropic',
        backendMode: 'claude-sdk',
        modelId: 'claude-3.7-sonnet',
        projectKey: 'workspace-sync',
        workspaceId: 'workspace-core',
        tokens: 4_880_000,
        reportedUsd: 62.7,
    }),
    createEvent('opencode-docs', '2026-04-05T07:00:00.000Z', {
        providerId: 'opencode',
        backendMode: 'opencode-server',
        modelId: 'gpt-4.1',
        projectKey: 'docs-rewrite',
        workspaceId: 'workspace-docs',
        tokens: 1_980_000,
        reportedUsd: 20.9,
    }),
    createEvent('mixed-polish', '2026-04-08T07:00:00.000Z', {
        providerId: 'openai',
        backendMode: 'codex-app-server',
        modelId: 'gpt-5.4',
        projectKey: 'desktop-polish',
        workspaceId: 'workspace-product',
        tokens: 12_300_000,
        estimatedUsd: 171.2,
    }),
    createEvent('acp-research', '2026-04-09T08:00:00.000Z', {
        providerId: 'google',
        backendMode: 'acp-remote',
        modelId: 'gemini-2.5-pro',
        projectKey: 'agent-research',
        workspaceId: 'workspace-labs',
        tokens: 6_920_000,
        estimatedUsd: 64.8,
    }),
    createEvent('mixed-launch', '2026-04-10T08:00:00.000Z', {
        providerId: 'openai',
        backendMode: 'codex-app-server',
        modelId: 'gpt-5.4',
        projectKey: 'launch-readiness',
        workspaceId: 'workspace-release',
        tokens: 28_600_000,
        estimatedUsd: 398.6,
    }),
    createEvent('mixed-launch', '2026-04-10T15:00:00.000Z', {
        providerId: 'anthropic',
        backendMode: 'claude-sdk',
        modelId: 'claude-3.7-sonnet',
        projectKey: 'launch-readiness',
        workspaceId: 'workspace-release',
        tokens: 5_220_000,
        reportedUsd: 68.4,
    }),
    createEvent('codex-build', '2026-04-11T07:00:00.000Z', {
        providerId: 'openai',
        backendMode: 'codex-app-server',
        modelId: 'gpt-5.4',
        projectKey: 'build-automation',
        workspaceId: 'workspace-release',
        tokens: 111_900_000,
        estimatedUsd: 1_557.4,
    }),
    createEvent('opencode-docs', '2026-04-11T08:00:00.000Z', {
        providerId: 'opencode',
        backendMode: 'opencode-server',
        modelId: 'gpt-4.1',
        projectKey: 'docs-rewrite',
        workspaceId: 'workspace-docs',
        tokens: 3_120_000,
        reportedUsd: 32.1,
    }),
    createEvent('claude-ops', '2026-04-11T09:00:00.000Z', {
        providerId: 'anthropic',
        backendMode: 'claude-sdk',
        modelId: 'claude-3.7-sonnet',
        projectKey: 'workspace-sync',
        workspaceId: 'workspace-core',
        tokens: 7_880_000,
        reportedUsd: 104.7,
    }),
]);

function createEvent(sessionKey, iso, input) {
    const observedAt = Date.parse(iso);
    const total = input.tokens;
    const inputTokens = Math.round(total * 0.62);
    const outputTokens = Math.round(total * 0.28);
    const reasoningTokens = total - inputTokens - outputTokens;
    return {
        sessionKey,
        observedAt,
        iso,
        providerId: input.providerId,
        backendMode: input.backendMode,
        modelId: input.modelId,
        projectKey: input.projectKey,
        workspaceId: input.workspaceId,
        tokens: {
            input: inputTokens,
            output: outputTokens,
            reasoning: reasoningTokens,
            cacheRead: 0,
            cacheWrite: 0,
            total,
        },
        cost: {
            reportedUsd: input.reportedUsd ?? 0,
            estimatedUsd: input.estimatedUsd ?? 0,
            currency: 'USD',
            billingContext: 'api_usage',
            costSource: input.reportedUsd != null && input.reportedUsd > 0 ? 'provider_reported' : 'pricing_estimate',
        },
    };
}

function parseArgs(argv) {
    const out = new Map();
    for (const arg of argv) {
        if (!arg.startsWith('--')) continue;
        const [key, value] = arg.split('=');
        out.set(key, value ?? '1');
    }
    return out;
}

function parseBackupSecretKey(formattedKey) {
    const cleaned = formattedKey
        .toUpperCase()
        .replace(/0/g, 'O')
        .replace(/1/g, 'I')
        .replace(/8/g, 'B')
        .replace(/9/g, 'G')
        .replace(/[^A-Z2-7]/g, '');

    let buffer = 0;
    let bufferLength = 0;
    const bytes = [];

    for (const char of cleaned) {
        const value = BASE32_ALPHABET.indexOf(char);
        if (value === -1) {
            throw new Error(`Invalid backup key character: ${char}`);
        }

        buffer = (buffer << 5) | value;
        bufferLength += 5;

        if (bufferLength >= 8) {
            bufferLength -= 8;
            bytes.push((buffer >> bufferLength) & 0xff);
        }
    }

    const out = Uint8Array.from(bytes);
    if (out.length !== 32) {
        throw new Error(`Invalid backup key length: expected 32 bytes, got ${out.length}`);
    }
    return out;
}

async function authenticate(serverUrl, devKey) {
    const seed = parseBackupSecretKey(devKey);
    const pair = nacl.sign.keyPair.fromSeed(seed);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const signature = nacl.sign.detached(challenge, pair.secretKey);

    const res = await fetch(`${serverUrl}/v1/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            publicKey: Buffer.from(pair.publicKey).toString('base64'),
            challenge: Buffer.from(challenge).toString('base64'),
            signature: Buffer.from(signature).toString('base64'),
        }),
    });

    if (!res.ok) {
        throw new Error(`Authentication failed (${res.status}): ${await res.text()}`);
    }

    const data = await res.json();
    if (typeof data?.token !== 'string' || data.token.length === 0) {
        throw new Error('Authentication response did not include a token');
    }
    return data.token;
}

async function createOrLoadSession(serverUrl, token, session) {
    const metadata = Buffer.from(JSON.stringify({
        v: 1,
        seed: DEFAULT_SOURCE,
        key: session.key,
        title: session.title,
        createdAt: Date.now(),
    }), 'utf8').toString('base64');

    const res = await fetch(`${serverUrl}/v1/sessions`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            tag: session.tag,
            metadata,
            agentState: null,
        }),
    });

    if (!res.ok) {
        throw new Error(`Failed to create/load session ${session.tag} (${res.status}): ${await res.text()}`);
    }

    const data = await res.json();
    const sessionId = data?.session?.id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error(`Invalid session id returned for ${session.tag}`);
    }
    return sessionId;
}

async function writeUsageEvent(serverUrl, token, sessionId, event) {
    const externalKey = `${DEFAULT_SOURCE}:${event.sessionKey}:${event.observedAt}:${event.providerId}:${event.modelId}`;
    const res = await fetch(`${serverUrl}/v2/usage-events`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            sessionId,
            observedAt: event.observedAt,
            providerId: event.providerId,
            backendMode: event.backendMode,
            modelId: event.modelId,
            projectKey: event.projectKey,
            workspaceId: event.workspaceId,
            machineId: null,
            source: DEFAULT_SOURCE,
            scope: 'turn_delta',
            externalKey,
            turnId: externalKey,
            isCumulative: false,
            tokens: event.tokens,
            cost: event.cost,
            context: {
                usedTokens: Math.round(event.tokens.total * 0.42),
                windowTokens: Math.round(event.tokens.total * 0.8),
            },
            metadata: {
                seed: DEFAULT_SOURCE,
                seededAt: Date.now(),
                iso: event.iso,
            },
        }),
    });

    if (!res.ok) {
        throw new Error(`Failed to write usage event ${externalKey} (${res.status}): ${await res.text()}`);
    }
}

async function querySnapshot(serverUrl, token, request) {
    const res = await fetch(`${serverUrl}/v2/usage/query`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify(request),
    });

    if (!res.ok) {
        throw new Error(`Failed to query usage snapshot (${res.status}): ${await res.text()}`);
    }

    return await res.json();
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const serverUrl = (args.get('--server-url') ?? DEFAULT_SERVER_URL).trim().replace(/\/$/, '');
    const devKey = (args.get('--dev-key') ?? process.env.HAPPIER_DEV_KEY ?? '').trim();

    if (!devKey) {
        throw new Error('Missing dev key. Pass --dev-key=... or set HAPPIER_DEV_KEY.');
    }

    const token = await authenticate(serverUrl, devKey);
    const sessionMap = new Map();

    for (const session of DEMO_SESSIONS) {
        sessionMap.set(session.key, await createOrLoadSession(serverUrl, token, session));
    }

    for (const event of DEMO_EVENTS) {
        const sessionId = sessionMap.get(event.sessionKey);
        if (typeof sessionId !== 'string') {
            throw new Error(`Missing session for ${event.sessionKey}`);
        }
        await writeUsageEvent(serverUrl, token, sessionId, event);
    }

    const thirtyDay = await querySnapshot(serverUrl, token, {
        granularity: 'day',
        includeInsights: true,
        includeActivity: true,
        includeLeaders: true,
        includeSeries: true,
    });
    const yearly = await querySnapshot(serverUrl, token, {
        granularity: 'month',
        includeInsights: true,
        includeActivity: true,
        includeLeaders: true,
        includeModelTimeline: true,
        includeSeries: true,
    });

    console.log(JSON.stringify({
        ok: true,
        serverUrl,
        source: DEFAULT_SOURCE,
        sessionCount: DEMO_SESSIONS.length,
        eventCount: DEMO_EVENTS.length,
        thirtyDayTotals: thirtyDay?.totals ?? null,
        thirtyDayInsights: thirtyDay?.insights ?? null,
        yearlyTotals: yearly?.totals ?? null,
        yearlyInsights: yearly?.insights ?? null,
    }, null, 2));
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
