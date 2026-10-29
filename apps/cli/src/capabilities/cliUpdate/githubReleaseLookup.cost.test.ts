import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitHubReleaseRateLimitError } from '@happier-dev/release-runtime/github';
import { fetchGitHubLatestRelease, fetchGitHubReleaseByTag } from './githubReleaseLookup';
import { configuration } from '@/configuration';
import { createCapabilitiesService, type Capability } from '@/capabilities/service';
import { withAgentCliUpdates } from './agentCliUpdates';
import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';

describe('GitHub release lookup demand and cost', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it.each(['latest', 'tag'] as const)('preserves a typed credential redirect refusal for a %s lookup', async kind => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 307,
      headers: { location: 'https://other.example.test/?token=hidden' } }));
    const request = { githubRepo: `fixture/redirect-${kind}`, githubToken: 'fixture', fetchImpl };
    await expect(kind === 'latest' ? fetchGitHubLatestRelease(request) : fetchGitHubReleaseByTag({ ...request, tag: 'stable' }))
      .rejects.toMatchObject({ code: 'credential_request_redirect_refused', retryable: false, status: 307 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('daemon capability admission and a settled idle hour make no release requests; three view opens share one', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ tag_name: 'v2.0.0' })));
    vi.stubGlobal('fetch', fetchImpl);
    const runtimeSpec: AgentCliRuntimeDescriptor = {
      id: 'claude', title: 'Fixture CLI', binaryName: 'claude',
      sourcePreferenceDefault: 'system-first', acceptsJavaScriptFileOverride: false,
      managedInstall: { kind: 'github_release_binary', githubRepo: 'fixture/view-demand', binaryName: 'claude' },
    };
    // The executable-version probe is an OS boundary. Capability composition,
    // source selection, release lookup, cache and HTTP admission remain real.
    const executable: Capability = {
      descriptor: { id: 'cli.claude', kind: 'cli', title: 'Fixture CLI' },
      detect: async () => ({ available: true, resolvedPath: '/fixture/claude', resolutionSource: 'system', version: '1.0.0' }),
    };
    const makeService = () => createCapabilitiesService({
      capabilities: [withAgentCliUpdates(executable, 'claude', { resolveRuntimeSpec: () => runtimeSpec })],
      checklists: { 'new-session': [], 'machine-details': [] }, buildContext: async () => ({ cliSnapshot: null }),
    });
    const service = makeService();
    await service.detect({ requests: [{ id: 'cli.claude' }] });
    expect(fetchImpl).toHaveBeenCalledTimes(0);
    const view = { requests: [{ id: 'cli.claude' as const, params: { includeLatestVersion: true, bypassCache: true } }] };
    for (let i = 0; i < 3; i++) {
      const result = await (i === 2 ? makeService() : service).detect(view);
      expect(result.results['cli.claude']).toMatchObject({ ok: true, data: { latestVersion: '2.0.0' } });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares authenticated action and view reads until the configured update interval expires', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ tag_name: 'v2.0.0' })));
    const request = { githubRepo: 'fixture/cost', fetchImpl, githubToken: 'fixture-github-token',
      cacheTtlMs: configuration.installablesRuntimeAutoUpdateCheckIntervalMs };
    // Registering demand-free owners starts no network work.
    expect(fetchImpl).toHaveBeenCalledTimes(0);
    for (let i = 0; i < 4; i++) {
      await expect(fetchGitHubLatestRelease(request)).resolves.toMatchObject({ tag_name: 'v2.0.0' });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer fixture-github-token');
    now += configuration.installablesRuntimeAutoUpdateCheckIntervalMs;
    await fetchGitHubLatestRelease(request);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('answers repeated capability detects without GitHub requests before the recorded reset, then retries on demand', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchImpl = vi.fn(async () => new Response('', { status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '3600' } }));
    vi.stubGlobal('fetch', fetchImpl);
    const runtimeSpec: AgentCliRuntimeDescriptor = {
      id: 'codex', title: 'Fixture CLI', binaryName: 'codex',
      sourcePreferenceDefault: 'system-first', acceptsJavaScriptFileOverride: false,
      managedInstall: { kind: 'github_release_binary', githubRepo: 'fixture/detect-reset', binaryName: 'codex' },
    };
    const executable: Capability = {
      descriptor: { id: 'cli.codex', kind: 'cli', title: 'Fixture CLI' },
      detect: async () => ({ available: true, resolvedPath: '/fixture/codex', resolutionSource: 'system', version: '1.0.0' }),
    };
    const service = createCapabilitiesService({
      capabilities: [withAgentCliUpdates(executable, 'codex', { env: {}, resolveRuntimeSpec: () => runtimeSpec })],
      checklists: { 'new-session': [], 'machine-details': [] }, buildContext: async () => ({ cliSnapshot: null }),
    });
    const request = { requests: [{ id: 'cli.codex' as const, params: { includeLatestVersion: true, bypassCache: true } }] };
    const probe = async () => expect((await service.detect(request)).results['cli.codex'])
      .toMatchObject({ ok: true, data: { available: true, version: '1.0.0', latestVersion: null } });
    await probe();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 100; i++) { now += 30_000; await probe(); }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 3_600_000;
    fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ tag_name: 'v2.0.0' })));
    expect((await service.detect(request)).results['cli.codex'])
      .toMatchObject({ ok: true, data: { latestVersion: '2.0.0' } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shares concurrent consumers at the HTTP boundary', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ tag_name: 'v2.0.0' })));
    const request = { githubRepo: 'fixture/concurrent', fetchImpl,
      cacheTtlMs: configuration.installablesRuntimeAutoUpdateCheckIntervalMs };
    await Promise.all(Array.from({ length: 100 }, () => fetchGitHubLatestRelease(request)));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('honors the exhausted REST budget across repositories and tag/latest paths until reset', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchImpl = vi.fn(async () => new Response('', { status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '3600' } }));
    await expect(fetchGitHubLatestRelease({ githubRepo: 'fixture/first', fetchImpl }))
      .rejects.toBeInstanceOf(GitHubReleaseRateLimitError);
    await expect(fetchGitHubReleaseByTag({ githubRepo: 'fixture/second', tag: 'stable', fetchImpl }))
      .rejects.toBeInstanceOf(GitHubReleaseRateLimitError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 3_600_000;
    await expect(fetchGitHubLatestRelease({ githubRepo: 'fixture/first', fetchImpl }))
      .rejects.toBeInstanceOf(GitHubReleaseRateLimitError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not cache ordinary HTTP failures or a cancelled read', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 }));
    const request = { githubRepo: 'fixture/retry', fetchImpl,
      cacheTtlMs: configuration.installablesRuntimeAutoUpdateCheckIntervalMs };
    await expect(fetchGitHubLatestRelease(request)).rejects.toThrow();
    await expect(fetchGitHubLatestRelease(request)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    controller.abort();
    await expect(fetchGitHubLatestRelease({ ...request, signal: controller.signal })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('cancelling one observer does not cancel another consumer of the same release', async () => {
    let finish!: () => void;
    let transportSignal: AbortSignal | undefined;
    const response = new Promise<void>((resolve) => { finish = resolve; });
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      transportSignal = init?.signal ?? undefined;
      await response;
      return new Response(JSON.stringify({ tag_name: 'v2.0.0' }));
    });
    const controller = new AbortController();
    const request = { githubRepo: 'fixture/cancellation', fetchImpl };
    const first = fetchGitHubLatestRelease({ ...request, signal: controller.signal });
    const cancelled = expect(first).rejects.toThrow();
    const second = fetchGitHubLatestRelease(request);
    controller.abort();
    await cancelled;
    expect(transportSignal?.aborted).toBe(false);
    finish();
    await expect(second).resolves.toMatchObject({ tag_name: 'v2.0.0' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
