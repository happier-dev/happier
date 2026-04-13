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
    { key: 'claude-product', tag: 'usage-demo-claude-product', title: 'Claude product planning' },
    { key: 'codex-refactor', tag: 'usage-demo-codex-refactor', title: 'Codex refactor lane' },
    { key: 'opencode-support', tag: 'usage-demo-opencode-support', title: 'OpenCode support triage' },
    { key: 'acp-evals', tag: 'usage-demo-acp-evals', title: 'ACP evaluation sweep' },
]);

const DEMO_EVENTS = Object.freeze(buildDemoEvents());

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

function buildDemoEvents() {
    const events = [];

    addRecurringSeries(events, {
        sessionKey: 'claude-ops',
        startDate: '2025-11-10',
        weeks: 22,
        weekdayOffset: 1,
        hourUtc: 9,
        providerId: 'anthropic',
        backendMode: 'claude-sdk',
        modelIds: ['claude-3.5-sonnet', 'claude-3.7-sonnet', 'claude-4.5-opus'],
        projectKey: 'workspace-sync',
        workspaceId: 'workspace-core',
        tokenBase: 920_000,
        tokenStep: 170_000,
        costMode: 'reported',
        costFactor: 0.0000156,
        cadence: 1,
    });

    addRecurringSeries(events, {
        sessionKey: 'claude-product',
        startDate: '2025-11-12',
        weeks: 18,
        weekdayOffset: 3,
        hourUtc: 14,
        providerId: 'anthropic',
        backendMode: 'claude-sdk',
        modelIds: ['claude-3.7-sonnet', 'claude-4.5-opus'],
        projectKey: 'product-strategy',
        workspaceId: 'workspace-product',
        tokenBase: 780_000,
        tokenStep: 120_000,
        costMode: 'reported',
        costFactor: 0.0000142,
        cadence: 2,
    });

    addRecurringSeries(events, {
        sessionKey: 'codex-build',
        startDate: '2025-11-11',
        weeks: 22,
        weekdayOffset: 2,
        hourUtc: 8,
        providerId: 'openai',
        backendMode: 'codex-app-server',
        modelIds: ['gpt-5.4', 'gpt-5.4', 'o3'],
        projectKey: 'build-automation',
        workspaceId: 'workspace-release',
        tokenBase: 1_260_000,
        tokenStep: 260_000,
        costMode: 'estimated',
        costFactor: 0.0000132,
        cadence: 1,
    });

    addRecurringSeries(events, {
        sessionKey: 'codex-refactor',
        startDate: '2025-12-01',
        weeks: 18,
        weekdayOffset: 4,
        hourUtc: 11,
        providerId: 'openai',
        backendMode: 'codex-app-server',
        modelIds: ['gpt-5.4', 'o3', 'gpt-5.4'],
        projectKey: 'core-refactor',
        workspaceId: 'workspace-platform',
        tokenBase: 980_000,
        tokenStep: 180_000,
        costMode: 'estimated',
        costFactor: 0.0000127,
        cadence: 1,
    });

    addRecurringSeries(events, {
        sessionKey: 'opencode-docs',
        startDate: '2025-11-13',
        weeks: 20,
        weekdayOffset: 4,
        hourUtc: 7,
        providerId: 'opencode',
        backendMode: 'opencode-server',
        modelIds: ['gpt-4.1', 'gpt-4.1', 'gpt-5.4-mini'],
        projectKey: 'docs-rewrite',
        workspaceId: 'workspace-docs',
        tokenBase: 540_000,
        tokenStep: 110_000,
        costMode: 'reported',
        costFactor: 0.0000106,
        cadence: 1,
    });

    addRecurringSeries(events, {
        sessionKey: 'opencode-support',
        startDate: '2025-12-08',
        weeks: 16,
        weekdayOffset: 0,
        hourUtc: 16,
        providerId: 'opencode',
        backendMode: 'opencode-server',
        modelIds: ['gpt-4.1', 'gpt-5.4-mini'],
        projectKey: 'support-triage',
        workspaceId: 'workspace-support',
        tokenBase: 420_000,
        tokenStep: 95_000,
        costMode: 'reported',
        costFactor: 0.0000108,
        cadence: 1,
    });

    addRecurringSeries(events, {
        sessionKey: 'acp-research',
        startDate: '2025-11-14',
        weeks: 20,
        weekdayOffset: 5,
        hourUtc: 10,
        providerId: 'google',
        backendMode: 'acp-remote',
        modelIds: ['gemini-2.5-pro', 'gemini-2.5-flash'],
        projectKey: 'agent-research',
        workspaceId: 'workspace-labs',
        tokenBase: 660_000,
        tokenStep: 150_000,
        costMode: 'estimated',
        costFactor: 0.0000098,
        cadence: 1,
    });

    addRecurringSeries(events, {
        sessionKey: 'acp-evals',
        startDate: '2025-12-02',
        weeks: 16,
        weekdayOffset: 1,
        hourUtc: 18,
        providerId: 'google',
        backendMode: 'acp-remote',
        modelIds: ['gemini-2.5-pro', 'gemini-2.5-pro', 'gemini-2.5-flash'],
        projectKey: 'evaluation-sweeps',
        workspaceId: 'workspace-labs',
        tokenBase: 510_000,
        tokenStep: 90_000,
        costMode: 'estimated',
        costFactor: 0.0000094,
        cadence: 1,
    });

    addRecurringSeries(events, {
        sessionKey: 'mixed-polish',
        startDate: '2026-01-06',
        weeks: 14,
        weekdayOffset: 2,
        hourUtc: 7,
        providerId: 'openai',
        backendMode: 'codex-app-server',
        modelIds: ['gpt-5.4', 'claude-3.7-sonnet'],
        projectKey: 'desktop-polish',
        workspaceId: 'workspace-product',
        tokenBase: 1_200_000,
        tokenStep: 240_000,
        costMode: 'estimated',
        costFactor: 0.0000129,
        cadence: 1,
    });

    addRecurringSeries(events, {
        sessionKey: 'mixed-launch',
        startDate: '2026-02-03',
        weeks: 10,
        weekdayOffset: 4,
        hourUtc: 8,
        providerId: 'openai',
        backendMode: 'codex-app-server',
        modelIds: ['gpt-5.4', 'o3', 'gpt-5.4'],
        projectKey: 'launch-readiness',
        workspaceId: 'workspace-release',
        tokenBase: 1_900_000,
        tokenStep: 420_000,
        costMode: 'estimated',
        costFactor: 0.0000139,
        cadence: 1,
    });

    addBurst(events, '2026-04-07T08:00:00.000Z', [
        {
            sessionKey: 'codex-build',
            providerId: 'openai',
            backendMode: 'codex-app-server',
            modelId: 'gpt-5.4',
            projectKey: 'build-automation',
            workspaceId: 'workspace-release',
            tokens: 18_400_000,
            estimatedUsd: 258.6,
        },
        {
            sessionKey: 'claude-ops',
            providerId: 'anthropic',
            backendMode: 'claude-sdk',
            modelId: 'claude-4.5-opus',
            projectKey: 'workspace-sync',
            workspaceId: 'workspace-core',
            tokens: 8_820_000,
            reportedUsd: 126.4,
        },
    ]);

    addBurst(events, '2026-04-08T07:00:00.000Z', [
        {
            sessionKey: 'opencode-support',
            providerId: 'opencode',
            backendMode: 'opencode-server',
            modelId: 'gpt-5.4-mini',
            projectKey: 'support-triage',
            workspaceId: 'workspace-support',
            tokens: 9_420_000,
            reportedUsd: 88.1,
        },
        {
            sessionKey: 'acp-evals',
            providerId: 'google',
            backendMode: 'acp-remote',
            modelId: 'gemini-2.5-pro',
            projectKey: 'evaluation-sweeps',
            workspaceId: 'workspace-labs',
            tokens: 7_680_000,
            estimatedUsd: 72.2,
        },
    ]);

    addBurst(events, '2026-04-10T08:00:00.000Z', [
        {
            sessionKey: 'mixed-launch',
            providerId: 'openai',
            backendMode: 'codex-app-server',
            modelId: 'gpt-5.4',
            projectKey: 'launch-readiness',
            workspaceId: 'workspace-release',
            tokens: 28_600_000,
            estimatedUsd: 398.6,
        },
        {
            sessionKey: 'mixed-launch',
            providerId: 'anthropic',
            backendMode: 'claude-sdk',
            modelId: 'claude-3.7-sonnet',
            projectKey: 'launch-readiness',
            workspaceId: 'workspace-release',
            tokens: 5_220_000,
            reportedUsd: 68.4,
        },
    ]);

    addBurst(events, '2026-04-11T07:00:00.000Z', [
        {
            sessionKey: 'codex-build',
            providerId: 'openai',
            backendMode: 'codex-app-server',
            modelId: 'gpt-5.4',
            projectKey: 'build-automation',
            workspaceId: 'workspace-release',
            tokens: 111_900_000,
            estimatedUsd: 1_557.4,
        },
        {
            sessionKey: 'opencode-docs',
            providerId: 'opencode',
            backendMode: 'opencode-server',
            modelId: 'gpt-4.1',
            projectKey: 'docs-rewrite',
            workspaceId: 'workspace-docs',
            tokens: 3_120_000,
            reportedUsd: 32.1,
        },
        {
            sessionKey: 'claude-ops',
            providerId: 'anthropic',
            backendMode: 'claude-sdk',
            modelId: 'claude-3.7-sonnet',
            projectKey: 'workspace-sync',
            workspaceId: 'workspace-core',
            tokens: 7_880_000,
            reportedUsd: 104.7,
        },
    ]);

    addBurst(events, '2026-04-12T09:00:00.000Z', [
        {
            sessionKey: 'acp-research',
            providerId: 'google',
            backendMode: 'acp-remote',
            modelId: 'gemini-2.5-flash',
            projectKey: 'agent-research',
            workspaceId: 'workspace-labs',
            tokens: 6_840_000,
            estimatedUsd: 61.3,
        },
        {
            sessionKey: 'opencode-docs',
            providerId: 'opencode',
            backendMode: 'opencode-server',
            modelId: 'gpt-5.4-mini',
            projectKey: 'docs-rewrite',
            workspaceId: 'workspace-docs',
            tokens: 5_260_000,
            reportedUsd: 51.4,
        },
        {
            sessionKey: 'codex-refactor',
            providerId: 'openai',
            backendMode: 'codex-app-server',
            modelId: 'o3',
            projectKey: 'core-refactor',
            workspaceId: 'workspace-platform',
            tokens: 13_200_000,
            estimatedUsd: 174.2,
        },
    ]);

    return events.sort((left, right) => left.observedAt - right.observedAt);
}

