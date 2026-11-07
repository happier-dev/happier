import { describe, expect, it } from 'vitest';

import {
    collectConfiguredProviderUsageRefreshTargets,
    parseLatestProviderUsageRecordIds,
    selectLatestProviderUsageRecordIdsByAgent,
    serializeLatestProviderUsageRecordIds,
} from './providerUsageRefreshTargets';

describe('configured provider refresh targets', () => {
    it('includes every connected profile and the newest native account per provider, using runtime identity', () => {
        const metadata = (flavor: string, recordIds: string[]) => ({
            flavor, providerAccountUsageRefsV1: { v: 1, recordIds, updatedAtMs: 1_000 },
        });
        expect(collectConfiguredProviderUsageRefreshTargets({
            connectedServices: [
                { serviceId: 'anthropic', profiles: [{ profileId: 'work' }, { profileId: 'personal' }, { profileId: ' ' }] },
                { serviceId: 'openai-codex', profiles: [{ profileId: 'default' }] },
                { serviceId: 'gemini', profiles: [] },
            ],
            latestRecordIdsByAgent: selectLatestProviderUsageRecordIdsByAgent([
                { metadata: { ...metadata('claude', ['paug_v1_abcdefgh']),
                    agentRuntimeDescriptorV1: { v: 1, providerId: 'codex', provider: { backendMode: 'mcp' } } } },
                { metadata: metadata('claude', []) },
                { metadata: metadata('claude', ['paug_v1_ijklmnop']) },
                { metadata: metadata('codex', ['paug_v1_oldoldxx']) },
                { metadata: metadata('unknown', ['paug_v1_unknownx']) },
            ]),
        })).toEqual([
            { connectedProfileRef: { serviceId: 'anthropic', profileId: 'work' }, recordIds: [] },
            { connectedProfileRef: { serviceId: 'anthropic', profileId: 'personal' }, recordIds: [] },
            { connectedProfileRef: { serviceId: 'openai-codex', profileId: 'default' }, recordIds: [] },
            { connectedProfileRef: null, recordIds: ['paug_v1_abcdefgh'] },
            { connectedProfileRef: null, recordIds: ['paug_v1_ijklmnop'] },
        ]);
    });

    it('round-trips the latest record ids through a value-comparable signature', () => {
        const records = new Map([['claude', ['paug_v1_aaaaaaaa', 'paug_v1_bbbbbbbb']], ['codex', ['paug_v1_cccccccc']], ['opencode', []]] as const);
        const signature = serializeLatestProviderUsageRecordIds(records as never);
        expect(parseLatestProviderUsageRecordIds(signature)).toEqual(records);
        expect(serializeLatestProviderUsageRecordIds(parseLatestProviderUsageRecordIds(signature))).toBe(signature);
        expect(parseLatestProviderUsageRecordIds('').size).toBe(0);
    });

    it('retains providers used without quota support, while still finding older quota references', () => {
        expect(selectLatestProviderUsageRecordIdsByAgent([
            { metadata: { flavor: 'claude' } },
            { metadata: { flavor: 'opencode' } },
            { metadata: { flavor: 'claude', providerAccountUsageRefsV1: { v: 1, recordIds: ['paug_v1_abcdefgh'], updatedAtMs: 1_000 } } },
        ])).toEqual(new Map([['claude', ['paug_v1_abcdefgh']], ['opencode', []]]));
    });
});
