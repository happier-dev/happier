import type { ConnectedServicesDefaultAuthByAgentIdV1 } from '@happier-dev/protocol';
import { CANONICAL_AGENTS_CORE } from '@happier-dev/agents';

import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import type { Profile } from '@/sync/domains/profiles/profile';
import type { Settings } from '@/sync/domains/settings/settings';

import { DEMO_NOW_MS } from './constants';

const CODEX_POOL_ID = 'demo-codex-pool';
const CLAUDE_POOL_ID = 'demo-claude-pool';

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
 */
export function buildDemoConnectedServicesSettings(): DemoConnectedServicesSettings {
    const defaultAuth: ConnectedServicesDefaultAuthByAgentIdV1 = {
        v: 1,
        bindingsByAgentId: {
            [CANONICAL_AGENTS_CORE.codex.id]: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': { source: 'connected', selection: 'group', groupId: CODEX_POOL_ID },
                },
            },
            [CANONICAL_AGENTS_CORE.claude.id]: {
                v: 1,
                bindingsByServiceId: {
                    'claude-subscription': { source: 'connected', selection: 'group', groupId: CLAUDE_POOL_ID },
                },
            },
            [CANONICAL_AGENTS_CORE.opencode.id]: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
                },
            },
        },
    };

    return {
        connectedServicesDefaultProfileByServiceId: {
            'openai-codex': 'personal',
            'claude-subscription': 'max',
            github: 'personal',
        },
        connectedServicesProfileLabelByKey: {
            [connectedServiceProfileKey({ serviceId: 'openai-codex', profileId: 'personal' })]: 'Personal',
            [connectedServiceProfileKey({ serviceId: 'openai-codex', profileId: 'work' })]: 'Work',
            [connectedServiceProfileKey({ serviceId: 'openai-codex', profileId: 'oncall' })]: 'On-call',
            [connectedServiceProfileKey({ serviceId: 'claude-subscription', profileId: 'max' })]: 'Personal Max',
            [connectedServiceProfileKey({ serviceId: 'claude-subscription', profileId: 'team' })]: 'Team',
            [connectedServiceProfileKey({ serviceId: 'github', profileId: 'personal' })]: 'Personal',
        },
        connectedServicesDefaultAuthByAgentIdV1: defaultAuth,
    };
}

export type DemoWorldProfile = Pick<Profile, 'connectedServicesV2'>;

export function buildDemoProfile(): DemoWorldProfile {
    return {
        connectedServicesV2: buildDemoConnectedServices(),
    };
}
