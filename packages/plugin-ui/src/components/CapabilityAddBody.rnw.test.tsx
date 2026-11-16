import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import {
  createHostApiStub,
  createSurfaceContext,
} from '../surfaceFixture.testSupport.js';
import {
  CapabilityAddBody,
  type CapabilityAddConfig,
} from './CapabilityAddBody.js';
import { capabilityCollectionAnatomy } from './Capabilities.js';
import { PluginUiProvider } from './PluginUiProvider.js';

type Listing = Readonly<{ id: string; name: string }>;

const byId = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('CapabilityAddBody', () => {
  it('says a failed registry once in the shared inline notice and asks it again from its Retry', async () => {
    const onRetry = vi.fn();
    const config: CapabilityAddConfig<Listing> = {
      title: 'Add an extension',
      modes: [
        { key: 'browse', label: 'Browse', icon: 'search', kind: 'catalog' },
      ],
      catalog: {
        query: '',
        onQueryChange: () => {},
        searchPlaceholder: 'Search extensions',
        items: [],
        itemKey: (item) => item.id,
        anatomy: capabilityCollectionAnatomy<Listing>({
          title: (item) => item.name,
        }),
        loading: false,
        sourceFailures: [
          {
            sourceId: 'acme',
            message: 'Acme registry did not answer.',
            onRetry,
          },
        ],
        empty: null,
      },
      renderDetail: () => null,
      detailFooter: () => ({
        primary: {
          label: 'Install',
          onPress: async () => ({ itemId: 'none', then: 'stay' }),
        },
        afterAdd: {},
      }),
      testID: 'add',
    };
    const context = createSurfaceContext();
    const mounted = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <CapabilityAddBody config={config} onClose={() => {}} />
      </PluginUiProvider>,
    );
    try {
      expect(
        byId(mounted.container, 'add:sourceFailure:acme')?.textContent,
      ).toContain('Acme registry did not answer.');
      await act(async () =>
        byId(mounted.container, 'add:sourceFailure:acme:retry')!.click(),
      );
      expect(onRetry).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
    }
  });
});
