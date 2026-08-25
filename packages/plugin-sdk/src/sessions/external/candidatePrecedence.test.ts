import { describe, expect, it } from 'vitest';

import {
    MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES,
    MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_DEPTH,
    MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_ENTRIES,
} from '@happier-dev/protocol';

import {
    compareExternalSessionCandidatePrecedence,
    resolveExternalSessionCandidateIdentityKey,
} from './candidatePrecedence.js';

function nestedLinkData(depth: number): unknown {
    let value: unknown = true;
    for (let index = 0; index < depth; index += 1) {
        value = { nested: value };
    }
    return value;
}

function serializedUtf8Bytes(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

describe('external-session candidate precedence', () => {
    it('deterministically selects one private candidate for equal public identity fields', () => {
        const projectA = {
            remoteSessionId: 'shared-session',
            updatedAtMs: 10,
            linkData: { projectId: 'project-a' },
        } as const;
        const projectB = {
            remoteSessionId: 'shared-session',
            updatedAtMs: 10,
            linkData: { projectId: 'project-b' },
        } as const;

        const projectAIdentity = resolveExternalSessionCandidateIdentityKey(projectA);
        const projectBIdentity = resolveExternalSessionCandidateIdentityKey(projectB);

        expect(projectAIdentity).toBe('ce2bf8daa817f2096a071d7a1d7d8f64127d4a20458dffdfcb7ab40ddf16cc60');
        expect(projectBIdentity).toMatch(/^[a-f0-9]{64}$/u);
        expect(projectAIdentity).not.toBe(projectBIdentity);
        expect(resolveExternalSessionCandidateIdentityKey({
            remoteSessionId: 'shared-session',
            linkData: { last: 'z', first: 'a' },
        })).toBe(resolveExternalSessionCandidateIdentityKey({
            remoteSessionId: 'shared-session',
            linkData: { first: 'a', last: 'z' },
        }));
        expect(compareExternalSessionCandidatePrecedence(projectA, projectB)).toBeLessThan(0);
        expect([projectB, projectA].sort(compareExternalSessionCandidatePrecedence)).toEqual([
            projectA,
            projectB,
        ]);
    });

    it('includes an own __proto__ JSON field in private candidate identity', () => {
        const linkDataA = JSON.parse('{"__proto__":{"projectId":"project-a"}}') as Record<string, unknown>;
        const linkDataB = JSON.parse('{"__proto__":{"projectId":"project-b"}}') as Record<string, unknown>;

        expect(Object.prototype.hasOwnProperty.call(linkDataA, '__proto__')).toBe(true);
        expect(resolveExternalSessionCandidateIdentityKey({
            remoteSessionId: 'shared-session',
            linkData: linkDataA,
        })).not.toBe(resolveExternalSessionCandidateIdentityKey({
            remoteSessionId: 'shared-session',
            linkData: linkDataB,
        }));
    });

    it('admits candidate link data only through Protocol external-session admission', () => {
        const identity = (linkData: unknown): string => resolveExternalSessionCandidateIdentityKey({
            remoteSessionId: 'shared-session',
            linkData,
        });
        const rejected = /External-session candidate identity requires strict JSON link data/u;

        expect(() => identity(nestedLinkData(MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_DEPTH))).not.toThrow();
        expect(() => identity(nestedLinkData(MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_DEPTH + 1))).toThrow(rejected);

        const atEntryLimit = Object.fromEntries(Array.from(
            { length: MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_ENTRIES },
            (_, index) => [`key-${index}`, index],
        ));
        const overEntryLimit = Object.fromEntries(Array.from(
            { length: MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_ENTRIES + 1 },
            (_, index) => [`key-${index}`, index],
        ));
        expect(() => identity(atEntryLimit)).not.toThrow();
        expect(() => identity(overEntryLimit)).toThrow(rejected);

        const emptyValueBytes = serializedUtf8Bytes({ value: '' });
        expect(() => identity({
            value: 'x'.repeat(MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES - emptyValueBytes),
        })).not.toThrow();
        expect(() => identity({
            value: 'x'.repeat(MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES - emptyValueBytes + 1),
        })).toThrow(rejected);

        let getterCalls = 0;
        const accessor = {};
        Object.defineProperty(accessor, 'workspace', {
            enumerable: true,
            get() {
                getterCalls += 1;
                return 'demo';
            },
        });
        const sparse: unknown[] = [];
        sparse.length = 1;
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        class NonPlainLinkData {
            readonly workspace = 'demo';
        }
        for (const malformed of [accessor, new NonPlainLinkData(), { values: sparse }, cycle]) {
            expect(() => identity(malformed)).toThrow(rejected);
        }
        expect(getterCalls).toBe(0);
    });
});
