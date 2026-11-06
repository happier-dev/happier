import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeUsageQuery, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import type { AuthCredentials as Credentials } from '@/auth/storage/tokenStorage';
import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { WidgetFrameBodyActionsContext } from '@/components/widgets/frame/widgetFrameBodyActions';
import { storage } from '@/sync/domains/state/storageStore';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { useUsageQueryActions } from './useUsageQueryActions';

const navigation = vi.hoisted(() => ({ push: vi.fn<(route: unknown) => void>() }));
// The system clipboard is the only boundary below the real clipboard adapter.
const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn<(value: string) => Promise<boolean>>() }));
vi.mock('expo-clipboard', () => clipboard);
vi.mock('expo-router', async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: navigation }).module,
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key, params) => key === 'usage.board.page.askPrompt' ? String(params?.query) : key,
  }),
);

let home: Awaited<ReturnType<typeof serveActionHomes>>;
let credentials: Credentials;
let scope: { serverId: string; accountId: string };
const query = normalizeUsageQuery({
  period: { startMs: 1_700_000_000_000, endMs: 1_700_086_400_000 },
  agents: ['codex', 'claude'],
  machines: ['machine-selected'],
  projects: ['project-selected'],
  sources: ['native'],
  session: 'session-selected',
  metric: 'cost',
  costBasis: 'reported',
  breakdown: ['model'],
  timeZoneOffsetMinutes: 60,
});

async function mountActions(shownQuery: UsageQuery | null = query) {
  const projection: { actions: readonly ItemAction[] | null } = { actions: null };
  const lend = (next: readonly ItemAction[] | null) => { projection.actions = next; };
  function Body() {
    useUsageQueryActions('usage_daily', shownQuery);
    return null;
  }
  const screen = await renderScreen(
    <InjectedAuthProvider credentials={credentials}><WidgetFrameBodyActionsContext.Provider value={lend}><Body /></WidgetFrameBodyActionsContext.Provider></InjectedAuthProvider>,
  );
  const ask = projection.actions?.find(action => action.id === 'usageAsk');
  const copy = projection.actions?.find(action => action.id === 'usageCopyQuery');
  return { screen, ask, copy };
}

function openedDraft() {
  const route = navigation.push.mock.calls[0]?.[0] as { pathname: string; params: { draftId: string } } | undefined;
  expect(route?.pathname).toBe('/new');
  expect(route?.params.draftId).toEqual(expect.any(String));
  return readNewSessionDraftFromRepository({ scope, draftId: route!.params.draftId });
}

beforeEach(async () => {
  home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-ask.test', accountId: 'account-a' }],
    route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
  scope = { serverId: home.homes.a!.id, accountId: 'account-a' };
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
  navigation.push.mockReset();
  clipboard.setStringAsync.mockReset().mockResolvedValue(true);
  retirePresentationNotice();
  resetSessionDraftRepositoryForTests();
  storage.getState().activateProfileScope(scope);
  publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://usage-ask.test', generation: 1 });
});

afterEach(async () => {
  await home?.dispose();
  publishAppliedActiveServerRuntimeAvailability(false);
  resetSessionDraftRepositoryForTests();
  retirePresentationNotice();
});

