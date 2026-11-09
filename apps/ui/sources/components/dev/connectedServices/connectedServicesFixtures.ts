import type {
    QualifiedConnectedAccountGroupV4,
    QualifiedConnectedAccountProfileV4,
} from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';

import { getLegacyConnectedServiceRegistryEntry, type ConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';

/**
 * Shared fixture data for the dev-only Connected services preview (`/dev/connected-services`, lab `csvc`):
 * the lab's cast (Claude Work/Personal/Lab, ChatGPT Personal/Team/Bot, an Anthropic key, GitHub, two pools)
 * in the shapes the owners produce. Rendered only through real components; never written anywhere.
 */
export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export type Svc = Readonly<{ pluginId: string; localId: string }>;
export const CLAUDE: Svc = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
export const CHATGPT: Svc = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
export const ANTHROPIC: Svc = { pluginId: 'happier.agent.claude', localId: 'anthropic' };
export const GEMINI: Svc = { pluginId: 'happier.agent.gemini', localId: 'gemini-account' };
export const OPENAI: Svc = { pluginId: 'happier.provider.openai', localId: 'openai' };
export const GITHUB: Svc = { pluginId: 'happier.scm.forge.github', localId: 'github-account' };

export function entry(service: Svc, legacy: string | null, title: string, modes: ReadonlyArray<Readonly<{ id: string; kind: string }>>): ConnectedServiceRegistryEntry {
    const legacyEntry = legacy ? getLegacyConnectedServiceRegistryEntry(legacy) : null;
    return {
        serviceId: service.localId,
        service,
        ...(legacyEntry?.legacyServiceId ? { legacyServiceId: legacyEntry.legacyServiceId } : {}),
        connectCommand: `happier connect ${service.localId}`,
        supportsOauth: true,
        executable: true,
        projectedTitle: title,
        authenticationModes: modes as ConnectedServiceRegistryEntry['authenticationModes'],
    };
}

export const ENTRIES: readonly ConnectedServiceRegistryEntry[] = [
    entry(CLAUDE, 'claude-subscription', 'Claude', [{ id: 'oauth', kind: 'oauthAuthorizationCode' }, { id: 'setup-token', kind: 'manual' }]),
    entry(CHATGPT, 'openai-codex', 'ChatGPT', [{ id: 'oauth', kind: 'oauthAuthorizationCode' }, { id: 'device', kind: 'oauthDeviceCode' }]),
    entry(ANTHROPIC, 'anthropic', 'Anthropic API key', [{ id: 'api-key', kind: 'manual' }]),
    entry(GEMINI, 'gemini', 'Gemini', [{ id: 'api-key', kind: 'manual' }, { id: 'service-account', kind: 'manual' }]),
    entry(OPENAI, 'openai', 'OpenAI API key', [{ id: 'api-key', kind: 'manual' }]),
    entry(GITHUB, 'github', 'GitHub', [{ id: 'fine-grained-pat', kind: 'manual' }]),
];

export function account(service: Svc, accountId: string, email: string, fields: Partial<QualifiedConnectedAccountProfileV4> = {}): QualifiedConnectedAccountProfileV4 {
    return {
        ref: { service, accountId },
        status: 'connected',
        authenticationModeId: 'oauth',
        revisionSemantics: 'revisioned',
        credentialRevision: `rev-${accountId}`,
        configurationReady: true,
        configurationRevision: null,
        scopes: [],
        providerIdentity: { email },
        ...fields,
    } as QualifiedConnectedAccountProfileV4;
}

export const ACCOUNTS: readonly QualifiedConnectedAccountProfileV4[] = [
    account(CLAUDE, 'work', 'leeroy@company.com'),
    account(CLAUDE, 'personal', 'leeroy.b@gmail.com'),
    account(CHATGPT, 'personal', 'leeroy.b@gmail.com'),
    account(CHATGPT, 'work', 'leeroy@company.com', { status: 'needs_reauth' }),
    account(ANTHROPIC, 'build', 'sk-ant-…4f2a', { kind: 'token', authenticationModeId: 'api-key', providerIdentity: undefined, displayName: 'sk-ant-…4f2a' }),
    account(GITHUB, 'gh', 'leeroybrun', { kind: 'token', authenticationModeId: 'fine-grained-pat', providerIdentity: undefined }),
];

export const GROUPS: readonly QualifiedConnectedAccountGroupV4[] = [{
    ref: { service: CLAUDE, groupId: 'work-pool' },
    displayName: 'Work pool',
    activeConnectedAccountId: 'work',
    policy: { strategy: 'least_limited', autoSwitch: true },
    members: [
        { v: 1, connectedAccountId: 'work', priority: 0, enabled: true },
        { v: 1, connectedAccountId: 'personal', priority: 1, enabled: true },
    ],
} as unknown as QualifiedConnectedAccountGroupV4];

export const LABELS: Readonly<Record<string, string>> = {
    'happier.agent.claude%2Fclaude-subscription/work': 'Work',
    'happier.agent.claude%2Fclaude-subscription/personal': 'Personal',
    'happier.agent.codex%2Fopenai-codex/personal': 'Personal',
    'happier.agent.codex%2Fopenai-codex/work': 'Work',
    'happier.agent.claude%2Fanthropic/build': 'Build server',
    'happier.scm.forge.github%2Fgithub-account/gh': '@leeroybrun',
};

export const AGENT_USES = [
    { agentId: 'claude', title: 'Claude Code', services: [CLAUDE, ANTHROPIC], defaults: [{ kind: 'group' as const, service: CLAUDE, groupId: 'work-pool' }] },
    { agentId: 'codex', title: 'Codex', services: [CHATGPT], defaults: [{ kind: 'account' as const, account: { service: CHATGPT, accountId: 'personal' } }] },
    { agentId: 'opencode', title: 'OpenCode', services: [CLAUDE, CHATGPT, ANTHROPIC, OPENAI], defaults: [] },
    { agentId: 'pi', title: 'Pi', services: [CLAUDE, OPENAI], defaults: [] },
    { agentId: 'gemini', title: 'Gemini CLI', services: [GEMINI], defaults: [] },
];

export type FixtureMeter = Readonly<{ meterId: string; label: string; remainingPct: number; resetsAt: number; status: 'ok' }>;

export function meter(meterId: string, label: string, remainingPct: number, resetsInMs: number, now: number): FixtureMeter {
    return { meterId, label, remainingPct, resetsAt: now + resetsInMs, status: 'ok' };
}


/** A5 (setup): the ChatGPT account that has just connected, and the pool Codex signs in through. */
export const CHATGPT_BOT = account(CHATGPT, 'bot', 'bot@happier.dev');
export const CODEX_POOL: QualifiedConnectedAccountGroupV4 = {
    ref: { service: CHATGPT, groupId: 'codex-pool' },
    displayName: 'Codex pool',
    activeConnectedAccountId: 'personal',
    policy: { strategy: 'priority', autoSwitch: true },
    members: [{ v: 1, connectedAccountId: 'personal', priority: 0, enabled: true }],
} as unknown as QualifiedConnectedAccountGroupV4;

/** PL (pool): the lab's third Claude account, the Work pool's fallback. */
export const CLAUDE_LAB = account(CLAUDE, 'lab', 'lab@happier.dev', { displayName: 'Lab' });
