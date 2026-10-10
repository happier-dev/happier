import { describe, expect, it, vi } from 'vitest';

// Locale is an environment boundary; the line's grouping and order stay real.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: ((key: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key) as never });
});

import { describeConversationSearchCoverage } from './conversationSearchCoverage';

const names: Record<string, string> = { a: 'MacBook Pro', b: 'Studio', c: 'devbox', d: 'mini' };
const machineName = (id: string) => names[id] ?? id;
const machine = (machineId: string, status: 'ok' | 'offline' | 'outdated' | 'partial' | 'disabled-by-settings') =>
    ({ machineId, status, standardSearchEnabled: true });

describe('describeConversationSearchCoverage', () => {
    it('says nothing when every machine answered in full', () => {
        expect(describeConversationSearchCoverage({ machines: [machine('a', 'ok'), machine('b', 'ok')], homeStatus: 'ok', machineName })).toBe('');
    });

    it('names each machine under the reason it was not covered, most blocking first', () => {
        const line = describeConversationSearchCoverage({
            machines: [machine('a', 'partial'), machine('b', 'offline'), machine('c', 'outdated'), machine('d', 'offline')],
            machineName,
        });
        expect(line).toBe([
            'conversationSearch.coverageOffline:{"machines":"Studio, mini"}',
            'conversationSearch.coverageOutdated:{"machines":"devbox"}',
            'conversationSearch.coveragePartial:{"machines":"MacBook Pro"}',
        ].join(' · '));
    });

    it('leaves out a gap the surface does not report, and still reports an unavailable Home', () => {
        const line = describeConversationSearchCoverage({
            machines: [machine('a', 'disabled-by-settings'), machine('b', 'ok')],
            homeStatus: 'unavailable', machineName, omit: ['disabled-by-settings'],
        });
        expect(line).toBe('conversationSearch.coverageHomeUnavailable');
    });
});
