import type { ReactNode } from 'react';
import { View } from 'react-native';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import {
  createHostApiStub,
  createSurfaceContext,
} from '../surfaceFixture.testSupport.js';
import {
  PluginUiPresentationHostProviderInternal,
  type PluginUiPresentationHost,
} from '../presentationHost/context.js';
import { ModalCardFooterActions } from './ModalCardFooterActions.js';
import { PluginUiProvider } from './PluginUiProvider.js';

function mountFooter(children: ReactNode, phoneSheet: boolean) {
  const context = createSurfaceContext();
  const host = {
    useModalCardPhoneSheet: () => phoneSheet,
  } as unknown as PluginUiPresentationHost;
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <PluginUiPresentationHostProviderInternal host={host}>
        {children}
      </PluginUiPresentationHostProviderInternal>
    </PluginUiProvider>,
  );
}

// R19-D5: a typed save refusal rendered at the foot of a long form sat below the fold, so Add looked dead.
describe('ModalCardFooterActions note', () => {
  it('announces a refusal in the footer, and keeps it on a phone sheet instead of dropping it', () => {
    for (const phoneSheet of [false, true]) {
      const mount = mountFooter(
        <ModalCardFooterActions
          note="This source changed."
          noteTone="danger"
          noteTestID="refusal"
        >
          <View testID="primary" />
        </ModalCardFooterActions>,
        phoneSheet,
      );
      try {
        const refusal = mount.container.querySelector<HTMLElement>(
          '[data-testid="refusal"]',
        );
        expect(refusal, `phoneSheet=${phoneSheet}`).not.toBeNull();
        expect(refusal!.getAttribute('role')).toBe('alert');
        expect(refusal!.textContent).toBe('This source changed.');
      } finally {
        mount.unmount();
      }
    }
  });

  it('keeps a waiting note quiet, without an alert role', () => {
    const mount = mountFooter(
      <ModalCardFooterActions note="Saving check…" noteTestID="status">
        <View />
      </ModalCardFooterActions>,
      false,
    );
    try {
      const status = mount.container.querySelector<HTMLElement>(
        '[data-testid="status"]',
      );
      expect(status?.textContent).toBe('Saving check…');
      expect(status?.getAttribute('role')).toBeNull();
    } finally {
      mount.unmount();
    }
  });
});
