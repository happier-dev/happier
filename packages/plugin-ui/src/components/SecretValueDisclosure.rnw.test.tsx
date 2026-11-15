import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  SecretValueControls,
  SecretValueText,
  type SecretValueControlsProps,
  type SecretValueTextProps,
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

describe('secret value disclosure', () => {
  it('hands the author value and controls to the host presenter, and its presses reach the author callbacks', async () => {
    const onToggleReveal = vi.fn();
    const onCopy = vi.fn();
    const host = {
      renderSecretValueText: (input: SecretValueTextProps) => (
        <span data-testid={input.testID}>{input.revealed ?? input.mask}</span>
      ),
      renderSecretValueControls: (input: SecretValueControlsProps) => (
        <>
          <button
            data-testid={`${input.testIDPrefix}-reveal`}
            onClick={input.onToggleReveal}
          >
            {input.revealed ? input.hideLabel : input.revealLabel}
          </button>
          {input.onCopy ? (
            <button
              data-testid={`${input.testIDPrefix}-copy`}
              onClick={input.onCopy}
            >
              copy
            </button>
          ) : null}
        </>
      ),
    } as unknown as PluginUiPresentationHost;
    const view = mount(
      <>
        <SecretValueText testID="token" revealed={null} mask="••••••" />
        <SecretValueControls
          testIDPrefix="token"
          revealed={false}
          revealLabel="Show token"
          hideLabel="Hide token"
          onToggleReveal={onToggleReveal}
          onCopy={onCopy}
        />
      </>,
      host,
    );
    expect(
      view.container.querySelector('[data-testid="token"]')?.textContent,
    ).toBe('••••••');
    expect(
      view.container.querySelector('[data-testid="token-reveal"]')?.textContent,
    ).toBe('Show token');
    await act(async () => {
      view.container
        .querySelector<HTMLElement>('[data-testid="token-reveal"]')!
        .click();
    });
    await act(async () => {
      view.container
        .querySelector<HTMLElement>('[data-testid="token-copy"]')!
        .click();
    });
    expect(onToggleReveal).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('shows an explicit unavailable state, never the value, on a host without the presenter', () => {
    const view = mount(
      <>
        <SecretValueText
          testID="token"
          revealed="sk-live-123"
          mask="••••"
          unavailableLabel="Open in Happier to view"
        />
        <SecretValueControls
          testIDPrefix="token"
          revealed={false}
          revealLabel="Show"
          hideLabel="Hide"
          onToggleReveal={() => {}}
        />
      </>,
    );
    expect(view.container.textContent).not.toContain('sk-live-123');
    expect(
      view.container.querySelector('[data-testid="token-unavailable"]')
        ?.textContent,
    ).toBe('Open in Happier to view');
    expect(view.container.querySelector('[role="button"]')).toBeNull();
    view.unmount();
  });
});
