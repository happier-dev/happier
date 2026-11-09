import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';

export const USAGE_SESSION_FACT_KINDS = ['work', 'coach'] as const;
export type UsageSessionFactKindV1 = typeof USAGE_SESSION_FACT_KINDS[number];
export const UsageSessionFactKindV1Schema = lazyZodSchema(() => z.enum(USAGE_SESSION_FACT_KINDS));

const addresses = {
    work: Object.freeze({ owner: 'host', namespace: 'usage', kind: 'work_facts.v1', localId: 'work' } as const),
    coach: Object.freeze({ owner: 'host', namespace: 'usage', kind: 'work_facts.v1', localId: 'coach' } as const),
};
export const USAGE_SESSION_WORK_FACTS_SYSTEM_RECORD_ADDRESS = addresses.work;

export function getUsageSessionFactRecordAddress(kind: UsageSessionFactKindV1) {
    return addresses[kind];
}

/** A Coach surface adds its private evidence to the ordinary work-fact read. */
export function getUsageSessionFactKinds(query: Readonly<{ includeCoach?: boolean }>): readonly UsageSessionFactKindV1[] {
    return query.includeCoach === false ? ['work'] : USAGE_SESSION_FACT_KINDS;
}

export function isUsageSessionFactRecordAddress(address: Readonly<{
    owner: string; namespace: string; kind: string; localId: string;
}>): boolean {
    return USAGE_SESSION_FACT_KINDS.some(kind => {
        const expected = addresses[kind];
        return address.owner === expected.owner && address.namespace === expected.namespace
            && address.kind === expected.kind && address.localId === expected.localId;
    });
}
