import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeUsageQuery, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { createDeferred, renderScreen } from '@/dev/testkit';
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
const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn<(value: string) => Promise<void>>() }));
vi.mock('expo-clipboard', () => clipboard);
vi.mock('expo-router', async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: navigation }).module,
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);

const scope = { serverId: 'usage-ask-home', accountId: 'account-a' } as const;
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
    <WidgetFrameBodyActionsContext.Provider value={lend}><Body /></WidgetFrameBodyActionsContext.Provider>,
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

beforeEach(() => {
  navigation.push.mockReset();
  clipboard.setStringAsync.mockReset().mockResolvedValue();
  retirePresentationNotice();
  resetSessionDraftRepositoryForTests();
  storage.getState().activateProfileScope(scope);
  publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://usage-ask.test', generation: 1 });
});

afterEach(() => {
  publishAppliedActiveServerRuntimeAvailability(false);
  resetSessionDraftRepositoryForTests();
  retirePresentationNotice();
});

describe('Usage Ask composer handoff', () => {
  it('opens the real durable composer with the selected normalized query and reports no failure', async () => {
    const { ask } = await mountActions();
    expect(ask).toBeDefined();
    act(() => ask!.onPress!());
    const draft = openedDraft();
    expect(draft?.input).toContain(JSON.stringify(query, null, 2));
    expect(draft?.entryIntent).toBe('session');
    // Preparation leaves the target choices editable; it does not request execution.
    expect(draft?.selectedMachineId).toBeNull();
    expect(draft?.selectedPath).toBeNull();
    expect(readPresentationNotice()).toBeNull();
  });

  it('does not reuse a retained Account-A query action after Account B becomes active', async () => {
    const { ask } = await mountActions();
    storage.getState().activateProfileScope({ ...scope, accountId: 'account-b' });
    act(() => ask!.onPress!());
    expect(navigation.push).not.toHaveBeenCalled();
    expect(readPresentationNotice()).toBeNull();
  });

  it('cancels a retained action when its active Home runtime retires', async () => {
    const { ask } = await mountActions();
    publishAppliedActiveServerRuntimeAvailability(false);
    act(() => ask!.onPress!());
    expect(navigation.push).not.toHaveBeenCalled();
    expect(readPresentationNotice()).toBeNull();
  });

  it('keeps a navigation failure visible while retaining the editable draft for recovery', async () => {
    const { ask } = await mountActions();
    navigation.push.mockImplementation(() => { throw new Error('navigation unavailable'); });
    act(() => ask!.onPress!());
    expect(openedDraft()?.input).toContain(JSON.stringify(query, null, 2));
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

  it('copies the selected query but retires a late clipboard notification with its Account', async () => {
    const pending = createDeferred<void>();
    clipboard.setStringAsync.mockImplementation(() => pending.promise);
    const { copy } = await mountActions();
    act(() => copy!.onPress!());
    expect(clipboard.setStringAsync).toHaveBeenCalledWith(JSON.stringify(query, null, 2));
    storage.getState().activateProfileScope({ ...scope, accountId: 'account-b' });
    await act(async () => pending.resolve());
    expect(readPresentationNotice()).toBeNull();
  });
});
