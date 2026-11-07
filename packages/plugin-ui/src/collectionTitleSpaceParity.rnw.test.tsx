import * as React from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import * as publicUi from './components/index.js';
import { PluginUiProvider } from './components/PluginUiProvider.js';
import { mountThroughReactNativeWeb } from './rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from './surfaceFixture.testSupport.js';

describe('public collection title and Space mark parity', () => {
  it('opens the named collection scope and draws held Project identity through the author entry', async () => {
    // Missing public composition is the reported parity defect; primitive Icon/Avatar exports do not satisfy it.
    expect(publicUi).toEqual(expect.objectContaining({ CollectionTitleButton: expect.any(Function), CollectionSpaceIcon: expect.any(Function) }));
    function Surface() {
      const [open, setOpen] = React.useState(false);
      return <>
        <publicUi.CollectionTitleButton testID="scope" label="Release work" accessibilityLabel="Choose Space"
          expanded={open} hasPopup="menu" onPress={() => setOpen(value => !value)} />
        <publicUi.CollectionSpaceIcon testID="project" size={16} icon={{ kind: 'project', favicon: { uri: 'data:image/svg+xml;base64,PHN2Zy8+' } }} />
        <publicUi.CollectionSpaceIcon testID="missing" size={16} icon={{ kind: 'project' }} />
        <publicUi.CollectionSpaceIcon testID="glyph" size={16} icon={{ kind: 'icon', name: 'review' }} />
      </>;
    }
    const context = createSurfaceContext();
    const page = mountThroughReactNativeWeb(<PluginUiProvider context={context} hostApi={createHostApiStub(context)}>
      <Surface />
    </PluginUiProvider>);
    try {
      const trigger = page.container.querySelector<HTMLElement>('[data-testid="scope"]')!;
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      await act(async () => { trigger.click(); });
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(page.container.querySelector('[data-testid="project-project-favicon"]')).not.toBeNull();
      expect(page.container.querySelector('[data-testid="project-project-fallback"]')).toBeNull();
      expect(page.container.querySelector('[data-testid="missing-project-fallback"]')).not.toBeNull();
      expect(page.container.querySelector('[data-testid="glyph"]')).not.toBeNull();
    } finally { page.unmount(); }
  });

});
