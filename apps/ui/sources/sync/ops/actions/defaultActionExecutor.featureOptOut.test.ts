import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// HTTP, credentials and disconnected sockets are the genuine system boundaries.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
let serverId: string;
beforeEach(async () => {
    await homes.reset();
    serverId = await homes.addHome({ name: 'Feature Home', serverUrl: 'https://feature-opt-out.test',
        serverIdentityId: 'feature-home', accountId: 'owner', currentAccount: true });
    homes.answer(serverId, '/v2/account/settings', { body: { version: 1,
        content: { t: 'plain', v: { featureToggles: { bots: false, deployments: false,
            'sessions.conversations': false, teams: false, 'sessions.following': false, browser: false, devices: false,
            automations: false, 'execution.runs': false, 'voice.agent': false, 'terminal.embeddedPty': false,
            'memory.search': false, 'sessions.direct': false, 'scm.writeOperations': false } } } } });
    homes.answer(serverId, '/v1/features', { body: { features: { bots: { enabled: true }, deployments: { enabled: true },
        sessions: { enabled: true, conversations: { enabled: true }, following: { enabled: true } }, teams: { enabled: true },
        workflows: { enabled: true },
        browser: { enabled: true, viewTargets: { enabled: true } }, devices: { enabled: true, simulatorPreview: { enabled: true } } } } });
});
afterEach(() => standardCleanup());

describe('Account new-work opt-outs at the UI Action entry', () => {
    it.each(['session.bot.set', 'deployments.prepare', 'discussion.create', 'teams.create', 'follow.set',
        'browser.view.open', 'devices.simulator.lease.acquire', 'workflow.definition.create', 'workflow.run.start',
        'execution.run.start', 'execution.run.ensure_or_start', 'review.start', 'voice_agent.start',
        'session.terminals.open', 'memory.search', 'sessions.external.link.ensure', 'scm.commit.create'] as const)('refuses %s before transport admission', async actionId => {
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, serverId, expectedAccountId: 'owner' };
        const result = await executor.execute(actionId, {}, context);
        expect(result).toMatchObject({ ok: false, errorCode: 'action_disabled' });
        expect(await executor.prepare(actionId, {}, context)).toMatchObject({
            kind: 'settled', result: { ok: false, errorCode: 'action_disabled' },
        });
        expect(homes.requestsFor(`/v1/actions/${actionId}/execution-authorization`)).toHaveLength(0);
        expect(homes.requestsFor('/v1/features')).toHaveLength(0);
    });

    it('allows an enabled feature to reach ordinary Action input validation', async () => {
        homes.answer(serverId, '/v2/account/settings', { body: { version: 2, content: null } });
        expect(await createDefaultActionExecutor().execute('session.bot.set', {}, {
            surface: 'ui', serverId, expectedAccountId: 'owner',
        })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    });

    it.each(['discussion.get', 'discussion.post', 'discussion.reply'] as const)('retains %s admission while Discussions is off', async actionId => {
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, serverId, expectedAccountId: 'owner' };
        expect(await executor.execute(actionId, {}, context)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    });
});
