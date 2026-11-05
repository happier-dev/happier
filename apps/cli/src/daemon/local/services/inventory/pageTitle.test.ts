import { describe, expect, it } from 'vitest';

import {
    buildLocalPageTitleUrl,
    createLocalPageTitleEnricher,
    enrichLocalServiceInventoryPageTitles,
    extractLocalPageTitle,
    isLocalPageTitleHost,
} from './pageTitle';
import { normalizeLocalServiceScan, type NormalizedLocalServiceInventoryEntry } from './scanner';

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
    it('does not turn a known internal control endpoint into a page-title URL', () => {
        const internal: NormalizedLocalServiceInventoryEntry = {
            id: 'control', machineId: 'machine-a', address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
            port: 44473, protocol: 'tcp', detectedAt: 1, lastSeenAt: 1, state: 'listening', source: 'detected',
            labels: [], confidence: 'high', processOwnershipConfidence: 'high', workspaceAssociationConfidence: 'low', diagnostics: [],
            classification: { kind: 'happier', confidence: 'high', signals: ['owner:happier'] },
            endpoint: { scheme: 'http', host: '127.0.0.1', port: 44473, probeState: 'ready', probedAt: 1 },
        };
        expect(buildLocalPageTitleUrl(internal)).toBeNull();
        expect(buildLocalPageTitleUrl({ ...internal, classification: undefined })).toBe('http://127.0.0.1:44473/');
    });

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
    it.each([true, false])('fetches each endpoint once for a thousand inventory rows sharing listener addresses (available: %s)', async available => {
        const listeners = Array.from({ length: 1_000 }, (_, index) => ({
            address: index % 2 === 0 ? '127.0.0.1' : '0.0.0.0',
            port: 10_000 + Math.floor(index / 2), protocol: 'tcp' as const,
        }));
        const normalized = normalizeLocalServiceScan({ machineId: 'machine-a', now: 1_000,
            previous: null, listeners, processes: new Map(), workspaces: [], ownership: [] });
        const snapshot = { ...normalized, entries: normalized.entries.map(entry => ({
            ...entry, endpoint: { scheme: 'http' as const, host: '127.0.0.1', port: entry.port,
                probeState: 'ready' as const, probedAt: 1_000 },
        })) };
        let fetches = 0;
        const enricher = createLocalPageTitleEnricher({ timeoutMs: 1_000, maxBodyBytes: 1_024,
            concurrency: 8, successTtlMs: 60_000, failureTtlMs: 60_000,
            fetch: async () => {
                fetches += 1;
                return available
                    ? new Response('<title>Local application</title>', { headers: { 'content-type': 'text/html' } })
                    : new Response(null, { status: 503 });
            },
        });

        const enriched = await enrichLocalServiceInventoryPageTitles({ snapshot, enricher });

        expect(enriched.entries.map(entry => entry.id)).toEqual(snapshot.entries.map(entry => entry.id));
        if (available) expect(enriched.entries.every(entry => entry.presentation?.pageTitle === 'Local application')).toBe(true);
        else expect(enriched.entries).toEqual(snapshot.entries);
        expect(fetches).toBe(500);
    });

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

    it('does not refetch unchanged titles within their TTL when an inventory exceeds 512 endpoints', async () => {
        const fetchCounts = new Map<string, number>();
        const enricher = createLocalPageTitleEnricher({
            timeoutMs: 100,
            maxBodyBytes: 1_024,
            concurrency: 1,
            successTtlMs: 60_000,
            failureTtlMs: 60_000,
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

        // Cross the removed FIFO threshold: every address remains a valid current endpoint.
        const urls = Array.from({ length: 513 }, (_, index) => `http://127.0.0.1:${3000 + index}/`);
        for (const url of urls) await enricher.fetchTitle(url);
        expect([...fetchCounts.values()].reduce((sum, count) => sum + count, 0)).toBe(urls.length);
        for (const url of urls) await enricher.fetchTitle(url);
        expect([...fetchCounts.values()].reduce((sum, count) => sum + count, 0)).toBe(urls.length);
        await expect(enricher.fetchTitle('http://127.0.0.1:9000/')).resolves.toMatchObject({
            title: 'http://127.0.0.1:9000/',
        });
        expect(fetchCounts.get('http://127.0.0.1:9000/')).toBe(1);
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
