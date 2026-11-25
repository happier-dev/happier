import { describe, expect, it } from 'vitest';

import { ru } from './translations/ru';

const work = ru.usage.board.work;

describe('Russian Usage plurals', () => {
    it.each([
        [1, 'сессия', 'связанный PR'],
        [2, 'сессии', 'связанных PR'],
        [5, 'сессий', 'связанных PR'],
        [11, 'сессий', 'связанных PR'],
        [21, 'сессия', 'связанный PR'],
    ])('declines the ledger row line for %i', (count, session, pullRequest) => {
        expect(work.ledgerRowLine({ sessions: count, prs: count })).toBe(`${count} ${session} · ${count} ${pullRequest}`);
    });

    it('declines the Session count caption and the PR line', () => {
        expect(work.valueCaption({ count: 3 })).toBe('3 сессии');
        // J-B56: the plural comes from the integer, the grouped figure is only what is shown.
        expect(work.valueCaption({ count: 1021, shown: '1 021' })).toBe('1 021 сессия');
        expect(work.prLine({ sessions: 22, state: 'открыт' })).toBe('22 сессии · открыт');
    });
});
