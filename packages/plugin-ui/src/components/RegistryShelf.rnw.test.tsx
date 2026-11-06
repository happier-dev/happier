import { act, type ComponentType, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import * as PluginUi from '@happier-dev/plugin-ui/components';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';

type Card = Readonly<{ id: string; title: string }>;
type Failure = Readonly<{ key: string; message: string; details?: readonly string[]; onRetry: () => void }>;
const publicUi = PluginUi as typeof PluginUi & {
  RegistryShelf?: ComponentType<{
    testID: string; title: string; items: readonly Card[]; loading: boolean; columnTitle: string;
    projection: { keyOf: (card: Card) => string; title: (card: Card) => string; description: () => null; testID: (card: Card) => string };
    where: () => null; action: () => ReactNode; onOpen: (card: Card) => void;
  }>;
  RegistrySourcesUnavailable?: ComponentType<{ failures: readonly Failure[]; testID: string }>;
  RegistryShelfAddControl?: ComponentType<{
    state: 'available' | 'adding' | 'added' | 'failed'; title: string; addLabel: string;
    addedLabel: string; failedLabel: string; onAdd: () => void; testID: string;
  }>;
};

function fixture() {
  const context = createSurfaceContext();
  const host = createHostApiStub(context);
  return (children: ReactNode) => <PluginUiProvider context={context} hostApi={host}>{children}</PluginUiProvider>;
}

describe('public registry presentation', () => {
  it('opens a lone suggestion independently from its add control and stays quiet when empty', async () => {
    const wrap = fixture();
    const Shelf = publicUi.RegistryShelf;
    const opened = vi.fn();
    const added = vi.fn();
    const card = { id: 'uptime', title: 'Know when my site is down' };
    const surface = (items: readonly Card[]) => wrap(Shelf ? <Shelf
      testID="suggestions" title="From the registry" items={items} loading={false} columnTitle="Name"
      projection={{ keyOf: value => value.id, title: value => value.title, description: () => null, testID: value => value.id }}
      where={() => null} action={() => <PluginUi.Button title="Add" testID="add" onPress={added} />}
      onOpen={opened}
    /> : null);
    const mounted = mountThroughReactNativeWeb(surface([card]));
    try {
      const row = mounted.container.querySelector<HTMLElement>('[data-testid="suggestions.uptime.row"][role="button"], [data-testid="suggestions.uptime.row"] [role="button"]');
      expect(row, 'registry shelves are available to plugin authors').not.toBeNull();
      act(() => mounted.container.querySelector<HTMLElement>('[data-testid="add"]')!.click());
      expect(added).toHaveBeenCalledOnce();
      expect(opened).not.toHaveBeenCalled();
      act(() => row!.click());
      expect(opened).toHaveBeenLastCalledWith(card);
      await mounted.render(surface([]));
      expect(mounted.container.textContent).toBe('');
    } finally { mounted.unmount(); }
  });

  it('keeps outage details collapsed and retries each distinct read once', () => {
    const Outage = publicUi.RegistrySourcesUnavailable;
    const shared = vi.fn();
    const other = vi.fn();
    const failures = [
      { key: 'a', message: 'Registry A unavailable', onRetry: shared },
      { key: 'b', message: 'Registry B unavailable', details: ['DNS lookup failed'], onRetry: shared },
      { key: 'c', message: 'Registry C unavailable', onRetry: other },
    ];
    const mounted = mountThroughReactNativeWeb(fixture()(Outage ? <Outage testID="outage" failures={failures} /> : null));
    try {
      const retry = mounted.container.querySelector<HTMLElement>('[data-testid="outage.retry"]');
      expect(retry, 'registry outage recovery is available to plugin authors').not.toBeNull();
      expect(mounted.container.textContent).not.toContain('Registry B');
      act(() => retry!.click());
      expect(shared).toHaveBeenCalledOnce();
      expect(other).toHaveBeenCalledOnce();
      act(() => mounted.container.querySelector<HTMLElement>('[data-testid="outage.details"]')!.click());
      expect(mounted.container.textContent).toContain('Registry B');
      expect(mounted.container.textContent).toContain('DNS lookup failed');
      act(() => mounted.container.querySelector<HTMLElement>('[data-testid="outage.details"]')!.click());
      expect(mounted.container.textContent).not.toContain('DNS lookup failed');
    } finally { mounted.unmount(); }
  });

  it('acknowledges its own successful add while initial added state and failed adds stay silent', async () => {
    const AddControl = publicUi.RegistryShelfAddControl;
    const wrap = fixture();
    const add = vi.fn();
    const surface = (state: 'available' | 'adding' | 'added' | 'failed') => wrap(AddControl ? <AddControl
      state={state} title="Linear" addLabel="Add" addedLabel="Added" failedLabel="Try again" onAdd={add} testID="linear"
    /> : null);
    const mounted = mountThroughReactNativeWeb(surface('added'));
    try {
      const status = () => mounted.container.querySelector<HTMLElement>('[data-testid="linear.status"]');
      expect(status(), 'shelf add acknowledgement is available to plugin authors').not.toBeNull();
      expect(status()!.textContent).toBe('');
      await mounted.render(surface('available'));
      act(() => mounted.container.querySelector<HTMLElement>('[data-testid="linear.add"]')!.click());
      expect(add).toHaveBeenCalledOnce();
      await mounted.render(surface('adding'));
      await mounted.render(surface('failed'));
      expect(status()!.textContent).toBe('');
      await mounted.render(surface('adding'));
      await mounted.render(surface('added'));
      expect(status()!.textContent).toContain('Linear, Added');
      expect(mounted.container.querySelector('[data-testid="linear.add"]')).toBeNull();
    } finally { mounted.unmount(); }
  });
});
