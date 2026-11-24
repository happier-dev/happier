import { beforeEach, describe, expect, it } from 'vitest';

import {
    type ConnectedAccountDescriptorProjectionState,
} from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';

import { resolveSessionUsageAccount } from './resolveSessionUsageAccount';

const CLAUDE = 'happier.agent.claude/claude-subscription';
const ANTHROPIC = 'happier.agent.claude/anthropic';

function metadata(bindingsByServiceId: Record<string, unknown>) {
    return { connectedServices: { v: 2, bindingsByServiceId } };
}

describe('resolveSessionUsageAccount', () => {
    beforeEach(() => {
        installConnectedAccountDescriptorProjection({
            scopeKey: 'session-usage-account-test',
            status: 'ready',
            descriptors: [],
            conflicts: [],
            errorReason: null,
        } satisfies ConnectedAccountDescriptorProjectionState);
    });

    it('knows the account a session signs in with when its binding names it, through a pool or directly', () => {
        expect(resolveSessionUsageAccount({
            metadata: metadata({ [CLAUDE]: { source: 'connected', selection: 'group', groupId: 'work', profileId: 'lab' } }),
            agentId: 'claude',
        })).toEqual({
            status: 'known',
            source: 'session_binding',
            account: { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, accountId: 'lab' },
            groupId: 'work',
        });
        expect(resolveSessionUsageAccount({
            metadata: metadata({ [CLAUDE]: { source: 'connected', selection: 'profile', profileId: 'personal' } }),
            agentId: 'claude',
        })).toMatchObject({ status: 'known', account: { accountId: 'personal' }, groupId: null });
    });

    it.each([undefined, 'authored', 'applied'])(
        'uses the observed Pool member with an authored profile of %s',
        (profileId) => {
            expect(resolveSessionUsageAccount({
                metadata: metadata({ [CLAUDE]: {
                    source: 'connected', selection: 'group', groupId: 'work', appliedProfileId: 'applied',
                    ...(profileId ? { profileId } : {}),
                } }),
                agentId: 'claude',
            })).toMatchObject({ status: 'known', account: { accountId: 'applied' }, groupId: 'work' });
        },
    );

    it('never takes a pool\'s account for the session\'s: a pool binding without its account is unknown', () => {
        // The pool's current member may have moved since this session signed in; only the pool is a session fact.
        expect(resolveSessionUsageAccount({
            metadata: metadata({ [CLAUDE]: { source: 'connected', selection: 'group', groupId: 'work' } }),
            agentId: 'claude',
        })).toEqual({
            status: 'unknown',
            pool: { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, groupId: 'work' },
        });
    });

    it('is unknown when the bindings name more than one account, and when there are none to read', () => {
        expect(resolveSessionUsageAccount({
            metadata: metadata({
                [CLAUDE]: { source: 'connected', selection: 'profile', profileId: 'work' },
                [ANTHROPIC]: { source: 'connected', selection: 'profile', profileId: 'build' },
            }),
            agentId: 'claude',
        })).toEqual({ status: 'unknown', pool: null });
        expect(resolveSessionUsageAccount({ metadata: {}, agentId: 'claude' })).toEqual({ status: 'unknown', pool: null });
    });

    it('says a session that signs in on its own uses no connected account', () => {
        expect(resolveSessionUsageAccount({
            metadata: metadata({ [CLAUDE]: { source: 'native' } }),
            agentId: 'claude',
        })).toEqual({ status: 'not_connected' });
    });
});
