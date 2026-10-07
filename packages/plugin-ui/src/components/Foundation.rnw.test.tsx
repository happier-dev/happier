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
import { PluginUiProvider, PluginUiProviderInternal } from './PluginUiProvider.js';
import type { PluginUiPresentationHost } from '../presentationHost/context.js';
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
  it('keeps a capacity meter silent while a named progress bar reports its value', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(<>
      <HappierProgress value={0.42} label="Capacity" semantics="none" testID="capacity" theme={context.theme} />
      <HappierProgress value={0.42} label="Installing" testID="progress" theme={context.theme} />
    </>);
    expect(mount.container.querySelector('[data-testid="capacity"]')?.getAttribute('role')).toBeNull();
    expect(mount.container.querySelector('[data-testid="progress"]')?.getAttribute('aria-valuenow')).toBe('42');
    mount.unmount();
  });
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
    // "Needs you" speaks like a warning: announced, with the warning mark.
    expect(isHappierBannerUrgent('attention')).toBe(true);
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

  it('steps heading levels down the ramp and renders the same-realm host type roles', () => {
    const typography = {
      heading: { fontSize: 22, lineHeight: 28, fontWeight: '700', fontFamily: 'HostDisplay', letterSpacing: -0.4 },
      title: { fontSize: 17, lineHeight: 22, fontWeight: '600', fontFamily: 'HostText' },
      label: { fontSize: 15, lineHeight: 20, fontWeight: '600', fontFamily: 'HostText' },
      body: { fontSize: 13, lineHeight: 17, fontWeight: '400', fontFamily: 'HostText' },
      caption: { fontSize: 12, lineHeight: 16, fontWeight: '400', fontFamily: 'HostText', fontVariant: ['tabular-nums'] as const },
    } as const;
    const host = {
      typography,
      renderMarkdown: () => null,
      renderPopover: () => null,
    } as unknown as PluginUiPresentationHost;
    const context = createSurfaceContext();
    // The rendered element's own style: jsdom resolves heading elements
    // (`<h1>`, `<h2>`) against its user-agent sheet rather than RNW's inline
    // declaration, so computed font metrics are not the rendered ones there.
    const read = (container: HTMLElement, testID: string) => (
      container.querySelector<HTMLElement>(`[data-testid="${testID}"]`)!.style
    );

    const hosted = mountThroughReactNativeWeb(
      <PluginUiProviderInternal hostApi={createHostApiStub(context)} context={context} presentationHost={host}>
        <Heading value="Page" level={1} testID="h1" />
        <Heading value="Pane" level={2} testID="h2" />
        <Heading value="Group" level={3} testID="h3" />
        <Label value="Field" testID="label" />
      </PluginUiProviderInternal>,
    );
    expect(read(hosted.container, 'h1').fontSize).toBe('22px');
    expect(read(hosted.container, 'h1').fontFamily).toBe('HostDisplay');
    expect(read(hosted.container, 'h1').letterSpacing).toBe('-0.4px');
    expect(read(hosted.container, 'h2').fontSize).toBe('17px');
    expect(read(hosted.container, 'h3').fontSize).toBe('15px');
    expect(read(hosted.container, 'label').fontFamily).toBe('HostText');
    hosted.unmount();

    // Without same-realm host facts (a hosted-web realm or a bare provider) the
    // public snapshot's metrics apply, still as a descending ramp.
    const snapshot = mountFoundation(
      <>
        <Heading value="Pane" level={2} testID="h2" />
        <Heading value="Group" level={3} testID="h3" />
      </>,
    );
    expect(read(snapshot.container, 'h2').fontSize).toBe(`${context.theme.typography.title.fontSize}px`);
    expect(read(snapshot.container, 'h3').fontSize).toBe(`${context.theme.typography.label.fontSize}px`);
    snapshot.unmount();
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

  it('draws stacked shares as one named image, each share at its width in its tone', () => {
    const context = createSurfaceContext();
    const mount = mountFoundation(
      <Progress label="src/a.ts: 96 added, 71 removed" testID="lines"
        segments={[{ value: 0.6, tone: 'success' }, { value: 0.3, tone: 'danger' }]} />,
    );

    const bar = mount.container.querySelector<HTMLElement>('[data-testid="lines"]');
    // A stack of shares reports no progress: it is one picture, named by its label.
    expect(bar?.getAttribute('role')).toBe('img');
    expect(bar?.getAttribute('aria-label')).toBe('src/a.ts: 96 added, 71 removed');
    expect(bar?.getAttribute('aria-valuenow')).toBeNull();
    const fills = [0, 1].map((index) => mount.container.querySelector<HTMLElement>(`[data-testid="lines-segment-${index}"]`));
    expect(fills.map((fill) => fill?.style.width)).toEqual(['60%', '30%']);
    expect(getComputedStyle(fills[0]!).backgroundColor).toBe(getComputedStyle(withColor(context.theme.colors.success)).backgroundColor);
    expect(getComputedStyle(fills[1]!).backgroundColor).toBe(getComputedStyle(withColor(context.theme.colors.danger)).backgroundColor);

    mount.unmount();
  });
});

function withColor(color: string): HTMLElement {
  const probe = document.createElement('div');
  probe.style.backgroundColor = color;
  document.body.appendChild(probe);
  return probe;
}
