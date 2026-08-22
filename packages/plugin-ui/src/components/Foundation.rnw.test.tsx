import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import {
  Badge,
  Banner,
  Divider,
  Heading,
  Label,
  Link,
  Metadata,
  Progress,
} from './index.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import {
  HappierProgress,
  HappierLink,
  isHappierBannerUrgent,
  resolveHappierProgressPercentage,
} from '../presentation/content/Foundation.js';

function mountFoundation(children: React.ReactNode, hostApi = createHostApiStub()) {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={hostApi} context={context}>
      {children}
    </PluginUiProvider>,
  );
}

describe('foundation presentation families', () => {
  it('keeps shared progress non-interactive through the RNW style contract', () => {
    const context = createSurfaceContext();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mount = mountThroughReactNativeWeb(
      <HappierProgress
        label="Installing"
        pointerEvents="none"
        testID="shared-progress"
        theme={context.theme}
      />,
    );

    try {
      const progress = mount.container.querySelector<HTMLElement>('[data-testid="shared-progress"]');
      expect(progress).not.toBeNull();
      expect(getComputedStyle(progress!).pointerEvents).toBe('none');
      expect(warning.mock.calls.filter(([message]) => (
        String(message).includes('props.pointerEvents is deprecated. Use style.pointerEvents')
      ))).toEqual([]);
    } finally {
      mount.unmount();
      warning.mockRestore();
    }
  });

  it('keeps core and plugin progress/tone normalization on one owner', () => {
    expect(resolveHappierProgressPercentage(undefined, { indeterminate: 0.15, minimumVisible: 0.04 })).toBe(15);
    expect(resolveHappierProgressPercentage(0, { indeterminate: 0.15, minimumVisible: 0.04 })).toBe(4);
    expect(resolveHappierProgressPercentage(0.4, { indeterminate: 0.15, minimumVisible: 0.04 })).toBe(40);
    expect(resolveHappierProgressPercentage(1.2, { indeterminate: 0.15, minimumVisible: 0.04 })).toBe(100);
    expect(resolveHappierProgressPercentage(Number.NaN, { indeterminate: 0.15, minimumVisible: 0.04 })).toBe(15);
    expect(isHappierBannerUrgent('warning')).toBe(true);
    expect(isHappierBannerUrgent('neutral')).toBe(false);
  });

  it('renders heading, label, divider, badge, and metadata with bounded semantics', () => {
    const mount = mountFoundation(
      <>
        <Heading value="Diagnostics" level={2} testID="heading" />
        <Label value="Generation" testID="label" />
        <Divider accessibilityLabel="Runtime" />
        <Badge value="Current" tone="success" testID="current-badge" />
        <Metadata
          title="Details"
          entries={[
            { label: 'Plugin', value: 'Inspector' },
            { label: 'Generation', value: '17', tone: 'secondary' },
          ]}
        />
      </>,
    );

    expect(mount.container.querySelector('[data-testid="heading"]')?.getAttribute('aria-level')).toBe('2');
    expect(mount.container.querySelector('[data-testid="label"]')?.getAttribute('role')).not.toBe('heading');
    expect(mount.container.querySelector('[role="separator"]')?.getAttribute('aria-label')).toBe('Runtime');
    expect(mount.container.querySelector('[data-testid="current-badge"]')?.getAttribute('role')).not.toBe('status');
    expect(mount.container.textContent).toContain('Plugin');
    expect(mount.container.textContent).toContain('Inspector');
    expect(mount.container.innerHTML).not.toContain('happier-plugin-');

    mount.unmount();
  });

  it('resolves every author-owned foundation chrome label through the plugin catalog', () => {
    const context = createSurfaceContext({
      translations: {
        'acme.runtime': 'Exécution',
        'acme.details': 'Détails',
        'acme.plugin': 'Extension',
        'acme.installing': 'Installation',
        'acme.warning': 'Attention',
        'acme.warning.detail': 'Vérifiez la configuration.',
      },
    });
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <Divider accessibilityLabel="Runtime" accessibilityLabelKey="acme.runtime" />
        <Metadata
          title="Details"
          titleKey="acme.details"
          entries={[{ label: 'Plugin', labelKey: 'acme.plugin', value: 'Inspector' }]}
        />
        <Progress value={0.5} label="Installing" labelKey="acme.installing" />
        <Banner
          title="Warning"
          titleKey="acme.warning"
          description="Check the configuration."
          descriptionKey="acme.warning.detail"
        />
      </PluginUiProvider>,
    );

    expect(mount.container.textContent).toContain('Détails');
    expect(mount.container.textContent).toContain('Extension');
    expect(mount.container.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toBe('Installation');
    expect(mount.container.textContent).toContain('Attention');
    expect(mount.container.textContent).toContain('Vérifiez la configuration.');
    expect(mount.container.querySelector('[role="separator"]')?.getAttribute('aria-label')).toBe('Exécution');
    mount.unmount();
  });

  it('routes external links through the bound host instead of navigating directly', async () => {
    const openExternalLink = vi.fn(async () => undefined);
    const hostApi = createHostApiStub(createSurfaceContext(), { openExternalLink });
    const mount = mountFoundation(
      <Link title="Documentation" url="https://docs.happier.dev/plugins" />,
      hostApi,
    );

    const link = mount.container.querySelector<HTMLElement>('[role="link"]');
    expect(link?.textContent).toBe('Documentation');
    await act(async () => { link?.click(); });
    expect(openExternalLink).toHaveBeenCalledWith('https://docs.happier.dev/plugins');

    mount.unmount();
  });

  it('preserves dense web link layout instead of fabricating an Android touch floor', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <HappierLink label="Documentation" onPress={() => {}} theme={context.theme}>
          Documentation
        </HappierLink>
      </PluginUiProvider>,
    );

    const link = mount.container.querySelector<HTMLElement>('[role="link"]');
    expect(link).not.toBeNull();
    const style = getComputedStyle(link!);
    expect(style.minHeight).toBe('0px');
    expect(style.minWidth).toBe('0px');

    mount.unmount();
  });

  it('renders an explicitly themed shared link without an environment provider', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <HappierLink label="Documentation" onPress={() => {}} theme={context.theme}>
        Documentation
      </HappierLink>,
    );

    const link = mount.container.querySelector<HTMLElement>('[role="link"]');
    const text = link?.firstElementChild as HTMLElement | null;
    const expectedText = document.createElement('span');
    expectedText.style.color = context.theme.colors.accent;
    mount.container.append(expectedText);
    expect(link?.textContent).toBe('Documentation');
    expect(getComputedStyle(text!).color).toBe(getComputedStyle(expectedText).color);
    expectedText.remove();

    mount.unmount();
  });

  it('exposes determinate progress and semantic banner state without motion-only meaning', () => {
    const mount = mountFoundation(
      <>
        <Progress value={0.6} label="Installing" />
        <Banner tone="warning" title="Provider unavailable" description="Reconnect the owner machine." />
      </>,
    );

    const progress = mount.container.querySelector('[role="progressbar"]');
    expect(progress?.getAttribute('aria-valuemin')).toBe('0');
    expect(progress?.getAttribute('aria-valuemax')).toBe('100');
    expect(progress?.getAttribute('aria-valuenow')).toBe('60');
    expect(mount.container.querySelector('[role="alert"]')?.textContent).toContain('Provider unavailable');

    mount.unmount();
  });
});
