import type { ConnectedServicesDefaultAuthByAgentIdV1 } from '@happier-dev/protocol';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol';
import { CANONICAL_AGENTS_CORE } from '@happier-dev/agents';

import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import type { Profile } from '@/sync/domains/profiles/profile';
import type { Settings } from '@/sync/domains/settings/settings';

import { DEMO_NOW_MS } from './constants';

const CODEX_POOL_ID = 'demo-codex-pool';
const CLAUDE_POOL_ID = 'demo-claude-pool';

/** Canonical qualified Connected Account service identities for the demo beat. */
const CODEX_SERVICE = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
const CLAUDE_SUBSCRIPTION_SERVICE = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' } as const;
const GITHUB_SERVICE = { pluginId: 'happier.scm.forge.github', localId: 'github-account' } as const;

const CODEX_SERVICE_KEY = buildQualifiedPluginContributionKey(CODEX_SERVICE);
const CLAUDE_SUBSCRIPTION_SERVICE_KEY = buildQualifiedPluginContributionKey(CLAUDE_SUBSCRIPTION_SERVICE);
const GITHUB_SERVICE_KEY = buildQualifiedPluginContributionKey(GITHUB_SERVICE);

type DemoConnectedService = Profile['connectedServicesV2'][number];

/**
 * A12 "Pool your accounts. Sail past usage limits."
 *
 * Without seeded accounts the connected-services screen renders "No connected
 * services yet" under a headline about pooling accounts. These are the accounts
 * and pools the stage shows: two subscription services with several accounts
 * each, gathered into pools, plus the code host the git beat talks about.
 */
function buildDemoConnectedServices(): DemoConnectedService[] {
    return [
        {
            serviceId: 'openai-codex',
            profiles: [
                {
                    profileId: 'personal',
                    status: 'connected',
                    kind: 'oauth',
                    providerEmail: 'you@happier.dev',
                    providerAccountId: 'demo-codex-personal',
                    expiresAt: null,
                    lastUsedAt: DEMO_NOW_MS - 240_000,
                    health: null,
                },
                {
                    profileId: 'work',
                    status: 'connected',
                    kind: 'oauth',
                    providerEmail: 'you@acme.test',
                    providerAccountId: 'demo-codex-work',
                    expiresAt: null,
                    lastUsedAt: DEMO_NOW_MS - 3_600_000,
                    health: null,
                },
                {
                    profileId: 'oncall',
                    status: 'connected',
                    kind: 'oauth',
                    providerEmail: 'oncall@acme.test',
                    providerAccountId: 'demo-codex-oncall',
                    expiresAt: null,
                    lastUsedAt: DEMO_NOW_MS - 86_400_000,
                    health: null,
                },
            ],
            groups: [
                {
                    groupId: CODEX_POOL_ID,
                    displayName: 'Codex pool',
                    activeProfileId: 'personal',
                    generation: 4,
                    memberProfileIds: ['personal', 'work', 'oncall'],
                },
            ],
        },
        {
            serviceId: 'claude-subscription',
            profiles: [
                {
                    profileId: 'max',
                    status: 'connected',
                    kind: 'oauth',
                    providerEmail: 'you@happier.dev',
                    providerAccountId: 'demo-claude-max',
                    expiresAt: null,
                    lastUsedAt: DEMO_NOW_MS - 600_000,
                    health: null,
                },
                {
                    profileId: 'team',
                    status: 'connected',
                    kind: 'oauth',
                    providerEmail: 'team@acme.test',
                    providerAccountId: 'demo-claude-team',
                    expiresAt: null,
                    lastUsedAt: DEMO_NOW_MS - 7_200_000,
                    health: null,
                },
            ],
            groups: [
                {
                    groupId: CLAUDE_POOL_ID,
                    displayName: 'Claude pool',
                    activeProfileId: 'max',
                    generation: 2,
                    memberProfileIds: ['max', 'team'],
                },
            ],
        },
        {
            serviceId: 'github',
            profiles: [
                {
                    profileId: 'personal',
                    status: 'connected',
                    kind: 'oauth',
                    providerEmail: 'you@happier.dev',
                    providerAccountId: 'demo-github-personal',
                    expiresAt: null,
                    lastUsedAt: DEMO_NOW_MS - 1_800_000,
                    health: null,
                },
            ],
            groups: [],
        },
    ];
}

