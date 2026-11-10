import { describe, expect, it, vi } from 'vitest';
import { openMarkdownLinkUrl, sanitizeEnrichedMarkdownLinkTargets } from './enrichedMarkdownLinkHandling';

describe('Markdown app link dispatch', () => {
    it('opens app links inside this client before workspace-file handling', async () => {
        const openAppHref = vi.fn(() => true);
        const onLinkPress = vi.fn(() => true);
        const openUrl = vi.fn(async () => {});
        const unavailable = vi.fn();
        const url = 'happier://settings/machines/add?path=anotherComputer';
        expect(sanitizeEnrichedMarkdownLinkTargets(`[Add machine](${url})`)).toContain(url);
        await openMarkdownLinkUrl(url, openUrl, { openAppHref, onLinkPress, unavailable });
        expect(openAppHref).toHaveBeenCalledWith('/settings/machines/add?path=anotherComputer');
        expect(onLinkPress).not.toHaveBeenCalled();
        expect(openUrl).not.toHaveBeenCalled();
        expect(unavailable).not.toHaveBeenCalled();
    });

    it('keeps unsupported and malformed app links harmless and visible', async () => {
        const openAppHref = vi.fn(() => false);
        const onLinkPress = vi.fn();
        const openUrl = vi.fn(async () => {});
        const unavailable = vi.fn();
        for (const url of ['happier://unknown-screen', 'happier://%', 'happier://capture']) {
            await openMarkdownLinkUrl(url, openUrl, { openAppHref, onLinkPress, unavailable });
        }
        expect(unavailable).toHaveBeenCalledTimes(3);
        expect(onLinkPress).not.toHaveBeenCalled();
        expect(openUrl).not.toHaveBeenCalled();
    });

    it('preserves relative file interception and ordinary external opening', async () => {
        const openAppHref = vi.fn(() => true);
        const onLinkPress = vi.fn((url: string) => url === './src/main.ts');
        const openUrl = vi.fn(async () => {});
        const unavailable = vi.fn();
        await openMarkdownLinkUrl('./src/main.ts', openUrl, { openAppHref, onLinkPress, unavailable });
        await openMarkdownLinkUrl('https://example.com', openUrl, { openAppHref, onLinkPress, unavailable });
        expect(onLinkPress).toHaveBeenCalledWith('./src/main.ts');
        expect(openUrl).toHaveBeenCalledWith('https://example.com');
        expect(openAppHref).not.toHaveBeenCalled();
        expect(unavailable).not.toHaveBeenCalled();
    });
});
