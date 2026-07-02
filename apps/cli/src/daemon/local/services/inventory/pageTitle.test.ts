import { describe, expect, it } from 'vitest';

import { createLocalPageTitleEnricher, extractLocalPageTitle, isLocalPageTitleHost } from './pageTitle';

describe('extractLocalPageTitle', () => {
    it('prefers application metadata before html title', () => {
        expect(extractLocalPageTitle(`
            <html>
                <head>
                    <title>Fallback</title>
                    <meta name="application-name" content="Happier App" />
                </head>
            </html>
        `)).toEqual({ title: 'Happier App', source: 'application_name' });
    });
});

describe('isLocalPageTitleHost', () => {
    it('allows local/private hosts and rejects public hosts', () => {
        expect(isLocalPageTitleHost('127.0.0.1')).toBe(true);
        expect(isLocalPageTitleHost('localhost')).toBe(true);
        expect(isLocalPageTitleHost('192.168.1.20')).toBe(true);
        expect(isLocalPageTitleHost('fd00::1')).toBe(true);
        expect(isLocalPageTitleHost('fd00.example.com')).toBe(false);
        expect(isLocalPageTitleHost('8.8.8.8')).toBe(false);
        expect(isLocalPageTitleHost('example.com')).toBe(false);
    });
});

describe('createLocalPageTitleEnricher', () => {
    it('refuses redirects to public hosts and reads only bounded local html prefixes', async () => {
        const enricher = createLocalPageTitleEnricher({
            timeoutMs: 100,
            maxBodyBytes: 64,
            concurrency: 1,
            successTtlMs: 1_000,
            failureTtlMs: 1_000,
            fetch: async (url) => {
                if (url === 'http://127.0.0.1:5173/') {
                    return {
                        status: 302,
                        headers: new Headers({ location: 'https://example.com/' }),
                        body: null,
                    } as Response;
                }
                throw new Error(`unexpected fetch ${url}`);
            },
        });

        await expect(enricher.fetchTitle('http://127.0.0.1:5173/')).resolves.toBeNull();
    });

    it('does not fetch non-http local URLs', async () => {
        let called = false;
        const enricher = createLocalPageTitleEnricher({
            timeoutMs: 100,
            maxBodyBytes: 64,
            concurrency: 1,
            successTtlMs: 1_000,
            failureTtlMs: 1_000,
            fetch: async () => {
                called = true;
                throw new Error('unexpected fetch');
            },
        });

        await expect(enricher.fetchTitle('file://localhost/etc/passwd')).resolves.toBeNull();
        expect(called).toBe(false);
    });

    it('treats malformed title URLs as unavailable instead of rejecting', async () => {
        let called = false;
        const enricher = createLocalPageTitleEnricher({
            timeoutMs: 100,
            maxBodyBytes: 64,
            concurrency: 1,
            successTtlMs: 1_000,
            failureTtlMs: 1_000,
            fetch: async () => {
                called = true;
                throw new Error('unexpected fetch');
            },
        });

        await expect(enricher.fetchTitle('not a url')).resolves.toBeNull();
        expect(called).toBe(false);
    });

    it('does not fetch non-http loopback URLs with numeric hosts', async () => {
        let called = false;
        const enricher = createLocalPageTitleEnricher({
            timeoutMs: 100,
            maxBodyBytes: 64,
            concurrency: 1,
            successTtlMs: 1_000,
            failureTtlMs: 1_000,
            fetch: async () => {
                called = true;
                throw new Error('unexpected fetch');
            },
        });

        await expect(enricher.fetchTitle('ftp://127.0.0.1/readme')).resolves.toBeNull();
        expect(called).toBe(false);
    });

    it('refuses redirects to non-http local URLs without fetching them', async () => {
        const fetchedUrls: string[] = [];
        const enricher = createLocalPageTitleEnricher({
            timeoutMs: 100,
            maxBodyBytes: 64,
            concurrency: 1,
            successTtlMs: 1_000,
            failureTtlMs: 1_000,
            fetch: async (url) => {
                fetchedUrls.push(String(url));
                return {
                    status: 302,
                    headers: new Headers({ location: 'file://localhost/etc/passwd' }),
                    body: null,
                } as Response;
            },
        });

        await expect(enricher.fetchTitle('http://127.0.0.1:5173/')).resolves.toBeNull();
        expect(fetchedUrls).toEqual(['http://127.0.0.1:5173/']);
    });
});
