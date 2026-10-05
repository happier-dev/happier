import { describe, expect, it } from 'vitest';
import { View } from 'react-native';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiPresentationHostProviderInternal, type PluginUiPresentationHost } from '../presentationHost/context.js';
import { Button, Card, Surface, Text } from './index.js';
import { PluginUiProvider } from './PluginUiProvider.js';

function mountSurface(
  children: React.ReactElement,
  context = createSurfaceContext(),
) {
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      {children}
    </PluginUiProvider>,
  );
}

function resolveRenderedColor(
  property: 'backgroundColor' | 'borderTopColor',
  color: string,
): string {
  const probe = document.createElement('div');
  probe.style[property] = color;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe)[property];
  probe.remove();
  return resolved;
}

describe('Surface and Card', () => {
  it('paints a material role through the host opacity without fading the contents', () => {
    const mount = mountSurface(
      <Surface testID="material-surface" materialRole="sidebar">
        <Text value="Readable foreground" />
      </Surface>,
    );
    const body = mount.container.querySelector<HTMLElement>('[data-testid="material-surface"]')!.firstElementChild!;

    expect(getComputedStyle(body).backgroundColor).toContain('var(--happier-glass-sidebar-opacity, 100%)');
    expect(['', '1']).toContain(getComputedStyle(body).opacity);
    expect(body.textContent).toBe('Readable foreground');
    mount.unmount();
  });

  it('keeps the host material renderer and actionable card behavior in the same surface', () => {
    let presses = 0;
    // This boundary renderer stands in for the native material adapter; all shared surface and press logic stays real.
    const host: PluginUiPresentationHost = {
      renderMarkdown: () => null,
      renderCodeBlock: () => null,
      renderPopover: () => null,
      renderIcon: () => null,
      renderMaterialSurface: (input) => (
        <View testID={`host-material-${input.role}${input.nested ? '-nested' : ''}`} style={input.style}>{input.children}</View>
      ),
    };
    const mount = mountSurface(
      <PluginUiPresentationHostProviderInternal host={host}>
        <Card materialRole="floating" accessibilityLabel="Open review" onPress={() => { presses += 1; }}>
          <Text value="Review summary" />
          <Surface materialRole="floating"><Text value="Review details" /></Surface>
        </Card>
      </PluginUiPresentationHostProviderInternal>,
    );

    const body = mount.container.querySelector<HTMLElement>('[data-testid="host-material-floating"]');
    expect(body?.textContent).toContain('Review summary');
    expect(mount.container.querySelector('[data-testid="host-material-floating-nested"]')?.textContent).toBe('Review details');
    expect(body && getComputedStyle(body).backgroundColor).toBe(
      resolveRenderedColor('backgroundColor', createSurfaceContext().theme.colors.surface),
    );
    mount.container.querySelector<HTMLElement>('[role="button"]')?.click();
    expect(presses).toBe(1);
    mount.unmount();
  });

  it('uses a separate nested coat without changing the child foreground or another material group', () => {
    const mount = mountSurface(
      <Surface testID="content-plane">
        <Card testID="nested-card"><Text value="Working content" /></Card>
        <Surface testID="floating-plane" materialRole="floating"><Text value="Floating content" /></Surface>
      </Surface>,
    );
    const body = (id: string) => mount.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.firstElementChild!;
    expect(getComputedStyle(body('content-plane')).backgroundColor).toContain('var(--happier-glass-content-opacity, 100%)');
    expect(getComputedStyle(body('nested-card')).backgroundColor).toContain('var(--happier-glass-content-nested-opacity, 100%)');
    expect(getComputedStyle(body('floating-plane')).backgroundColor).toContain('var(--happier-glass-floating-opacity, 100%)');
    expect(['', '1']).toContain(getComputedStyle(body('nested-card')).opacity);
    mount.unmount();
  });

  it('render bounded native surface hosts instead of the retired Panel marker', () => {
    const mount = mountSurface(
      <Surface testID="review-surface" padding="small">
        <Card testID="review-card">
          <Text value="Review summary" />
        </Card>
      </Surface>,
    );

    expect(mount.container.querySelector('happier-plugin-panel')).toBeNull();
    expect(mount.container.querySelector('[data-testid="review-surface"]')).not.toBeNull();
    expect(mount.container.querySelector('[data-testid="review-card"]')?.textContent).toContain('Review summary');

    mount.unmount();
  });

  it('uses the shared press lifecycle when a card is actionable', () => {
    let presses = 0;
    const mount = mountSurface(
      <Card
        accessibilityLabel="Open review"
        onPress={() => { presses += 1; }}
      >
        <Text value="Review summary" />
      </Card>,
    );

    const control = mount.container.querySelector<HTMLElement>('[role="button"]');
    expect(control?.getAttribute('aria-label')).toBe('Open review');
    control?.click();
    expect(presses).toBe(1);

    mount.unmount();
  });

  it('strengthens shared surface boundaries and control fills when high contrast turns on', async () => {
    const normalContext = createSurfaceContext({ contrast: 'normal' });
    const highContrastContext = createSurfaceContext({ contrast: 'high' });
    const hostApi = createHostApiStub(normalContext);
    const content = (
      <Surface testID="contrast-surface">
        <Button title="Review" variant="secondary" onPress={() => {}} />
      </Surface>
    );
    const renderWith = (context: typeof normalContext) => (
      <PluginUiProvider hostApi={hostApi} context={context}>
        {content}
      </PluginUiProvider>
    );
    const mount = mountThroughReactNativeWeb(renderWith(normalContext));

    const normalSurfaceBorder = getComputedStyle(
      mount.container.querySelector<HTMLElement>('[data-testid="contrast-surface"]')?.firstElementChild!,
    ).borderTopColor;
    const normalControlFill = getComputedStyle(
      mount.container.querySelector<HTMLElement>('[role="button"]')!,
    ).backgroundColor;

    await mount.render(renderWith(highContrastContext));

    const highContrastSurface = mount.container.querySelector<HTMLElement>('[data-testid="contrast-surface"]')?.firstElementChild;
    const highContrastControl = mount.container.querySelector<HTMLElement>('[role="button"]');

    expect(getComputedStyle(highContrastSurface!).borderTopColor).not.toBe(normalSurfaceBorder);
    expect(getComputedStyle(highContrastControl!).backgroundColor).not.toBe(normalControlFill);
    expect(getComputedStyle(highContrastSurface!).borderTopColor).toBe(
      resolveRenderedColor('borderTopColor', highContrastContext.theme.colors.text),
    );
    expect(getComputedStyle(highContrastControl!).backgroundColor).toBe(
      resolveRenderedColor('backgroundColor', highContrastContext.theme.colors.border),
    );

    mount.unmount();
  });
});
