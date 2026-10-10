import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

import { t } from '@/text';
import { describeWorkPaneLine } from './workPaneLine';

const summary = (over: Partial<Parameters<typeof describeWorkPaneLine>[0]>) => ({ outstanding: 0, needsYou: 0, stalled: 0, sessions: 0, runs: 0, ...over });

describe('describeWorkPaneLine (lab convo-W1 header sub)', () => {
    it('leads with what needs the person, then what is still working', () => {
        expect(describeWorkPaneLine(summary({ outstanding: 7, needsYou: 1, sessions: 4, runs: 3 }))).toEqual([
            { text: t('sessionWork.strip.needsYou', { count: 1 }), attention: true },
            t('sessionWork.list.reportsWorking', { count: 6 }),
        ]);
    });

    it('says only what is working while nothing waits on the person', () => {
        expect(describeWorkPaneLine(summary({ outstanding: 2, sessions: 2 }))).toEqual([t('sessionWork.list.reportsWorking', { count: 2 })]);
    });

    it('counts what it leads once everything has settled, and says nothing for no work', () => {
        expect(describeWorkPaneLine(summary({ sessions: 2, runs: 1 }))).toEqual([
            t('sessionWork.subtitle.sessions', { count: 2 }), t('sessionWork.subtitle.runs', { count: 1 }),
        ]);
        expect(describeWorkPaneLine(summary({}))).toEqual([]);
    });
});
