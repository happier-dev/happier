import { expect, it } from 'vitest';
import { CapacityBar, CompositionStrip, RankedRows } from '@happier-dev/plugin-ui/presentation';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { SURFACE_CONTEXT_THEME_FIXTURE } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';

it('renders neutral inventory through the public package without Usage inputs', () => {
  const mount = mountThroughReactNativeWeb(<>
    <CapacityBar theme={SURFACE_CONTEXT_THEME_FIXTURE} label="Apples" value={2} capacity={5} basis="crates" />
    <CompositionStrip theme={SURFACE_CONTEXT_THEME_FIXTURE} label="Fruit" total={5} segments={[{ id: 'apples', label: 'Apples', value: 2 }]} />
    <RankedRows theme={SURFACE_CONTEXT_THEME_FIXTURE} label="Stock" rows={[{ id: 'apples', label: 'Apples', value: 2 }]} />
  </>);
  try { expect(mount.container.textContent).toContain('crates'); expect(mount.container.querySelectorAll('[role="listitem"]')).toHaveLength(2); }
  finally { mount.unmount(); }
});
