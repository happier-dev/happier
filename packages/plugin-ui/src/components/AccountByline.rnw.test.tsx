import { describe, expect, it } from 'vitest';
import * as publicComponents from '@happier-dev/plugin-ui/components';

import { AccountBylineExample } from '../../fixtures/external-authoring/src/accountBylineSurface.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';

function mount(requester?: publicComponents.AccountActorLabel) {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
    <AccountBylineExample {...(requester ? { requester } : {})} />
  </PluginUiProvider>);
}

describe('external author account bylines', () => {
  it('names each classified Account in Happier’s words and reads the line once as who sent it', () => {
    expect(typeof publicComponents.AccountByline).toBe('function');
    expect(typeof publicComponents.HappierAccountByline).toBe('function');
    const mounted = mount();
    const expected = [['profile', 'Mara Chen'], ['self', 'You'], ['unnamed', 'Happier member'], ['former', 'Former member']];
    for (const [kind, name] of expected) {
      const name$ = mounted.container.querySelector(`[data-testid="author-byline-${kind}.name"]`);
      expect(name$?.textContent, kind).toBe(name);
      expect(name$?.getAttribute('aria-label'), kind).toBe(`Sent by ${name}`);
      // The face is decoration: the sentence already names the person.
      const face = mounted.container.querySelector(`[data-testid="author-byline-${kind}.face"]`);
      expect(face?.getAttribute('aria-hidden'), kind).toBe('true');
    }
    mounted.unmount();
  });

  it('lets the author name the requester in its own sentence, a former member never by a stale name', () => {
    const former = mount({ kind: 'former' });
    expect(former.container.querySelector('[data-testid="author-requester-waiting"]')?.textContent)
      .toBe('Waiting for Former member to confirm');
    former.unmount();
    const person = mount({ kind: 'profile', label: 'Bob Ito' });
    expect(person.container.querySelector('[data-testid="author-requester-waiting"]')?.textContent)
      .toBe('Waiting for Bob Ito to confirm');
    person.unmount();
  });
});
