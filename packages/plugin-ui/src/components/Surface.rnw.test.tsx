import { describe, expect, it } from 'vitest';
import { View } from 'react-native';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiPresentationHostProviderInternal, type PluginUiPresentationHost } from '../presentationHost/context.js';
import { Button, Card, Surface, Text } from './index.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { HappierMaterialRoleProvider, HappierMaterialSurface } from '../presentation/layout/Surface.js';
import { happierSurfaceGradientWebStyle, happierMaterialBackgroundColor, happierMaterialInnerBackgroundColor } from '../presentation/layout/material.js';
import { HappierFieldTextBox, HappierSearchFieldBox } from '../presentation/form/FieldBox.js';
import { HappierSegmentedChoice } from '../presentation/form/SegmentedChoice.js';
import { HappierBadge, HappierBanner } from '../presentation/content/Foundation.js';
import { HappierSelect } from '../presentation/form/Fields.js';
import { HappierSelectionTiles } from '../presentation/form/SelectionTiles.js';

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
  it('lets descendant fields, segments and badges inherit material paint without fading their content', () => {
    const host: PluginUiPresentationHost = {
      renderMarkdown: () => null, renderCodeBlock: () => null, renderPopover: () => null, renderIcon: () => null,
      // The platform paint boundary returns a concrete translucent fill; field anatomy stays real.
      resolveMaterialColor: () => 'rgba(235, 230, 225, 0.1)',
    };
    const context = createSurfaceContext();
    const mount = mountSurface(<PluginUiPresentationHostProviderInternal host={host}>
      <HappierMaterialRoleProvider role="floating" resolveMaterialColor={host.resolveMaterialColor}>
      <HappierMaterialSurface materialRole="floating">
        <HappierFieldTextBox colors={{ backgroundColor: '#112233', borderColor: '#445566' }}><Text value="Field content" /></HappierFieldTextBox>
        <HappierSearchFieldBox testID="inner-search" colors={{ backgroundColor: '#112233', borderColor: '#445566' }} radius={8} onFocusInput={() => {}}><Text value="Search content" /></HappierSearchFieldBox>
        <HappierSegmentedChoice accessibilityLabel="Mode" colors={{ track: '#112233', thumb: '#112233', label: '#445566', activeLabel: '#445566', focusRing: '#445566' }} segments={[{ key: 'one', label: 'One', selected: true, disabled: false }]} onSelect={() => {}} />
        <HappierBadge backgroundColor="#112233" color="#445566">Badge</HappierBadge>
        <HappierBanner title="Notice" tone="neutral" backgroundColor="#112233" theme={context.theme} />
        <Button testID="inner-primary" title="Continue" onPress={() => {}} />
        <HappierSelect label="Choice" options={[{ value: 'one', label: 'One' }]} value="one" onChange={() => {}} theme={{ ...context.theme, colors: { ...context.theme.colors, elevatedSurface: '#112233' } }} />
        <HappierSelectionTiles variant="card" accessibilityLabel="Tiles" options={[{ id: 'one', title: 'One' }]} value="one" onChange={() => {}} colors={{ tileBackground: '#112233', tileBorder: '#445566', selection: '#445566', glyph: '#445566', ring: '#445566', previewBackground: '#112233', actionBackground: '#112233', actionBorderHovered: '#445566' }} renderText={({ text }) => <Text value={text} />} renderGlyph={() => null} />
      </HappierMaterialSurface>
      </HappierMaterialRoleProvider>
    </PluginUiPresentationHostProviderInternal>);
    const backgrounds = [...mount.container.querySelectorAll<HTMLElement>('div')].map(node => getComputedStyle(node).backgroundColor);
    expect(backgrounds).not.toContain(resolveRenderedColor('backgroundColor', '#112233'));
    expect(backgrounds).toContain(resolveRenderedColor('backgroundColor', 'rgba(235, 230, 225, 0.1)'));
    expect(mount.container.textContent).toContain('Field content');
    expect(mount.container.textContent).toContain('Search content');
    expect(getComputedStyle(mount.container.querySelector<HTMLElement>('[data-testid="inner-primary"]')!).backgroundColor).toBe(resolveRenderedColor('backgroundColor', 'rgba(235, 230, 225, 0.1)'));
    mount.unmount();
  });
  it('does not invent a containing finish when a standalone surface declares nested topology', () => {
    const gradient = { colors: ['rgba(0,0,0,0)', 'rgba(0,0,0,0.024)'] as const };
    const mount = mountSurface(<HappierMaterialSurface testID="standalone-nested" materialRole="floating" nested gradient={gradient}><Text value="Standalone" /></HappierMaterialSurface>);
    expect(getComputedStyle(mount.container.querySelector<HTMLElement>('[data-testid="standalone-nested"]')!).backgroundImage).toContain('linear-gradient');
    expect(mount.container.textContent).toBe('Standalone');
    mount.unmount();
  });
  it('keeps native-host secondary material paint separate from the primary fill and flat fields', () => {
    const host: PluginUiPresentationHost = {
      renderMarkdown: () => null, renderCodeBlock: () => null, renderPopover: () => null, renderIcon: () => null,
      // The real host delegates this concrete tint to its native glass owner.
      resolveMaterialColor: () => '#11223380',
    };
    const context = createSurfaceContext();
    const mount = mountSurface(<PluginUiPresentationHostProviderInternal host={host}>
      <Button testID="secondary-material" title="Cancel" variant="secondary" onPress={() => {}} />
      <Button testID="primary-material" title="Continue" onPress={() => {}} />
    </PluginUiPresentationHostProviderInternal>, context);
    const color = (id: string) => getComputedStyle(mount.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!).backgroundColor;
    expect(color('secondary-material')).toBe(resolveRenderedColor('backgroundColor', '#11223380'));
    expect(color('primary-material')).toBe(resolveRenderedColor('backgroundColor', context.theme.colors.accent));
    mount.unmount();
  });
  it('uses the floating override for menus rather than the card override', () => {
    const context = createSurfaceContext();
    const mount = mountSurface(<>
      <Surface testID="floating-finish" materialRole="floating"><Text value="Menu" /></Surface>
      <Card testID="card-finish"><Text value="Card" /></Card>
    </>, { ...context, theme: { ...context.theme, surfaceFinish: { card: null, floating: { colors: ['rgba(0,0,0,0)', 'rgba(0,0,0,0.024)'] } } } });
    const paint = (id: string) => getComputedStyle(mount.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.firstElementChild!).backgroundImage;
    expect(paint('floating-finish')).toContain('linear-gradient');
    expect(['', 'none']).toContain(paint('card-finish'));
    mount.unmount();
  });
  it('carries the resolved disabled and explicit-flat finish through the host material boundary', () => {
    const gradient = { colors: ['rgba(0,0,0,0)', 'rgba(0,0,0,0.024)'] as [string, string] };
    const context = createSurfaceContext();
    const host: PluginUiPresentationHost = {
      renderMarkdown: () => null, renderCodeBlock: () => null, renderPopover: () => null, renderIcon: () => null,
      // Native paint is the external boundary; the shared role/state decision remains real.
      renderMaterialSurface: input => <View testID={input.testID} style={happierSurfaceGradientWebStyle(input.gradient)}>{input.children}</View>,
    };
    const mount = mountSurface(<PluginUiPresentationHostProviderInternal host={host}>
      <HappierMaterialSurface testID="soft" materialRole="content" gradient={gradient}><Text value="Soft" /></HappierMaterialSurface>
      <HappierMaterialSurface testID="disabled" materialRole="content" gradient={gradient} disabled><Text value="Disabled" /></HappierMaterialSurface>
      <HappierMaterialSurface testID="flat" materialRole="content" gradient={null}><Text value="Flat" /></HappierMaterialSurface>
    </PluginUiPresentationHostProviderInternal>, context);
    const paint = (id: string) => getComputedStyle(mount.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!).backgroundImage;
    expect(paint('soft')).toContain('linear-gradient');
    expect(['', 'none']).toContain(paint('disabled'));
    expect(['', 'none']).toContain(paint('flat'));
    mount.unmount();
  });
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
      resolveRenderedColor('backgroundColor', happierMaterialInnerBackgroundColor(highContrastContext.theme.colors.border, highContrastContext.theme.colors.divider, 'content', true)),
    );

    mount.unmount();
  });
});
