import { describe, expect, it } from 'vitest';

describe('browser address normalization', () => {
    it('keeps IPv6 Machine loopback links eligible for in-app address resolution', async () => {
        const { resolveExternalUrlTargetFromInput } = await import('./address');
        expect(resolveExternalUrlTargetFromInput('http://[::1]:5173/docs?tab=1#intro'))
            .toMatchObject({ kind: 'externalUrl', url: 'http://[::1]:5173/docs?tab=1#intro' });
    });
    it('normalizes absolute URLs, localhost addresses, domain-like input, and configured search terms', async () => {
        const mod = await import('./address').catch(() => null);

        expect(mod).not.toBeNull();
        if (!mod) return;

        expect(mod.normalizeBrowserAddressInput('https://example.com/app')).toEqual({
            ok: true,
            url: 'https://example.com/app',
        });
        expect(mod.normalizeBrowserAddressInput('localhost:5173')).toEqual({
            ok: true,
            url: 'http://localhost:5173/',
        });
        expect(mod.normalizeBrowserAddressInput('example.com/docs')).toEqual({
            ok: true,
            url: 'https://example.com/docs',
        });
        expect(mod.normalizeBrowserAddressInput('find happier docs', {
            searchUrlTemplate: 'https://search.example/?q={query}',
        })).toEqual({
            ok: true,
            url: 'https://search.example/?q=find%20happier%20docs',
        });
    });

    it('searches with the default engine when the host configures none, so a typed query never dead-ends (H-UX F-16)', async () => {
        const mod = await import('./address');

        expect(mod.normalizeBrowserAddressInput('find happier docs')).toEqual({
            ok: true,
            url: 'https://duckduckgo.com/?q=find%20happier%20docs',
        });
    });
});

describe('formatBrowserDisplayUrl', () => {
    it('trims scheme, leading www, and trailing slash for a clean blurred display', async () => {
        const { formatBrowserDisplayUrl } = await import('./address');

        expect(formatBrowserDisplayUrl('https://example.com/')).toBe('example.com');
        expect(formatBrowserDisplayUrl('https://www.example.com')).toBe('example.com');
        expect(formatBrowserDisplayUrl('http://www.example.com/')).toBe('example.com');
    });

    it('keeps the path, query, and fragment while trimming the scheme', async () => {
        const { formatBrowserDisplayUrl } = await import('./address');

        expect(formatBrowserDisplayUrl('https://example.com/docs/guide?tab=1#intro'))
            .toBe('example.com/docs/guide?tab=1#intro');
        // A trailing slash on a non-root path is preserved (it is meaningful).
        expect(formatBrowserDisplayUrl('https://example.com/docs/')).toBe('example.com/docs/');
    });

    it('keeps localhost addresses readable including the port', async () => {
        const { formatBrowserDisplayUrl } = await import('./address');

        expect(formatBrowserDisplayUrl('http://localhost:3000')).toBe('localhost:3000');
        expect(formatBrowserDisplayUrl('http://localhost:5173/dashboard'))
            .toBe('localhost:5173/dashboard');
    });

    it('returns an empty string for null and falls back to the raw value for non-http input', async () => {
        const { formatBrowserDisplayUrl } = await import('./address');

        expect(formatBrowserDisplayUrl(null)).toBe('');
        expect(formatBrowserDisplayUrl('')).toBe('');
        expect(formatBrowserDisplayUrl('not a url')).toBe('not a url');
        expect(formatBrowserDisplayUrl('about:blank')).toBe('about:blank');
    });
});

describe('relay preview address display', () => {
    const previewView = (overrides: Record<string, unknown> = {}) => ({
        target: { kind: 'localServicePreview', targetId: 'preview:1', machineId: 'machine_1', display: { title: 'Lumen', addressLabel: 'localhost:42511' } },
        currentUrl: 'https://preview-abc123.example.test/docs/start',
        pendingUrl: null,
        ...overrides,
    }) as never;

    it('shows the exposed service instead of the opaque isolated host, keeping the path', async () => {
        const { formatBrowserDisplayUrl, selectBrowserViewDisplayHost } = await import('./address');
        const view = previewView();
        const displayHost = selectBrowserViewDisplayHost(view);

        expect(displayHost).toBe('localhost:42511');
        expect(formatBrowserDisplayUrl('https://preview-abc123.example.test/docs/start', { displayHost })).toBe('localhost:42511/docs/start');
        expect(formatBrowserDisplayUrl('https://preview-abc123.example.test/', { displayHost, hostOnly: true })).toBe('localhost:42511');
        // The preview's own query stays; its admission never reaches the address (the control reducer owns that).
        expect(formatBrowserDisplayUrl('https://preview-abc123.example.test/docs?tab=1', { displayHost })).toBe('localhost:42511/docs?tab=1');
    });

    it('does not rename an address that is no longer the preview: a pending page on another origin, or another target kind', async () => {
        const { selectBrowserViewDisplayHost } = await import('./address');

        expect(selectBrowserViewDisplayHost(previewView({ pendingUrl: 'https://example.com/' }))).toBeUndefined();
        expect(selectBrowserViewDisplayHost(previewView({ pendingUrl: 'https://preview-abc123.example.test/next' }))).toBe('localhost:42511');
        expect(selectBrowserViewDisplayHost(previewView({ target: { kind: 'externalUrl', targetId: 'x', url: 'https://example.com/', display: { title: 'Example', addressLabel: 'example.com' } } }))).toBeUndefined();
        expect(selectBrowserViewDisplayHost(previewView({ target: { kind: 'localServicePreview', targetId: 'p', machineId: 'm' } }))).toBeUndefined();
        expect(selectBrowserViewDisplayHost(null)).toBeUndefined();
    });
});
