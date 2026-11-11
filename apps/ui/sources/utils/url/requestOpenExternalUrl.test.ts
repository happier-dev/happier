import { afterEach, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderScreen } from '@/dev/testkit';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative'))
  .createReactNativeWebMock({ Platform: { OS: 'web' } }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storageStore');
const { Modal } = await import('@/modal');
const { router } = await import('expo-router');
const { t } = await import('@/text');
const { requestOpenExternalUrl } = await import('./requestOpenExternalUrl');
const { SessionPublicLinkCard } = await import('@/components/sessions/collaboration/SessionPublicLinkSection');
const initialState = storage.getState();

it('opens the issued public link from the Share card through the external-link Action', async () => {
  await homes.reset();
  const serverId = await homes.addHome({ name: 'Documents', serverUrl: 'https://document-links.test', accountId: 'alice', currentAccount: true });
  await storage.getState().activateSettingsScope({ serverId, accountId: 'alice' });
  const opened = vi.fn();
  vi.stubGlobal('open', opened);
  const url = 'https://viewer.test/s/issued-lookup#k=private-fragment';
  const screen = await renderScreen(React.createElement(SessionPublicLinkCard, {
    testID: 'document-link', presentation: 'inline', configurationScope: { serverId, accountId: 'alice' },
    publicShare: { id: 'share', expiresAt: null, maxUses: null, useCount: 0, isConsentRequired: false },
    shareUrl: url, serverUrl: null, loading: false, loaded: true, failed: false, readOnly: false, pendingApproval: false,
    onRetry: () => {}, onOpenPendingApproval: () => {}, onCreate: async () => null, onDelete: async () => {},
  }));
  await screen.pressByTestIdAsync('session-public-link-open');
  await vi.waitFor(() => expect(opened).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer'));
});

afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); storage.setState(initialState, true); });

it('explains a disabled guide-link Action and leads to its setting before an allowed open', async () => {
  await homes.reset();
  const serverId = await homes.addHome({ name: 'Guide', serverUrl: 'https://guide-links.test', accountId: 'alice', currentAccount: true });
  await storage.getState().activateSettingsScope({ serverId, accountId: 'alice' });
  const opened = vi.fn();
  vi.stubGlobal('open', opened);
  const setPolicy = (disabled: boolean) => {
    const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1,
      ...(disabled ? { actions: { 'links.openExternal': { enabled: false } } } : {}),
    });
    homes.answer(serverId, '/v2/account/settings', { body: {
      content: { t: 'plain', v: { actionsSettingsV1 } }, version: disabled ? 2 : 3,
    } });
    storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1 } }));
  };
  const alert = vi.mocked(Modal.alert);
  alert.mockClear();
  setPolicy(true);
  expect(await requestOpenExternalUrl('https://provider.test/guide', { serverId })).toBe(false);
  expect(opened).not.toHaveBeenCalled();
  expect(alert).toHaveBeenCalledWith(expect.any(String), t('actionConfirmations.turnedOffMessage'), expect.any(Array));
  const recovery = alert.mock.calls.at(-1)?.[2]?.find(button => button.text === t('actionConfirmations.openActionSettings'));
  expect(recovery).toBeDefined();
  recovery?.onPress?.();
  expect(router.push).toHaveBeenCalledWith('/settings/actions/links.openExternal');
  setPolicy(false);
  expect(await requestOpenExternalUrl('https://provider.test/guide', { serverId })).toBe(true);
  expect(opened).toHaveBeenCalledExactlyOnceWith('https://provider.test/guide', '_blank', 'noopener,noreferrer');
});
