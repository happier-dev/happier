import { describe, expect, it } from 'vitest';

import type { ManagedServerSnapshotV1 } from '@happier-dev/plugin-sdk';

import {
    describeManagedServerIdentityForLog,
    isSameManagedServerGeneration,
    resolveManagedServerIdentity,
} from './managedServerIdentity';

function snapshot(overrides: Partial<ManagedServerSnapshotV1> = {}): ManagedServerSnapshotV1 {
    return {
        id: 'opencode-server',
        state: 'healthy',
        mode: 'managed-spawn',
        baseUrl: 'http://127.0.0.1:43111',
        port: 43111,
        credentialEnvKey: 'HAPPIER_OPENCODE_SERVER_TOKEN',
        pid: 4242,
        startedAt: 1_000,
        lastHealthyAt: 1_500,
        lastErrorMessage: null,
        ...overrides,
    };
}

describe('resolveManagedServerIdentity', () => {
    it('produces a stable generation key for the same process generation', () => {
        const a = resolveManagedServerIdentity(snapshot());
        const b = resolveManagedServerIdentity(snapshot({ lastHealthyAt: 9_999 }));

        // lastHealthyAt is liveness, not identity — it must not change the generation key.
        expect(a.generationKey).toBe(b.generationKey);
        expect(isSameManagedServerGeneration(a, b)).toBe(true);
    });

    it('changes the generation key when the process is replaced (new pid / startedAt / baseUrl)', () => {
        const original = resolveManagedServerIdentity(snapshot());
        const newPid = resolveManagedServerIdentity(snapshot({ pid: 5555 }));
        const newStart = resolveManagedServerIdentity(snapshot({ startedAt: 2_000 }));
        const newPort = resolveManagedServerIdentity(snapshot({ baseUrl: 'http://127.0.0.1:50000', port: 50000 }));

        expect(original.generationKey).not.toBe(newPid.generationKey);
        expect(original.generationKey).not.toBe(newStart.generationKey);
        expect(original.generationKey).not.toBe(newPort.generationKey);
        expect(isSameManagedServerGeneration(original, newPid)).toBe(false);
    });

    it('treats two null identities as the same generation and a null vs present as different', () => {
        const present = resolveManagedServerIdentity(snapshot());
        expect(isSameManagedServerGeneration(null, null)).toBe(true);
        expect(isSameManagedServerGeneration(present, null)).toBe(false);
        expect(isSameManagedServerGeneration(null, present)).toBe(false);
    });

    it('returns a redacted, log-safe summary that never includes the raw credential env value', () => {
        const identity = resolveManagedServerIdentity(snapshot());
        const described = describeManagedServerIdentityForLog(identity);

        expect(described).toMatchObject({ baseUrl: 'http://127.0.0.1:43111', pid: 4242 });
        // The generation key is a hash; it should be present but truncated.
        expect(typeof described.generationKey).toBe('string');
        expect((described.generationKey as string).length).toBeLessThan(identity.generationKey.length);
        expect(describeManagedServerIdentityForLog(null)).toEqual({ present: false });
    });
});
