import { describe, expect, it } from 'vitest';
import {
    ProjectAccountRowPayloadV1Schema,
    StoredProjectAccountRowPayloadV1Schema,
    assertProjectAccountRowPayloadBindingV1,
    buildProjectAccountRowPhysicalKeyV1,
    parseProjectAccountRowPhysicalKeyV1,
} from './projectAccountRowsV1.js';

const key = { kind: 'workspace-ref', serverId: 'home/a', id: 'ref/a' } as const;
const value = { id: key.id, serverId: key.serverId, machineId: 'machine-a', rootPath: '/repo/a', label: 'a', createdAtMs: 1 };

describe('Project Account row persistence admission', () => {
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
});