export type DemoConnectedServicesSettings = Pick<
    Settings,
    | 'connectedServicesDefaultProfileByServiceId'
    | 'connectedServicesProfileLabelByKey'
    | 'connectedServicesDefaultAuthByAgentIdV1'
>;

/**
 * The account-side of the same beat: friendly labels, a per-service default, and
 * the agent defaults that make the pools load-bearing instead of decorative.
 * Binding keys are canonical qualified Connected Account service keys — demo
 * mode never writes bare scalar service ids.
 */
export function buildDemoConnectedServicesSettings(): DemoConnectedServicesSettings {
    const defaultAuth: ConnectedServicesDefaultAuthByAgentIdV1 = {
        v: 1,
        bindingsByAgentId: {
            [CANONICAL_AGENTS_CORE.codex.id]: {
                v: 1,
                bindingsByServiceId: {
                    [CODEX_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: CODEX_POOL_ID },
                },
            },
            [CANONICAL_AGENTS_CORE.claude.id]: {
                v: 1,
                bindingsByServiceId: {
                    [CLAUDE_SUBSCRIPTION_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: CLAUDE_POOL_ID },
                },
            },
            [CANONICAL_AGENTS_CORE.opencode.id]: {
                v: 1,
                bindingsByServiceId: {
                    [CODEX_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'work' },
                },
            },
        },
    };

    return {
        connectedServicesDefaultProfileByServiceId: {
            [CODEX_SERVICE_KEY]: 'personal',
            [CLAUDE_SUBSCRIPTION_SERVICE_KEY]: 'max',
            [GITHUB_SERVICE_KEY]: 'personal',
        },
        connectedServicesProfileLabelByKey: {
            [connectedServiceProfileKey({ serviceId: CODEX_SERVICE_KEY, profileId: 'personal' })]: 'Personal',
            [connectedServiceProfileKey({ serviceId: CODEX_SERVICE_KEY, profileId: 'work' })]: 'Work',
            [connectedServiceProfileKey({ serviceId: CODEX_SERVICE_KEY, profileId: 'oncall' })]: 'On-call',
            [connectedServiceProfileKey({ serviceId: CLAUDE_SUBSCRIPTION_SERVICE_KEY, profileId: 'max' })]: 'Personal Max',
            [connectedServiceProfileKey({ serviceId: CLAUDE_SUBSCRIPTION_SERVICE_KEY, profileId: 'team' })]: 'Team',
            [connectedServiceProfileKey({ serviceId: GITHUB_SERVICE_KEY, profileId: 'personal' })]: 'Personal',
        },
        connectedServicesDefaultAuthByAgentIdV1: defaultAuth,
    };
}

export type DemoWorldProfile = Pick<Profile, 'connectedServicesV2' | 'connectedAccountsV4' | 'connectedAccountGroupsV4'>;

type DemoAccountV4 = Profile['connectedAccountsV4'][number];
type DemoGroupV4 = Profile['connectedAccountGroupsV4'][number];

/**
 * V4 mirror of the demo beat for every qualified-v4 consumer (session auth
 * switch, new-session account picker). Refs carry the exact canonical service
 * identity, so external-service consumers treat demo accounts like any other
 * qualified account.
 */
