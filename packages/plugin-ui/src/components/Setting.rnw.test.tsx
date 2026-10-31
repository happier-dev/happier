import type { ReactNode } from 'react';
import { act } from 'react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { SettingRow, SettingStatusLine, SettingValueSlot, Toggle } from './index.js';

function mountSurface(children: ReactNode) {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>{children}</PluginUiProvider>,
  );
}

/** The settings row anatomy Happier draws for its own registries, reachable on a custom author page. */
describe('SettingRow, SettingValueSlot and SettingStatusLine', () => {
  it('draws the label, hint and one control, with a unit beside a number', () => {
    const onChange = vi.fn();
    const mount = mountSurface(
      <SettingRow
        testID="timeout"
        title="Request timeout"
        hint="How long a request may wait."
        layout="adaptive"
        control={<SettingValueSlot kind="number" unit="ms"><Toggle label="On" value onChange={onChange} /></SettingValueSlot>}
      />,
    );
    onTestFinished(() => mount.unmount());
    const row = mount.container.querySelector('[data-testid="timeout"]');
    expect(row?.textContent).toContain('Request timeout');
    expect(row?.textContent).toContain('How long a request may wait.');
    expect(row?.textContent).toContain('ms');
    expect(row?.querySelectorAll('[role="switch"]')).toHaveLength(1);
    const toggle = row?.querySelector<HTMLElement>('[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('true');
    act(() => { toggle?.click(); });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('announces a refused change and keeps a stored-value line static', () => {
    const refused = mountSurface(<SettingStatusLine testID="status" tone="danger">That address is not valid.</SettingStatusLine>);
    const line = refused.container.querySelector('[data-testid="status"]');
    expect(line?.getAttribute('role')).toBe('alert');
    expect(line?.textContent).toBe('That address is not valid.');
    refused.unmount();
    const stored = mountSurface(<SettingStatusLine testID="status">Saved for everyone on this Home.</SettingStatusLine>);
    expect(stored.container.querySelector('[data-testid="status"]')?.getAttribute('role')).toBeNull();
    stored.unmount();
  });
});
