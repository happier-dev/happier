import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { resolveActivitySurfaceDeliveryAdmission } from '@/activity/delivery/resolveActivitySurfaceDeliveryAdmission';
import { buildSharedActivityProjection } from '@/activity/delivery/sharedActivityProjection';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { createBotsPresentationReader } from '@/components/sessions/bots/botsSummary';
import { buildNotchBotFaces } from '../presentation/buildNotchBotFaces';

describe('notch.N3.F1.faces', () => {
    it('consumes one Home-selected Bot order and one admission, retains faces on heartbeats, and carries overflow', () => {
        const homes = ['home-a', 'home-b', 'home-c'];
        const sessions = Array.from({ length: 1_000 }, (_, index) => createSessionFixture({
            id: `session-${index}`, serverId: homes[index % 3], active: true, activeAt: 1_000,
            metadata: { path: '/repo', host: 'test', ...(index < 40 ? { bot: { kind: 'bot' as const } } : {}) },
        }));
        const candidates = sessions.map(session => buildSessionActivityAttention({ session, nowMs: 1_000 }));
        const scopes = new Map(homes.map(serverId => [serverId, { serverId, accountId: `account-${serverId}` }]));
        const admission = resolveActivitySurfaceDeliveryAdmission({ candidates, surface: 'desktop_overlay',
            resolveAccountSettings: () => accountSettingsParse({}), localSettings: {}, now: new Date(1_000), audienceScopes: scopes,
            accountDeliveryMutesByServerId: Object.fromEntries([...scopes].map(([serverId, scope]) => [serverId, { scope,
                scopes: [{ kind: 'sender_session' as const, sessionId: 'session-0' }],
            }])),
        });
        const selectedHomes = homes.slice(0, 2);
        const readOrder = createBotsPresentationReader(selectedHomes);
        const botRows = Object.fromEntries(homes.map(serverId => [serverId, Object.fromEntries(sessions.slice(0, 40)
            .filter(session => session.serverId === serverId).map(session => [session.id, buildSessionListRenderableFromSession(session)]))]));
        const pins = Object.fromEntries(homes.map(serverId => [serverId, sessions.slice(0, 12)
            .filter(session => session.serverId === serverId).map(session => session.id)]));
        const policy = resolveActivitySurfacePolicy({});
        const input = { orderedBots: readOrder(botRows, 1_000), admission, railPinnedByServerId: pins,
            mode: 'always_when_enabled' as const, activityPolicy: policy, resolveCandidatePrivacyMode: admission.privacyModeFor };
        const faces = buildNotchBotFaces(input);
        expect(faces.faces).toHaveLength(7); // 8 selected-Home pins, minus the muted Session.
        expect(faces.overflowCount).toBe(3);
        expect(faces.faces.some(face => face.sessionId === 'session-0' || face.serverId === 'home-c')).toBe(false);
        expect(buildSharedActivityProjection({ admission, policy, selectedFaces: faces.faces }).visible).toBe(true);
        for (let index = 0; index < 100; index++) {
            const row = botRows['home-a']!['session-3']!;
            botRows['home-a'] = { ...botRows['home-a'], 'session-3': { ...row, activeAt: 1_001 + index } };
            expect(buildNotchBotFaces({ ...input, orderedBots: readOrder(botRows, 1_000) }, faces)).toBe(faces);
        }
    });
});
