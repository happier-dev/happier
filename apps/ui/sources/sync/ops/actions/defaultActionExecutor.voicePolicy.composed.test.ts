import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { t } from '@/text';

// Only Home HTTP, credential storage and disconnected socket transports are replaced.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { presentActionExecutionFailure } = await import('./resolveActionExecutionFailureMessage');
let serverId: string;

beforeEach(async () => {
    await homes.reset();
    serverId = await homes.addHome({ name: 'Voice policy Home', serverUrl: 'https://voice-policy.test',
        serverIdentityId: 'voice-policy-home', accountId: 'voice-policy-owner', currentAccount: true });
    homes.answer(serverId, '/v2/account/settings', { body: { version: 1,
        content: { t: 'plain', v: { featureToggles: { 'voice.agent': false } } } } });
});
afterEach(() => standardCleanup());

describe('Voice Account-policy refusal through the public Action entry and failure presenter', () => {
    it('names the disabled Account feature and its Settings repair before any Voice execution', async () => {
        const failure = await createDefaultActionExecutor().execute('voice_agent.start', {}, {
            surface: 'ui', serverId, expectedAccountId: 'voice-policy-owner',
        });

        expect(failure).toMatchObject({ ok: false });
        if (failure.ok) throw new Error('Expected the Account policy to refuse Voice before admission');
        expect(presentActionExecutionFailure(failure).reason).toBe(t('settingsVoice.pages.conversations.agentFeatureRequired', {
            feature: t('settingsFeatures.expVoiceAgent'),
        }));
        expect(failure).toMatchObject({ errorCode: 'action_disabled', details: { featureDecision: {
            featureId: 'voice.agent', state: 'disabled', blockedBy: 'local_policy',
        } } });
        expect(homes.requestsFor('/v1/actions/voice_agent.start/execution-authorization')).toHaveLength(0);
    });

    it('does not offer the Account Voice feature switch as the repair for a Home-disabled dependency', async () => {
        homes.answer(serverId, '/v2/account/settings', { body: { version: 2, content: null } });
        homes.answer(serverId, '/v1/features', { body: createRootLayoutFeaturesResponse({
            features: { voice: { enabled: false } },
        }) });
        const failure = await createDefaultActionExecutor().execute('voice_agent.start', {}, {
            surface: 'ui', serverId, expectedAccountId: 'voice-policy-owner',
        });

        expect(failure).toMatchObject({ ok: false, errorCode: 'action_disabled' });
        if (failure.ok) throw new Error('Expected the Home policy to refuse Voice before admission');
        expect(presentActionExecutionFailure(failure).reason).toBe(t('actionConfirmations.turnedOffUnnamedMessage'));
    });
});