function buildDemoQualifiedAccounts(): { accounts: DemoAccountV4[]; groups: DemoGroupV4[] } {
    const demoAccount = (params: Readonly<{
        service: { pluginId: string; localId: string };
        accountId: string;
        email: string;
        displayName: string;
        lastUsedAgoMs: number;
    }>): DemoAccountV4 => ({
        revisionSemantics: 'legacy_unfenced',
        ref: { service: params.service, accountId: params.accountId },
        status: 'connected',
        authenticationModeId: null,
        configurationReady: true,
        configurationRevision: null,
        kind: 'oauth',
        expiresAt: null,
        lastUsedAt: DEMO_NOW_MS - params.lastUsedAgoMs,
        providerIdentity: { email: params.email },
        displayName: params.displayName,
    });
    const accounts: DemoAccountV4[] = [
        demoAccount({ service: CODEX_SERVICE, accountId: 'personal', email: 'you@happier.dev', displayName: 'Personal', lastUsedAgoMs: 240_000 }),
        demoAccount({ service: CODEX_SERVICE, accountId: 'work', email: 'you@acme.test', displayName: 'Work', lastUsedAgoMs: 3_600_000 }),
        demoAccount({ service: CODEX_SERVICE, accountId: 'oncall', email: 'oncall@acme.test', displayName: 'On-call', lastUsedAgoMs: 86_400_000 }),
        demoAccount({ service: CLAUDE_SUBSCRIPTION_SERVICE, accountId: 'max', email: 'you@happier.dev', displayName: 'Personal Max', lastUsedAgoMs: 600_000 }),
        demoAccount({ service: CLAUDE_SUBSCRIPTION_SERVICE, accountId: 'team', email: 'team@acme.test', displayName: 'Team', lastUsedAgoMs: 7_200_000 }),
        demoAccount({ service: GITHUB_SERVICE, accountId: 'personal', email: 'you@happier.dev', displayName: 'Personal', lastUsedAgoMs: 1_800_000 }),
    ];
    const demoPolicy = {
        v: 1 as const,
        strategy: 'least_limited' as const,
        autoSwitch: true,
        switchOn: {
            usageLimit: true,
            authExpired: true,
            accountChanged: false,
            refreshFailure: true,
        },
    };
    const groups: DemoGroupV4[] = [
        {
            v: 1 as const,
            ref: { service: CODEX_SERVICE, groupId: CODEX_POOL_ID },
            incarnation: `${CODEX_POOL_ID}:4`,
            displayName: 'Codex pool',
            policy: demoPolicy,
            activeConnectedAccountId: 'personal',
            generation: 4,
            runtimeStateRevision: 1,
            state: { status: 'ready' as const },
            createdAt: DEMO_NOW_MS - 86_400_000,
            updatedAt: DEMO_NOW_MS - 240_000,
            members: [
                { v: 1 as const, connectedAccountId: 'personal', priority: 100, enabled: true, state: {}, createdAt: DEMO_NOW_MS - 86_400_000, updatedAt: DEMO_NOW_MS - 240_000 },
                { v: 1 as const, connectedAccountId: 'work', priority: 200, enabled: true, state: {}, createdAt: DEMO_NOW_MS - 86_400_000, updatedAt: DEMO_NOW_MS - 240_000 },
                { v: 1 as const, connectedAccountId: 'oncall', priority: 300, enabled: true, state: {}, createdAt: DEMO_NOW_MS - 86_400_000, updatedAt: DEMO_NOW_MS - 240_000 },
            ],
        },
        {
            v: 1 as const,
            ref: { service: CLAUDE_SUBSCRIPTION_SERVICE, groupId: CLAUDE_POOL_ID },
            incarnation: `${CLAUDE_POOL_ID}:2`,
            displayName: 'Claude pool',
            policy: demoPolicy,
            activeConnectedAccountId: 'max',
            generation: 2,
            runtimeStateRevision: 1,
            state: { status: 'ready' as const },
            createdAt: DEMO_NOW_MS - 86_400_000,
            updatedAt: DEMO_NOW_MS - 600_000,
            members: [
                { v: 1 as const, connectedAccountId: 'max', priority: 100, enabled: true, state: {}, createdAt: DEMO_NOW_MS - 86_400_000, updatedAt: DEMO_NOW_MS - 600_000 },
                { v: 1 as const, connectedAccountId: 'team', priority: 200, enabled: true, state: {}, createdAt: DEMO_NOW_MS - 86_400_000, updatedAt: DEMO_NOW_MS - 600_000 },
            ],
        },
    ];
    return { accounts, groups };
}

export function buildDemoProfile(): DemoWorldProfile {
    const { accounts, groups } = buildDemoQualifiedAccounts();
    return {
        connectedServicesV2: buildDemoConnectedServices(),
        connectedAccountsV4: accounts,
        connectedAccountGroupsV4: groups,
    };
}
