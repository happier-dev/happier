import { afterEach, expect, it, vi } from 'vitest';
import { createFetchPluginHttpRuntime } from '@happier-dev/cli-common/plugins/http';
import { logger } from '@/ui/logger';
import { createPluginHttpService, createStablePluginHttpHost } from './service';
import { createPluginInvocationServiceBinding } from '../invocation/services/factory';
import type { PluginInvocationServicesSeed } from '../invocation/services/types';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function terminalEvents(log: { mock: { calls: [message: string, ...args: unknown[]][] } }) {
    return log.mock.calls.filter(([tag, event]) => tag === '[external-action-stage]'
        && typeof event === 'object' && event !== null && 'stage' in event
        && event.stage === 'contributed.http.transport.end');
}

it.each([
    ['https://api.github.com/repos/PRIVATE_OWNER/PRIVATE_REPO/pulls/987?access_token=PRIVATE_QUERY', '/repos/{owner}/{repo}/pulls/{number}'],
    ['https://api.github.com/repos/pulls/actions/pulls/987/files?token=PRIVATE_QUERY', '/repos/{owner}/{repo}/pulls/{number}/files'],
    ['https://example.test/PRIVATE_PATH/PRIVATE_TOKEN?token=PRIVATE_QUERY', '/{segment}/{segment}'],
])('counts one attributed terminal HTTP attempt without private URL or response content: %s', async (url, routeTemplate) => {
    vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
    // File logging and network fetch are the only substituted system boundaries.
    const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const fetch = vi.fn(async () => new Response('PRIVATE_BODY', { status: 200, headers: {
        'x-ratelimit-remaining': '4356', 'X-RateLimit-Reset': '1793496661', 'x-ratelimit-resource': 'core',
        authorization: 'PRIVATE_RESPONSE_CREDENTIAL',
    } }));
    const seed: PluginInvocationServicesSeed = { plugin: { id: 'happier.scm.forge.github', version: '1.0.0' },
        contribution: { id: 'scan', qualifiedId: 'happier.scm.forge.github.scan' },
        occurrenceId: 'occurrence', correlationId: 'correlation', surface: 'agent',
        signal: new AbortController().signal, isOccurrenceCurrent: () => true };
    const http = createStablePluginHttpHost({ adapter: createFetchPluginHttpRuntime(fetch) })
        .bind(seed, createPluginInvocationServiceBinding(seed.occurrenceId, 'trace-grant'));
    await expect(http.request({ url, headers: { authorization: 'Bearer PRIVATE_AUTH' }, redirect: 'manual' }))
        .resolves.toMatchObject({ status: 200 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(terminalEvents(log)).toEqual([['[external-action-stage]', expect.objectContaining({
        pluginId: seed.plugin.id, operationId: seed.contribution.qualifiedId, method: 'GET', routeTemplate,
        httpStatus: 200, rateLimitRemaining: '4356', rateLimitReset: '1793496661', rateLimitResource: 'core',
    })]]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_');
});

it('counts failed and retried attempts separately without exception content or invented quota facts', async () => {
    vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
    const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const fetch = vi.fn().mockRejectedValueOnce(Object.assign(new Error('PRIVATE_ERROR'), { code: 'ECONNRESET' }))
        .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const http = createPluginHttpService({ pluginId: 'example.external', adapter: createFetchPluginHttpRuntime(fetch),
        retry: { maxAttempts: 2, baseDelayMs: 0 } });
    await expect(http.request({ url: 'https://api.github.com/search/issues?q=PRIVATE_QUERY', redirect: 'manual' }))
        .resolves.toMatchObject({ status: 304 });
    expect(fetch).toHaveBeenCalledTimes(2);
    const events = terminalEvents(log);
    expect(events).toEqual([
        ['[external-action-stage]', expect.objectContaining({ pluginId: 'example.external', method: 'GET', routeTemplate: '/search/issues' })],
        ['[external-action-stage]', expect.objectContaining({ pluginId: 'example.external', httpStatus: 304, routeTemplate: '/search/issues' })],
    ]);
    expect(events[0]![1]).not.toHaveProperty('httpStatus');
    for (const [, event] of events) {
        expect(event).not.toHaveProperty('operationId');
        expect(event).not.toHaveProperty('rateLimitRemaining');
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_');
});

it('attributes streaming transport once and omits malformed quota header content', async () => {
    vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
    const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const fetch = vi.fn(async () => new Response('PRIVATE_BODY', { status: 200, headers: {
        'x-ratelimit-remaining': 'PRIVATE_CREDENTIAL', 'x-ratelimit-reset': 'PRIVATE_CREDENTIAL',
        'x-ratelimit-resource': 'PRIVATE_CREDENTIAL',
    } }));
    const http = createPluginHttpService({ pluginId: 'example.external', adapter: createFetchPluginHttpRuntime(fetch) });
    const response = await http.requestStream({ url: 'https://example.test/PRIVATE_PATH?token=PRIVATE_QUERY', redirect: 'manual' });
    try {
        expect(terminalEvents(log)).toEqual([['[external-action-stage]', expect.objectContaining({
            pluginId: 'example.external', method: 'GET', routeTemplate: '/{segment}', httpStatus: 200,
        })]]);
        expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE_|rateLimit/);
    } finally { await response.dispose(); }
});

it('emits no transport events for preparation, rejected URL credentials, or disabled tracing', async () => {
    vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
    const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const host = createStablePluginHttpHost({ adapter: createFetchPluginHttpRuntime(fetch) });
    const seed: PluginInvocationServicesSeed = { plugin: { id: 'example.external', version: '1.0.0' },
        contribution: { id: 'read', qualifiedId: 'example.external.read' }, occurrenceId: 'occurrence',
        correlationId: 'correlation', surface: 'agent', signal: new AbortController().signal, isOccurrenceCurrent: () => true };
    const http = host.bind(seed, createPluginInvocationServiceBinding(seed.occurrenceId, 'trace-grant'));
    const prepared = await http.prepareRead({ intent: 'get', url: 'https://api.github.com/user', redirect: 'manual' });
    await prepared.dispose();
    await expect(http.request({ url: 'https://PRIVATE_USER:PRIVATE_PASSWORD@api.github.com/user', redirect: 'manual' }))
        .rejects.toMatchObject({ code: 'plugin_fetch_invalid_url' });
    expect(fetch).not.toHaveBeenCalled();
    expect(terminalEvents(log)).toHaveLength(0);
    vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '0');
    log.mockClear();
    await http.request({ url: 'https://api.github.com/user', redirect: 'manual' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
});