describe('Usage Ask composer handoff', () => {
  it('honours disabled Session authoring Action admission before preparing a draft', async () => {
    const settings = storage.getState().settings;
    storage.getState().applySettingsForScope(scope, { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
      v: 1, actions: { 'session.authoring.open': { disabledSurfaces: ['ui'] } },
    }) }, 2);
    const { ask } = await mountActions();
    await act(async () => { await ask!.onPress!(); });
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('opens the real durable composer with the selected normalized query and reports no failure', async () => {
    const { ask } = await mountActions();
    expect(ask).toBeDefined();
    await act(async () => { await ask!.onPress!(); });
    const draft = openedDraft();
    expect(normalizeUsageQuery(JSON.parse(draft?.input ?? 'null'))).toEqual(query);
    expect(draft?.entryIntent).toBe('session');
    // Preparation leaves the target choices editable; it does not request execution.
    expect(draft?.selectedMachineId).toBeNull();
    expect(draft?.selectedPath).toBeNull();
    expect(readPresentationNotice()).toBeNull();
  });

  it('does not reuse a retained Account-A query action after Account B becomes active', async () => {
    const { ask } = await mountActions();
    storage.getState().activateProfileScope({ ...scope, accountId: 'account-b' });
    await act(async () => { await ask!.onPress!(); });
    expect(navigation.push).not.toHaveBeenCalled();
    expect(readPresentationNotice()).toBeNull();
  });

  it('cancels a retained action when its active Home runtime retires', async () => {
    const { ask } = await mountActions();
    publishAppliedActiveServerRuntimeAvailability(false);
    await act(async () => { await ask!.onPress!(); });
    expect(navigation.push).not.toHaveBeenCalled();
    expect(readPresentationNotice()).toBeNull();
  });

  it('keeps a navigation failure visible while retaining the editable draft for recovery', async () => {
    const { ask } = await mountActions();
    navigation.push.mockImplementation(() => { throw new Error('navigation unavailable'); });
    await act(async () => { await ask!.onPress!(); });
    expect(normalizeUsageQuery(JSON.parse(openedDraft()?.input ?? 'null'))).toEqual(query);
    expect(readPresentationNotice()).toMatchObject({ key: 'usage-ask:usage_daily', severity: 'error' });
  });

  it('lends no query action when the body has no admitted shown query', async () => {
    expect((await mountActions(null)).ask).toBeUndefined();
  });

  it('does not copy a retained Account-A query after Account B becomes active', async () => {
    const { copy } = await mountActions();
    storage.getState().activateProfileScope({ ...scope, accountId: 'account-b' });
    await act(async () => copy!.onPress!());
    expect(clipboard.setStringAsync).not.toHaveBeenCalled();
    expect(readPresentationNotice()).toBeNull();
  });

  it('honours disabled clipboard Action admission before copying the shown query', async () => {
    const settings = storage.getState().settings;
    storage.getState().applySettingsForScope(scope, { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
      v: 1, actions: { 'clipboard.write': { disabledSurfaces: ['ui'] } },
    }) }, 2);
    const { copy } = await mountActions();
    await act(async () => { await copy!.onPress!(); });
    expect(clipboard.setStringAsync).not.toHaveBeenCalled();
    expect(readPresentationNotice()).toMatchObject({ key: 'usage-copy-query:usage_daily', severity: 'error' });
  });

  it.each([true, false])('copies the normalized shown query and reports clipboard success %s', async copied => {
    clipboard.setStringAsync.mockResolvedValue(copied);
    const { copy } = await mountActions();
    await act(async () => { await copy!.onPress!(); });
    await vi.waitFor(() => expect(readPresentationNotice()).toMatchObject({
      key: 'usage-copy-query:usage_daily', severity: copied ? 'info' : 'error',
    }));
    expect(normalizeUsageQuery(JSON.parse(clipboard.setStringAsync.mock.calls[0]?.[0] ?? 'null'))).toEqual(query);
  });

  it('copies the selected query but retires a late clipboard notification with its Account', async () => {
    const pending = createDeferred<boolean>();
    clipboard.setStringAsync.mockImplementation(() => pending.promise);
    const { copy } = await mountActions();
    let copying: unknown;
    act(() => { copying = copy!.onPress!(); });
    await vi.waitFor(() => expect(normalizeUsageQuery(JSON.parse(clipboard.setStringAsync.mock.calls[0]?.[0] ?? 'null'))).toEqual(query));
    expect(readPresentationNotice()).toBeNull();
    storage.getState().activateProfileScope({ ...scope, accountId: 'account-b' });
    await act(async () => { pending.resolve(true); await copying; });
    expect(readPresentationNotice()).toBeNull();
  });
});
