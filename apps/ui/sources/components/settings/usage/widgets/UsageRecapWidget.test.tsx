import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Clipboard from 'expo-clipboard';
import { act } from 'react-test-renderer';
import { normalizeUsageQuery, getUsageQueryKey, usageQueryToAnalyticsRequest } from '@happier-dev/protocol/inputs/usageQuery';
import { buildUsageFileResult } from '@happier-dev/protocol/usage/usageExport';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { UsageRecapWidget } from './UsageRecapWidget';
import type { UsageBodyProps } from './usageBodyKit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
const accounting: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1,
  tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
  cost: { reportedUsd: 3, estimatedUsd: 0, currency: 'USD' } }, breakdowns: { agent: [{ key: 'claude', eventCount: 1,
  tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
  cost: { reportedUsd: 3, estimatedUsd: 0, currency: 'USD' } }] } };
const shownQuery = normalizeUsageQuery({ period: { startMs: 100, endMs: 900 }, agents: ['claude'],
  machines: ['pinned-machine'], projects: ['opaque-project'], sources: ['native'], session: ['s1'],
  workspaceIds: ['workspace'], modelIds: ['model'], backendModes: ['remote'], timeZoneOffsetMinutes: 120,
  metric: 'cost', costBasis: 'reported', breakdown: ['agent'] });
let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(() => { standardCleanup(); retireActiveServerAccountScopeLifetime(); home?.dispose(); home = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mount(denied = false, queryResponse?: () => Response | Promise<Response>, hasAccounting = true) {
  // Load the real lazy Action entry before a short assertion wait; no internal owner is mocked.
  await import('@/sync/ops/actions/defaultActionExecutor');
  home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://table-export.test', accountId: 'a' }],
    route: request => request.path === '/v2/usage/query'
      ? queryResponse?.() ?? (denied ? new Response('denied', { status: 403 }) : Response.json(accounting)) : undefined });
  const server = home.homes.a!;
  const authority = { serverId: server.id, accountId: 'a' };
  publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
  const slice = { key: getUsageQueryKey(shownQuery), requestedQuery: shownQuery, shownQuery, ...(hasAccounting ? { accounting } : {}),
    pending: false, sources: [{ source: 'accounting', status: 'available' as const }] };
  const props: UsageBodyProps = { id: 'usage_recap', serverId: server.id, testID: 'recap', query: shownQuery, slice,
    model: { requestedQuery: { query: { ...shownQuery, period: { startMs: 1000, endMs: 1900 } }, authority },
      shownQuery: { query: shownQuery, authority }, slice,
      pending: true, error: null, freshness: 'stale', updatingPreviousPeriod: true, refreshing: false, refresh: async () => {} } };
  return await renderScreen(<UsageRecapWidget {...props} />);
}

describe('Recap table/text controls through the admitted export Action', () => {
  it('keeps the admitted single-session autopsy visible when summary accounting is unavailable', async () => {
    const screen = await mount(false, undefined, false);
    expect(Boolean(screen.findByTestId('recap.empty'))).toBe(true);
    expect(Boolean(screen.findByTestId('recap.autopsy.contributions'))).toBe(true);
    expect(home!.requests).toHaveLength(0);
  });
  it('copies the Action text bytes for the exact shown query with explicit summary fields', async () => {
    const clipboard = vi.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true);
    const screen = await mount();
    await screen.pressByTestIdAsync('recap.copySummary');
    await vi.waitFor(() => expect(home!.requests.filter(request => request.path === '/v2/usage/query')).not.toHaveLength(0));
    expect(home!.requests.filter(request => request.path === '/v2/usage/query').map(request => request.body))
      .toContainEqual(usageQueryToAnalyticsRequest(shownQuery));
    const file = buildUsageFileResult({ query: shownQuery, format: 'text', fields: ['totals'] }, accounting, null);
    await vi.waitFor(() => expect(clipboard).toHaveBeenCalledWith(new TextDecoder().decode(decodeBase64(file.base64))));
  });

  it('withholds clipboard delivery when the Action read is denied', async () => {
    const clipboard = vi.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true);
    const screen = await mount(true);
    await screen.pressByTestIdAsync('recap.copySummary');
    await vi.waitFor(() => expect(Boolean(screen.findByTestId('recap.exportNotice'))).toBe(true));
    expect(clipboard).not.toHaveBeenCalled();
  });

  it('retires pending preparation before delivering clipboard bytes after Account authority is lost', async () => {
    let finish!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { finish = resolve; });
    const clipboard = vi.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true);
    const screen = await mount(false, () => response);
    await screen.pressByTestIdAsync('recap.copySummary');
    await vi.waitFor(() => expect(home!.requests.some(request => request.path === '/v2/usage/query')).toBe(true));
    await act(async () => { retireActiveServerAccountScopeLifetime(); finish(Response.json(accounting)); });
    await vi.waitFor(() => expect(screen.findByTestId('recap.copySummary')?.props.accessibilityState?.busy).toBe(false));
    expect(clipboard).not.toHaveBeenCalled();
  });

  it.each(['json', 'csv'] as const)('downloads the same %s Action bytes with explicit table fields', async format => {
    const screen = await mount();
    const blobs: Blob[] = [];
    const downloads: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:export'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const anchor = { href: '', download: '', rel: '', style: {}, remove() {}, click() { downloads.push(this.download); } };
    vi.stubGlobal('document', { getElementById: () => null,
      createElement: (tag: string) => tag === 'a' ? anchor : { id: '', textContent: '' },
      head: { appendChild() {} }, body: { appendChild() {} } });
    await screen.pressByTestIdAsync(`recap.${format}`);
    await vi.waitFor(() => expect(downloads.length).toBe(1));
    const expected = buildUsageFileResult({ query: shownQuery, format, fields: ['totals', 'breakdowns'] }, accounting, null);
    expect(await blobs[0]!.text()).toBe(new TextDecoder().decode(decodeBase64(expected.base64)));
    expect(downloads[0]).toBe(expected.fileName);
    expect(home!.requests.filter(request => request.path === '/v2/usage/query').map(request => request.body))
      .toContainEqual(usageQueryToAnalyticsRequest(shownQuery));
  });
});
