import { describe, expect, it } from 'vitest';

import {
    buildLocalPageTitleUrl,
    createLocalPageTitleEnricher,
    extractLocalPageTitle,
    isLocalPageTitleHost,
} from './pageTitle';
import type { NormalizedLocalServiceInventoryEntry } from './scanner';

function streamBody(html: string): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(html);
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
}

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

    it('rejects *.localhost names that are not provably loopback (DNS-rebinding guard)', () => {
        // A `*.localhost` label can be pointed at a non-loopback address by a hostile
        // resolver; we must not trust it on the name string alone. Only the literal
        // `localhost` and the loopback/private/ULA/link-local IP forms stay trusted.
        expect(isLocalPageTitleHost('evil.localhost')).toBe(false);
        expect(isLocalPageTitleHost('attacker.example.localhost')).toBe(false);
        expect(isLocalPageTitleHost('localhost.evil.com')).toBe(false);
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

    it('does not fetch a non-loopback *.localhost host (DNS-rebinding guard)', async () => {
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

        await expect(enricher.fetchTitle('http://evil.localhost:5173/')).resolves.toBeNull();
        expect(called).toBe(false);
    });

    it('evicts the oldest cache entry once the configured cap is exceeded', async () => {
        const fetchCounts = new Map<string, number>();
        const enricher = createLocalPageTitleEnricher({
            timeoutMs: 100,
            maxBodyBytes: 1_024,
            concurrency: 1,
            successTtlMs: 60_000,
            failureTtlMs: 60_000,
            maxCacheEntries: 2,
            fetch: async (url) => {
                const key = String(url);
                fetchCounts.set(key, (fetchCounts.get(key) ?? 0) + 1);
                return {
                    status: 200,
                    ok: true,
                    headers: new Headers({ 'content-type': 'text/html' }),
                    body: streamBody(`<html><head><title>${key}</title></head></html>`),
                } as Response;
            },
        });

        const a = 'http://127.0.0.1:3001/';
        const b = 'http://127.0.0.1:3002/';
        const c = 'http://127.0.0.1:3003/';

        await enricher.fetchTitle(a);
        await enricher.fetchTitle(b);
        // Re-fetching a/b within TTL is served from cache (no extra fetch): proves the
        // entries are genuinely cached, so the later re-fetch can only be eviction.
        await enricher.fetchTitle(a);
        await enricher.fetchTitle(b);
        expect(fetchCounts.get(a)).toBe(1);
        expect(fetchCounts.get(b)).toBe(1);

        // c exceeds the cap (2), evicting the oldest entry (a, insertion-order FIFO);
        // b stays cached as the most-recently-inserted survivor.
        await enricher.fetchTitle(c);
        await enricher.fetchTitle(b);
        expect(fetchCounts.get(b)).toBe(1);

        // a was evicted, so re-fetching it issues a fresh request (unbounded cache would
        // have kept it and this would stay 1).
        await enricher.fetchTitle(a);
        expect(fetchCounts.get(a)).toBe(2);
    });
});

describe('buildLocalPageTitleUrl', () => {
    function entry(overrides: Partial<NormalizedLocalServiceInventoryEntry> = {}): NormalizedLocalServiceInventoryEntry {
        return {
            id: 'entry-a',
            machineId: 'machine-a',
            address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
            port: 8443,
            protocol: 'tcp',
            detectedAt: 1_000,
            lastSeenAt: 2_000,
            state: 'listening',
            source: 'detected',
            labels: [],
            confidence: 'high',
            processOwnershipConfidence: 'medium',
            workspaceAssociationConfidence: 'high',
            diagnostics: [],
            presentation: { addressLabel: 'localhost:8443' },
            ...overrides,
        } as NormalizedLocalServiceInventoryEntry;
    }

    it('uses the daemon-detected HTTPS endpoint scheme for title fetches', () => {
        expect(buildLocalPageTitleUrl(entry({
            endpoint: {
                scheme: 'https',
                host: '127.0.0.1',
                port: 8443,
                probeState: 'ready',
                probedAt: 2_000,
            },
        }))).toBe('https://127.0.0.1:8443/');
    });

    it('does not fetch a title when the endpoint scheme is unknown', () => {
        expect(buildLocalPageTitleUrl(entry({
            endpoint: {
                scheme: 'unknown',
                host: '127.0.0.1',
                port: 8443,
                probeState: 'unknown',
                probedAt: 2_000,
                reasonCode: 'endpoint_probe_failed',
            },
        }))).toBeNull();
    });
});
