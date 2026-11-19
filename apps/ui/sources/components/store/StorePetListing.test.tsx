import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);

// The platform URL effect is external; the links.openExternal Action admission stays real.
const externalUrlBoundary = vi.hoisted(() => vi.fn(async (_url: string) => true));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: externalUrlBoundary }));

const { StorePetListing } = await import('./StorePetListing');
const { t } = await import('@/text');
type Props = import('./StorePetListing').StorePetListingViewProps;

function props(overrides: Partial<Props> = {}): Props {
  return {
    name: 'Boba',
    meta: 'railly · petdex.dev',
    description: 'A tiny otter sipping bubble tea.',
    sourceTitle: 'petdex.dev',
    art: null,
    state: { kind: 'available' },
    facts: [],
    reportUrl: null,
    onAdd: vi.fn(),
    onOpenSettingsPets: vi.fn(),
    onOpenFeatures: vi.fn(),
    testID: 'listing',
    ...overrides,
  };
}

const has = (screen: Awaited<ReturnType<typeof renderScreen>>, id: string) =>
  screen.findByTestId(`listing:${id}`) !== null;

describe('Store pet listing', () => {
  it("after Add, leads with Use as a Bot's face…, then Make it my companion and Undo (r12-pet-S, r12-create-A)", async () => {
    const onUndo = vi.fn();
    const screen = await renderScreen(
      <StorePetListing
        {...props({
          state: { kind: 'addedNow', undo: 'ready' },
          wearPet: {
            kind: 'accountPet',
            accountPetId: 'pet-1',
            displayName: 'Boba',
          },
          onMakeCompanion: vi.fn(),
          onUndo,
        })}
      />,
    );
    expect(screen.getTextContent()).toContain(t('settingsPets.store.addedNow'));
    expect(has(screen, 'useAsFace')).toBe(true);
    expect(has(screen, 'companion')).toBe(true);
    await screen.pressByTestIdAsync('listing:undo');
    expect(onUndo).toHaveBeenCalledOnce();
  });

  it('a pet already in your pets (or reused on Add) offers no Undo, so the existing pet survives', async () => {
    const screen = await renderScreen(
      <StorePetListing
        {...props({
          state: { kind: 'added' },
          wearPet: { kind: 'accountPet', accountPetId: 'pet-1' },
          onMakeCompanion: vi.fn(),
          onUndo: vi.fn(),
        })}
      />,
    );
    expect(screen.getTextContent()).toContain(t('settingsPets.store.added'));
    expect(has(screen, 'useAsFace')).toBe(true);
    expect(has(screen, 'undo')).toBe(false);
  });

  it('after Undo, says the pet left your pets and offers Add again', async () => {
    const onAdd = vi.fn();
    const screen = await renderScreen(
      <StorePetListing {...props({ state: { kind: 'removed' }, onAdd })} />,
    );
    expect(screen.getTextContent()).toContain(
      t('settingsPets.store.removed', { name: 'Boba', source: 'petdex.dev' }),
    );
    await screen.pressByTestIdAsync('listing:add');
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it('says a failed Undo once and keeps the pet', async () => {
    const screen = await renderScreen(
      <StorePetListing
        {...props({
          state: { kind: 'addedNow', undo: 'failed' },
          onUndo: vi.fn(),
        })}
      />,
    );
    expect(screen.getTextContent()).toContain(
      t('settingsPets.store.undoFailed', { name: 'Boba' }),
    );
    expect(has(screen, 'undo')).toBe(true);
  });

  it('blames the sheet only for a failed sheet check; any other refusal is said generically, with Add left disabled', async () => {
    const generic = await renderScreen(
      <StorePetListing {...props({ state: { kind: 'couldntAdd', reason: 'other' } })} />,
    );
    expect(generic.getTextContent()).toContain(t('petShare.offerCouldNotAdd', { name: 'Boba' }));
    expect(generic.getTextContent()).not.toContain(t('settingsPets.store.checkFailed'));
    const sheet = await renderScreen(
      <StorePetListing {...props({ state: { kind: 'couldntAdd', reason: 'sheetCheck' } })} />,
    );
    expect(sheet.getTextContent()).toContain(t('settingsPets.store.checkFailed'));
  });

  it('opens Report through the shared external-link Action, never a local opener', async () => {
    externalUrlBoundary.mockClear();
    const url = 'https://petdex.dev/legal/takedown';
    const screen = await renderScreen(<StorePetListing {...props({ reportUrl: url })} />);
    await screen.pressByTestIdAsync('listing:reportLink');
    await vi.waitFor(() => expect(externalUrlBoundary).toHaveBeenCalledWith(url));
  });
});
