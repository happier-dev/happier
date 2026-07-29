import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('cached Intl date/time formatters', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.restoreAllMocks();
    });

    it('reuses DateTimeFormat instances for equivalent locale and option sets', async () => {
        const formatSpy = vi.fn(() => 'formatted');
        const constructorSpy = vi
            .spyOn(Intl, 'DateTimeFormat')
            .mockImplementation((() => ({ format: formatSpy })) as unknown as typeof Intl.DateTimeFormat);
        const { formatWithCachedDateTimeFormatter } = await import('./cachedIntlFormatters');

        expect(formatWithCachedDateTimeFormatter(new Date(1), undefined, { timeStyle: 'short', dateStyle: 'medium' }))
            .toBe('formatted');
        expect(formatWithCachedDateTimeFormatter(new Date(2), undefined, { dateStyle: 'medium', timeStyle: 'short' }))
            .toBe('formatted');
        expect(formatWithCachedDateTimeFormatter(new Date(3), undefined, { hour: 'numeric' }))
            .toBe('formatted');

        expect(constructorSpy).toHaveBeenCalledTimes(2);
        expect(formatSpy).toHaveBeenCalledTimes(3);
    });
});
