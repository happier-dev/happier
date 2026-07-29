import { describe, expect, it } from 'vitest';
import type {
    QualifiedConnectedAccountProfileV4,
} from '@happier-dev/protocol';

import {
    resolveBuiltInConnectedAccountQuotaTransport,
} from './resolveBuiltInConnectedAccountQuotaTransport';

const qualifiedAnthropicAccount: QualifiedConnectedAccountProfileV4 = {
    ref: {
        service: {
            pluginId: 'happier.agent.claude',
            localId: 'anthropic',
        },
        accountId: 'work',
    },
    status: 'connected',
    authenticationModeId: 'api-key',
    credentialRevision: 'revision-1',
    configurationReady: true,
    configurationRevision: null,
    scopes: [],
};

describe('resolveBuiltInConnectedAccountQuotaTransport', () => {
    it('selects the exact qualified identity when V4 is advertised', () => {
        expect(resolveBuiltInConnectedAccountQuotaTransport({
            negotiation: 'advertised-v4',
            profile: {
                serviceId: 'anthropic',
                profileId: 'work',
            },
            qualifiedAccounts: [qualifiedAnthropicAccount],
        })).toEqual({
            kind: 'v4',
            legacyProfile: {
                serviceId: 'anthropic',
                profileId: 'work',
            },
            ref: qualifiedAnthropicAccount.ref,
        });
    });

    it('does not downgrade an advertised V4 account when its exact projection is absent', () => {
        expect(resolveBuiltInConnectedAccountQuotaTransport({
            negotiation: 'advertised-v4',
            profile: {
                serviceId: 'anthropic',
                profileId: 'work',
            },
            qualifiedAccounts: [],
        })).toBeNull();
    });

    it('retains the guarded compatibility identity only for a known legacy peer', () => {
        expect(resolveBuiltInConnectedAccountQuotaTransport({
            negotiation: 'legacy',
            profile: {
                serviceId: 'anthropic',
                profileId: 'work',
            },
            qualifiedAccounts: [qualifiedAnthropicAccount],
        })).toEqual({
            kind: 'legacy',
            legacyProfile: {
                serviceId: 'anthropic',
                profileId: 'work',
            },
        });
    });

    it('performs no quota operation while peer support is indeterminate', () => {
        expect(resolveBuiltInConnectedAccountQuotaTransport({
            negotiation: 'indeterminate',
            profile: {
                serviceId: 'anthropic',
                profileId: 'work',
            },
            qualifiedAccounts: [qualifiedAnthropicAccount],
        })).toBeNull();
    });

    it('rejects invalid legacy identities instead of constructing a qualified alias', () => {
        expect(resolveBuiltInConnectedAccountQuotaTransport({
            negotiation: 'advertised-v4',
            profile: {
                serviceId: 'novel-service',
                profileId: 'work',
            },
            qualifiedAccounts: [qualifiedAnthropicAccount],
        })).toBeNull();
    });
});
