import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import type { PluginUiPresentationHost } from '../presentationHost/context.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import {
  createHostApiStub,
  createSurfaceContext,
} from '../surfaceFixture.testSupport.js';
import { ScrollArea, Stack } from './Layout.js';
import { Item, ItemGroup } from './List.js';
import { PageHeader } from './PageHeader.js';
import { PluginUiProviderInternal } from './PluginUiProvider.js';

// DBW-UI-ACCEPT-1119 (routed header column offset): on a page that lays itself out on its whole pane (the Database
// workbench), the page header and every section capped themselves at the host's reading column while the rest of the
// page ran full width: the title stood 87 px off the body at 1440 and each section narrowed and centred. The page's
// column has one owner — the scroll area that lays the page out in the column — and the header and sections follow it.
const COLUMN_PX = 704;

function mount(page: ReactNode) {
  const context = createSurfaceContext();
  const presentationHost = {
    renderMarkdown: () => null,
    renderPopover: () => null,
    renderIcon: () => null,
    pageChrome: { showsTitle: false, columnMaxWidthPx: COLUMN_PX },
  } as unknown as PluginUiPresentationHost;
  return mountThroughReactNativeWeb(
    <PluginUiProviderInternal
      hostApi={createHostApiStub(context)}
      context={context}
      presentationHost={presentationHost}
    >
      {page}
    </PluginUiProviderInternal>,
  );
}

/** How many boxes between this node and the page root clamp it to the reading column. */
function columnCaps(node: HTMLElement | null, root: HTMLElement): number {
  let caps = 0;
  for (let at = node; at !== null && at !== root; at = at.parentElement) {
    if (at.style.maxWidth === `${COLUMN_PX}px`) caps += 1;
  }
  return caps;
}

const page = (
  <Stack>
    <PageHeader title="orders" testID="page-header" />
    <ItemGroup title="References" testID="references">
      <Item title="customers.id" testID="reference-row" />
    </ItemGroup>
  </Stack>
);

describe('the plugin page column', () => {
  it('lets the header and sections of a page laid out on its pane follow the page, uncapped', () => {
    const view = mount(page);
    try {
      const header = view.container.querySelector<HTMLElement>(
        '[data-testid="page-header"]',
      );
      const row = view.container.querySelector<HTMLElement>(
        '[data-testid="reference-row"]',
      );
      expect(header).not.toBeNull();
      expect(row).not.toBeNull();
      expect(columnCaps(header, view.container)).toBe(0);
      expect(columnCaps(row, view.container)).toBe(0);
    } finally {
      view.unmount();
    }
  });

  it('lays a scroll area page out in the one column, its header and sections inside it', () => {
    const view = mount(<ScrollArea>{page}</ScrollArea>);
    try {
      const header = view.container.querySelector<HTMLElement>(
        '[data-testid="page-header"]',
      );
      const row = view.container.querySelector<HTMLElement>(
        '[data-testid="reference-row"]',
      );
      expect(columnCaps(header, view.container)).toBe(1);
      expect(columnCaps(row, view.container)).toBe(1);
    } finally {
      view.unmount();
    }
  });
});
