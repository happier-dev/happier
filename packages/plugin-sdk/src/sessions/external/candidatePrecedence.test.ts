import { describe, expect, it } from 'vitest';

import {
    compareExternalSessionCandidatePrecedence,
    resolveExternalSessionCandidateIdentityKey,
} from './candidatePrecedence.js';

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

        expect(projectAIdentity).toMatch(/^[a-f0-9]{64}$/u);
        expect(projectBIdentity).toMatch(/^[a-f0-9]{64}$/u);
        expect(projectAIdentity).not.toBe(projectBIdentity);
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
});
