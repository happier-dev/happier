import { describe, expect, it } from 'vitest';
import { resolveNativeSessionAlias } from './nativeSessionAlias';

const assignment = (providerSessionId: string, assignedAt: number, observedAt: number) => ({
    providerId: 'claude', providerSessionId, alias: 'happier-6e', assignedAt, observedAt,
});
const target = (id: string, assignments: ReturnType<typeof assignment>[]) => ({
    id,
    metadata: { machineId: 'machine', nativeSessionAliasesV1: { v: 1, assignments } },
});

describe('historical native session alias identity', () => {
    it('uses assignment time evidence, preserves reuse history, and refuses ambiguity', () => {
        const sessions = [target('first', [assignment('native-first', 100, 200)]), target('second', [assignment('native-second', 300, 400)])];
        const resolve = (createdAt: number, candidates = sessions) => resolveNativeSessionAlias({
            alias: 'happier-6e', createdAt, machineId: 'machine', sessions: candidates,
        });
        expect(resolve(150)).toBe('first');
        expect(resolve(350)).toBe('second');
        expect(resolve(250)).toBeNull();
        expect(resolve(99)).toBeNull();
        expect(resolve(401)).toBeNull();
        expect(resolve(150, [...sessions, target('conflicting', [assignment('another-native', 125, 175)])])).toBeNull();
        expect(resolveNativeSessionAlias({ alias: 'happier-eb', createdAt: 150, machineId: 'machine', sessions })).toBeNull();
        expect(resolveNativeSessionAlias({ alias: 'happier-6e', createdAt: 150, machineId: 'other-machine', sessions })).toBeNull();
        expect(resolveNativeSessionAlias({ alias: 'happier-6e', createdAt: 150, machineId: null, sessions })).toBeNull();
    });

    it('does not infer aliases from session titles or Happier/provider ID suffixes', () => {
        expect(resolveNativeSessionAlias({
            alias: 'happier-6e', createdAt: 150, machineId: 'machine',
            sessions: [{ id: 'happier-6e', metadata: { machineId: 'machine', name: 'happier-6e', claudeSessionId: '6e' } }],
        })).toBeNull();
    });
});