function addRecurringSeries(target, input) {
    const start = new Date(`${input.startDate}T00:00:00.000Z`);

    for (let weekIndex = 0; weekIndex < input.weeks; weekIndex += input.cadence ?? 1) {
        const observedAt = new Date(start.getTime());
        observedAt.setUTCDate(observedAt.getUTCDate() + weekIndex * 7 + input.weekdayOffset);
        observedAt.setUTCHours(input.hourUtc, 0, 0, 0);

        const modelId = input.modelIds[weekIndex % input.modelIds.length];
        const tokens = Math.round(input.tokenBase + weekIndex * input.tokenStep + (weekIndex % 3) * input.tokenStep * 0.55);
        const usd = roundUsd(tokens * input.costFactor);

        target.push(createEvent(input.sessionKey, observedAt.toISOString(), {
            providerId: input.providerId,
            backendMode: input.backendMode,
            modelId,
            projectKey: input.projectKey,
            workspaceId: input.workspaceId,
            tokens,
            reportedUsd: input.costMode === 'reported' ? usd : undefined,
            estimatedUsd: input.costMode === 'estimated' ? usd : undefined,
        }));
    }
}

function addBurst(target, baseIso, events) {
    const baseObservedAt = Date.parse(baseIso);
    for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        target.push(createEvent(event.sessionKey, new Date(baseObservedAt + index * 60 * 60 * 1000).toISOString(), event));
    }
}

function roundUsd(value) {
    return Math.round(value * 10_000) / 10_000;
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

function buildRelativeDateRange(days) {
    const endMs = Date.now();
    const startMs = endMs - days * 24 * 60 * 60 * 1000;
    return { startMs, endMs };
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
        dateRange: buildRelativeDateRange(30),
        granularity: 'day',
        includeInsights: true,
        includeActivity: true,
        includeLeaders: true,
        includeSeries: true,
    });
    const yearly = await querySnapshot(serverUrl, token, {
        dateRange: buildRelativeDateRange(365),
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
