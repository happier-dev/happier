import { describe, expect, it } from 'vitest';
import {
    ProjectAccountRowPayloadV1Schema,
    ProjectAccountRowReadRequestV1Schema,
    ProjectAccountRowReadResponseV1Schema,
    ProjectAccountRowAuthoringSessionRequestV1Schema,
    ProjectAccountRowContentV1Schema,
    ProjectAccountRowListRequestV1Schema,
    StoredProjectAccountRowPayloadV1Schema,
    assertProjectAccountRowPayloadBindingV1,
    buildProjectAccountRowPhysicalKeyV1,
    parseProjectAccountRowPhysicalKeyV1,
} from './projectAccountRowsV1.js';

const key = { kind: 'workspace-ref', serverId: 'home/a', id: 'ref/a' } as const;
const value = { id: key.id, serverId: key.serverId, machineId: 'machine-a', rootPath: '/repo/a', label: 'a', createdAtMs: 1 };

describe('Project Account row persistence admission', () => {
    it('round-trips optional reference-only Project bindings through the stored row reader', () => {
        const organizationKey = { kind: 'project-organization', serverId: 'home', projectKey: 'project' } as const;
        const environmentBindings = { v: 1, bindings: {
            API_KEY: { ref: 'personal-secret' }, SHARED_KEY: { ref: 'happier:shared-secret:v1:resource', revision: 2 },
        } };
        const payload = { key: organizationKey, value: { label: 'Project', environmentBindings } };
        expect(StoredProjectAccountRowPayloadV1Schema.parse(ProjectAccountRowPayloadV1Schema.parse(payload))).toEqual(payload);
        expect(StoredProjectAccountRowPayloadV1Schema.parse({ key: organizationKey, value: { label: 'Earlier Project' } }))
            .toEqual({ key: organizationKey, value: { label: 'Earlier Project' } });
        for (const invalid of [
            { v: 1, bindings: {} },
            { v: 1, bindings: { API_KEY: { ref: 'personal-secret', value: 'secret' } } },
            { v: 1, bindings: { SHARED_KEY: { ref: 'happier:shared-secret:v1:resource' } } },
        ]) expect(ProjectAccountRowPayloadV1Schema.safeParse({ ...payload, value: { environmentBindings: invalid } }).success).toBe(false);
    });
    it('admits optional id-only authoring provenance without widening private content', () => {
        const authoringSession = { serverId: 'session-home', sessionId: 'session-a' };
        expect(ProjectAccountRowReadRequestV1Schema.safeParse({ key, includeAuthoringSession: true }).success).toBe(true);
        expect(ProjectAccountRowReadResponseV1Schema.safeParse({ status: 'present', row: {
            key, revision: 1, content: { t: 'plain', v: { key, value } }, authoringSession,
        } }).success).toBe(true);
        expect(ProjectAccountRowReadResponseV1Schema.safeParse({ status: 'present', row: {
            key, revision: 1, content: { t: 'plain', v: { key, value } }, authoringSession: { ...authoringSession, title: 'private' },
        } }).success).toBe(false);
        expect(ProjectAccountRowAuthoringSessionRequestV1Schema.parse({ key, session: authoringSession })).toEqual({ key, session: authoringSession });
        expect(ProjectAccountRowAuthoringSessionRequestV1Schema.safeParse({ key: { kind: 'relationship-graph' }, session: authoringSession }).success).toBe(false);
        expect(ProjectAccountRowAuthoringSessionRequestV1Schema.safeParse({ key, session: { ...authoringSession, sessionId: ' session ' } }).success).toBe(false);
        expect(ProjectAccountRowContentV1Schema.safeParse({ t: 'plain', v: { key, value }, authoringSession }).success).toBe(false);
    });
    it('keeps navigation recency out of strict structural writes and canonical stored projections', () => {
        const historical = { key, value: { ...value, lastOpenedAtMs: 123 } };
        expect(ProjectAccountRowPayloadV1Schema.safeParse(historical).success).toBe(false);
        expect(StoredProjectAccountRowPayloadV1Schema.parse(historical)).toEqual({ key, value });
        expect(ProjectAccountRowPayloadV1Schema.safeParse({ key, value: { ...value, label: false } }).success).toBe(false);
    });

    it('binds opened payloads to the qualified physical identity and rejects alternate encodings', () => {
        const physical = buildProjectAccountRowPhysicalKeyV1(key);
        expect(parseProjectAccountRowPhysicalKeyV1(physical)).toEqual(key);
        expect(parseProjectAccountRowPhysicalKeyV1(physical.replace('%2F', '%2f'))).toBeNull();
        expect(() => assertProjectAccountRowPayloadBindingV1({ ...key, serverId: 'foreign-home' }, { key, value })).toThrow();
        expect(() => assertProjectAccountRowPayloadBindingV1(key, { key, value: { ...value, id: 'foreign-ref' } })).toThrow();
    });

    it('keeps the person\'s pinned services as one private row per Home, outside the default census', () => {
        const services = { kind: 'services-organization', serverId: 'home/a' } as const;
        const physical = buildProjectAccountRowPhysicalKeyV1(services);
        expect(parseProjectAccountRowPhysicalKeyV1(physical)).toEqual(services);
        // Its own family: never inside the Project organization or checkout prefixes an older reader lists.
        for (const family of ['ref/', 'organization/', 'graph']) expect(physical).not.toContain(family);
        const payload = { key: services, value: { pinnedEnvironmentIds: ['env-b', 'env-a'] } };
        expect(StoredProjectAccountRowPayloadV1Schema.parse(ProjectAccountRowPayloadV1Schema.parse(payload))).toEqual(payload);
        expect(() => assertProjectAccountRowPayloadBindingV1({ ...services, serverId: 'foreign-home' }, payload)).toThrow();
        for (const invalid of [{ pinnedEnvironmentIds: ['env-a', 'env-a'] }, { pinnedEnvironmentIds: [''] }, { pinned: true }]) {
            expect(ProjectAccountRowPayloadV1Schema.safeParse({ key: services, value: invalid }).success).toBe(false);
        }
        expect(ProjectAccountRowListRequestV1Schema.safeParse({ kinds: ['services-organization'] }).success).toBe(true);
    });
});
