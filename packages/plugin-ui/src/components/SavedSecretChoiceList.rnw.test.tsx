import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  SavedSecretChoiceList,
  type SavedSecretChoiceListProps,
} from '@happier-dev/plugin-ui/components';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import {
  createHostApiStub,
  createSurfaceContext,
} from '../surfaceFixture.testSupport.js';
import {
  PluginUiPresentationHostProviderInternal,
  type PluginUiPresentationHost,
} from '../presentationHost/context.js';
import { PluginUiProvider } from './PluginUiProvider.js';

function mount(children: React.ReactNode, host?: PluginUiPresentationHost) {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider context={context} hostApi={createHostApiStub(context)}>
      {host ? (
        <PluginUiPresentationHostProviderInternal host={host}>
          {children}
        </PluginUiPresentationHostProviderInternal>
      ) : (
        children
      )}
    </PluginUiProvider>,
  );
}

describe('saved secret choice list', () => {
  it('hands the author choice to the host list, and a host choice reaches the author as a reference', async () => {
    const onSelect = vi.fn();
    const host = {
      renderSavedSecretChoiceList: (input: SavedSecretChoiceListProps) => (
        <button
          data-testid={`${input.testIDPrefix}:saved:secret_ref:a`}
          data-selected={String(input.selectedRef === 'secret_ref:a')}
          onClick={() => input.onSelect({ ref: 'secret_ref:a', resourceRevision: 3 })}
        >
          Deploy key
        </button>
      ),
    } as unknown as PluginUiPresentationHost;
    const view = mount(
      <SavedSecretChoiceList testIDPrefix="author" selectedRef="secret_ref:a" onSelect={onSelect} />,
      host,
    );
    const row = view.container.querySelector<HTMLElement>('[data-testid="author:saved:secret_ref:a"]')!;
    expect(row.dataset.selected).toBe('true');
    await act(async () => {
      row.click();
    });
    expect(onSelect).toHaveBeenCalledWith({ ref: 'secret_ref:a', resourceRevision: 3 });
    view.unmount();
  });

  it('shows an explicit unavailable state on a host without the list', () => {
    const view = mount(
      <SavedSecretChoiceList
        testIDPrefix="author"
        selectedRef={null}
        onSelect={() => {}}
        unavailableLabel="Open in Happier to choose a saved secret"
      />,
    );
    expect(
      view.container.querySelector('[data-testid="author-unavailable"]')?.textContent,
    ).toBe('Open in Happier to choose a saved secret');
    view.unmount();
  });
});
