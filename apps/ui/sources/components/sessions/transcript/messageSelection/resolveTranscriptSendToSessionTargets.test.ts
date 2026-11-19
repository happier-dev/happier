import { describe, expect, it } from 'vitest';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';

import { setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { resolveReadableSessionPickerTargets, resolveTranscriptSendToSessionTargets, type TranscriptSendToSessionTargetCandidate } from './resolveTranscriptSendToSessionTargets';

function candidate(input: Partial<TranscriptSendToSessionTargetCandidate> & Pick<TranscriptSendToSessionTargetCandidate, 'id'>): TranscriptSendToSessionTargetCandidate {
    return {
        id: input.id,
        serverId: input.serverId ?? 'server-a',
        access: input.access === undefined ? createSessionAccessFixture() : input.access,
        metadata: input.metadata ?? {},
        meaningfulActivityAt: input.meaningfulActivityAt ?? null,
        updatedAt: input.updatedAt ?? 0,
        createdAt: input.createdAt ?? 0,
    };
}

describe('resolveTranscriptSendToSessionTargets', () => {
    it('offers only input-capable Sessions when a Review chooses a fix destination without a source Session', () => {
        const targets = resolveReadableSessionPickerTargets({ serverId: 'server-a', capability: 'submitAgentInput', sessions: [
            candidate({ id: 'editable', access: createSessionAccessFixture('edit') }),
            candidate({ id: 'read-only', access: createSessionAccessFixture('view') }),
            candidate({ id: 'other-home', serverId: 'server-b' }),
            candidate({ id: 'hidden', metadata: { hiddenSystemSession: true } }),
        ] });
        expect(targets.map(target => target.id)).toEqual(['editable']);
    });
    it('keeps only same-server writable user-facing destination sessions and excludes the source session', () => {
        const targets = resolveTranscriptSendToSessionTargets({
            sourceSessionId: 'source',
            sourceServerId: 'server-a',
            sessions: [
                candidate({ id: 'source', updatedAt: 50 }),
                candidate({ id: 'writable-edit', access: createSessionAccessFixture('edit'), updatedAt: 40 }),
                candidate({ id: 'writable-owner', access: createSessionAccessFixture(), updatedAt: 30 }),
                candidate({ id: 'unavailable', access: null }),
                candidate({ id: 'read-only', access: createSessionAccessFixture('view'), updatedAt: 20 }),
                candidate({ id: 'other-server', serverId: 'server-b', updatedAt: 10 }),
                candidate({ id: 'hidden', metadata: { hiddenSystemSession: true }, updatedAt: 60 }),
            ],
        });

        expect(targets.map((target) => target.id)).toEqual(['writable-edit', 'writable-owner']);
    });

    it('orders destinations by the same stable updated buckets as the session list', () => {
        const fiveMinuteBucketMs = 5 * 60_000;
        const targets = resolveTranscriptSendToSessionTargets({
            sourceSessionId: 'source',
            sourceServerId: 'server-a',
            sessions: [
                candidate({ id: 'older-bucket', meaningfulActivityAt: fiveMinuteBucketMs * 9, updatedAt: 10_000, createdAt: 300 }),
                candidate({ id: 'newer-created', meaningfulActivityAt: fiveMinuteBucketMs * 10 + 1, updatedAt: 100, createdAt: 200 }),
                candidate({ id: 'older-created', meaningfulActivityAt: fiveMinuteBucketMs * 10 + 120_000, updatedAt: 10_100, createdAt: 100 }),
                candidate({ id: 'created-fallback', updatedAt: 0, createdAt: fiveMinuteBucketMs * 11 }),
            ],
        });

        expect(targets.map((target) => target.id)).toEqual([
            'created-fallback',
            'newer-created',
            'older-created',
            'older-bucket',
        ]);
    });

    it('keeps writable destination sessions whose server id is equivalent to the source server identity', async () => {
        const profile = await upsertServerProfile({
            serverUrl: 'https://send-targets.example.test',
            name: 'Send Targets',
            source: 'manual',
        });
        await setServerProfileIdentityForUrl(profile.serverUrl, 'srv_send_targets');

        const targets = resolveTranscriptSendToSessionTargets({
            sourceSessionId: 'source',
            sourceServerId: 'srv_send_targets',
            sessions: [
                candidate({ id: 'source', serverId: profile.id }),
                candidate({ id: 'same-server-profile-id', serverId: profile.id, access: createSessionAccessFixture('edit'), updatedAt: 40 }),
                candidate({ id: 'different-server', serverId: 'server-b', access: createSessionAccessFixture('edit'), updatedAt: 30 }),
            ],
        });

        expect(targets.map((target) => target.id)).toEqual(['same-server-profile-id']);
    });
});
