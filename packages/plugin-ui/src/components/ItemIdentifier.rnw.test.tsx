import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { Item } from './List.js';

function mountSurface(children: React.ReactNode) {
  const context = createSurfaceContext();
  return { context, mount: mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>{children}</PluginUiProvider>,
  ) };
}

/** The element whose own text is exactly `text`. */
function runOf(root: HTMLElement, text: string): HTMLElement {
  const match = [...root.querySelectorAll<HTMLElement>('*')].find((node) => node.childNodes.length === 1
    && node.firstChild?.nodeType === 3 && node.textContent === text);
  if (!match) throw new Error(`No run reads ${text}`);
  return match;
}

describe('an Item that names code', () => {
  it('sets its title and detail in the code face and leaves a plain row in the interface face', () => {
    const { context, mount } = mountSurface(<>
      <Item identifier title="formatTotal" detail="lib/billing/totals.ts:42:18" />
      <Item title="Plain title" detail="Plain detail" />
    </>);
    try {
      const code = context.theme.typography.code.fontFamily;
      expect(code).toBeTruthy();
      expect(runOf(mount.container, 'formatTotal').style.fontFamily).toBe(code);
      expect(runOf(mount.container, 'lib/billing/totals.ts:42:18').style.fontFamily).toBe(code);
      expect(runOf(mount.container, 'Plain title').style.fontFamily).not.toBe(code);
    } finally { mount.unmount(); }
  });
});
