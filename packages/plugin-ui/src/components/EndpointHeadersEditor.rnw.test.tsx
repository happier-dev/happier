import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { HappierUiPaletteProvider } from '../environment/context.js';
import type { HappierUiPalette } from '../environment/types.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import {
  EndpointHeadersEditor,
  type EndpointHeadersEditorCopy,
  type EndpointHeadersEditorProps,
} from './EndpointHeadersEditor.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { PluginUiPresentationHostProviderInternal, type PluginUiPresentationHost } from '../presentationHost/context.js';

// The host's page palette: a field TextField draws its committing field box only inside one.
const PALETTE: HappierUiPalette = {
  page: '#fafafa', sheet: '#ffffff', sheetBorder: '#e0e0e0', rowDivider: '#eeeeee', groupDivider: '#0d0e0f',
  controlBorder: '#abcdef', fieldBackground: '#fdfdfd', placeholder: '#999999', selection: '#111111',
  switchTrackOn: '#123456', switchTrackOff: '#654321', switchThumb: '#fedcba', segmentTrack: '#e1e1e1',
  segmentThumb: '#fefefe', navigationSelected: '#e8e8e8', navigationHover: '#efefef',
};

const copy = (layer: string): EndpointHeadersEditorCopy => ({
  title: 'Request headers',
  inherited: layer === 'machine' ? 'Same as every machine' : 'From the provider',
  set: layer === 'machine' ? 'Set for this machine' : 'Set for every machine',
  required: 'Required',
  changedCount: (count) => `${count} changed`,
  needs: (names) => `Needs ${names}`,
  reset: 'Reset headers',
  resetDescription: 'Use the inherited values',
});

function mount(props: Omit<EndpointHeadersEditorProps, 'copy' | 'testID'>) {
  const context = createSurfaceContext();
  const view = mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <HappierUiPaletteProvider palette={PALETTE}>
        <EndpointHeadersEditor testID="ep" copy={copy(props.layer)} {...props} />
      </HappierUiPaletteProvider>
    </PluginUiProvider>,
  );
  const input = (name: string) => view.container.querySelector<HTMLInputElement>(`[data-testid="ep.header.${name}"]`);
  const row = (name: string) => view.container.querySelector<HTMLElement>(`[data-testid="ep.header.${name}.row"]`)?.textContent ?? '';
  const commit = async (name: string, value: string) => {
    const field = input(name)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { field.dispatchEvent(new FocusEvent('blur')); field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  };
  return { view, input, row, commit, text: () => view.container.textContent ?? '' };
}

describe('EndpointHeadersEditor', () => {
  it('shows each value in force with where it comes from and the provider\'s consequence', () => {
    const editor = mount({
      layer: 'account',
      values: { 'x-collect-log': 'true' },
      inherited: { 'x-collect-log': 'false', 'x-skip-cache': 'true' },
      hints: { 'x-collect-log': 'False keeps logs off.' },
      onChange: () => undefined,
    });
    // A layer with its own entries opens at once and names the layer that holds them.
    expect(editor.text()).toContain('Set for every machine · 1 changed');
    expect(editor.input('x-collect-log')?.value).toBe('true');
    expect(editor.row('x-collect-log')).toContain('Set for every machine · False keeps logs off.');
    expect(editor.input('x-skip-cache')?.value).toBe('true');
    expect(editor.row('x-skip-cache')).toContain('From the provider');
    editor.view.unmount();
  });

  it('stays folded on inherited values and draws nothing when the endpoint has no headers', () => {
    const folded = mount({ layer: 'machine', values: null, inherited: { 'x-skip-cache': 'true' }, onChange: () => undefined });
    expect(folded.text()).toContain('Same as every machine');
    expect(folded.input('x-skip-cache')).toBeNull();
    folded.view.unmount();
    const empty = mount({ layer: 'account', values: null, inherited: {}, onChange: () => undefined });
    expect(empty.text()).toBe('');
    empty.view.unmount();
  });

  it('patches only its own layer: an inherited value typed back drops that entry, a new one is added, Reset removes the layer', async () => {
    const onChange = vi.fn();
    const editor = mount({
      layer: 'machine',
      values: { 'x-skip-cache': 'false' },
      inherited: { 'x-collect-log': 'true', 'x-skip-cache': 'true' },
      onChange,
    });
    await editor.commit('x-collect-log', 'false');
    expect(onChange).toHaveBeenLastCalledWith({ 'x-skip-cache': 'false', 'x-collect-log': 'false' });
    await editor.commit('x-skip-cache', ' true ');
    expect(onChange).toHaveBeenLastCalledWith(null);
    const reset = editor.view.container.querySelector<HTMLElement>('[data-testid="ep.headers.reset"]')!;
    await act(async () => { reset.click(); });
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(onChange).toHaveBeenCalledTimes(3);
    editor.view.unmount();
  });

  it('asks for a required header nothing supplies and opens on it', async () => {
    const onChange = vi.fn();
    const editor = mount({ layer: 'draft', values: null, inherited: { 'x-collect-log': 'false' }, required: ['x-gateway-id'], onChange });
    expect(editor.text()).toContain('Needs x-gateway-id');
    expect(editor.row('x-gateway-id')).toContain('Required');
    expect(editor.input('x-gateway-id')?.value).toBe('');
    await editor.commit('x-gateway-id', 'my-gateway');
    expect(onChange).toHaveBeenLastCalledWith({ 'x-gateway-id': 'my-gateway' });
    editor.view.unmount();
  });
});

describe('EndpointHeadersEditor disclosure caret', () => {
  it('ends the folded row on the host\'s own caret and turns it with the open state', async () => {
    const host: PluginUiPresentationHost = {
      renderMarkdown: () => null,
      renderCodeBlock: () => null,
      renderPopover: () => null,
      renderIcon: () => null,
      renderDisclosureCaret: ({ expanded }) => <i data-testid="host-caret" data-expanded={String(expanded)} />,
    };
    const context = createSurfaceContext();
    const view = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <PluginUiPresentationHostProviderInternal host={host}>
          <HappierUiPaletteProvider palette={PALETTE}>
            <EndpointHeadersEditor testID="ep" copy={copy('account')} layer="account" values={null} inherited={{ 'x-skip-cache': 'true' }} onChange={() => undefined} />
          </HappierUiPaletteProvider>
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>,
    );
    const caret = () => view.container.querySelector('[data-testid="host-caret"]')?.getAttribute('data-expanded');
    expect(caret()).toBe('false');
    await act(async () => { view.container.querySelector<HTMLElement>('[data-testid="ep.headers.header"]')!.click(); });
    expect(caret()).toBe('true');
    view.unmount();
  });
});

describe('EndpointHeadersEditor for an external author', () => {
  it('keeps the author\'s header layer controlled: an edit reaches the author and the editor shows it', async () => {
    const { EndpointHeadersEditorExample } = await import('../../fixtures/external-authoring/src/endpointHeadersEditorSurface.js');
    const context = createSurfaceContext();
    const view = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <HappierUiPaletteProvider palette={PALETTE}><EndpointHeadersEditorExample /></HappierUiPaletteProvider>
      </PluginUiProvider>,
    );
    const layer = () => view.container.querySelector('[data-testid="author-headers-layer"]')?.textContent ?? '';
    expect(layer()).toContain('x-cache-ttl=600');
    const reset = view.container.querySelector<HTMLElement>('[data-testid="author-headers.headers.reset"]')!;
    await act(async () => { reset.click(); });
    expect(layer()).toContain('inherits every value');
    view.unmount();
  });
});
