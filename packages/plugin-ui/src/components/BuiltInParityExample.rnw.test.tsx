import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { BuiltInParityExample } from '../../fixtures/external-authoring/src/builtInParitySurface.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';

describe('external author collection title', () => {
  it('switches the visible Space only when the host dialog accepts, and settles its expanded state', async () => {
    const context = createSurfaceContext();
    let answer: (accepted: boolean) => void = () => { throw new Error('No host dialog is open'); };
    let reject: (error: Error) => void = () => { throw new Error('No host dialog is open'); };
    let requestedTitle: string | undefined;
    const hostApi = {
      ...createHostApiStub(context),
      // The host's native dialog is the system boundary; keep the real example and public controls beneath it.
      confirm: (_message: string, options?: Readonly<{ title?: string }>) => new Promise<boolean>((resolve, rejectDialog) => {
        requestedTitle = options?.title;
        answer = resolve;
        reject = rejectDialog;
      }),
    };
    const exampleProps = { text: (words: string) => words, onDecide: () => undefined };
    const mount = mountThroughReactNativeWeb(<PluginUiProvider context={context} hostApi={hostApi}>
      <BuiltInParityExample {...exampleProps} />
    </PluginUiProvider>);
    try {
      const trigger = mount.container.querySelector<HTMLElement>('[data-testid="author-collection-title"]')!;
      const selected = () => trigger.textContent;
      expect(selected()).toBe('Release reviews');
      await act(async () => { trigger.click(); });
      expect(requestedTitle).toBe('My team');
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      await act(async () => { answer(false); });
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(selected()).toBe('Release reviews');

      await act(async () => { trigger.click(); });
      await act(async () => { answer(true); });
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(selected()).toBe('My team');

      await act(async () => { trigger.click(); });
      await act(async () => { reject(new Error('Host dialog unavailable')); });
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(selected()).toBe('My team');
      expect(mount.container.querySelector('[data-testid="author-collection-scope-error"]')).not.toBeNull();
    } finally { mount.unmount(); }
  });
});
