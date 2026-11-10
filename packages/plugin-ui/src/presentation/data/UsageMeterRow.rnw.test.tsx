import { expect, it } from 'vitest';
import { UsageMeterSurface } from '../../../fixtures/external-authoring/src/usageMeterSurface.js';
import { HappierUiEnvironmentProvider, projectHappierUiEnvironment } from '../../environment/index.public.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createSurfaceContextFixture } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';

it('lets a public author render percent, unknown, zero and uncapped units with reset/accessibility facts', () => {
  const mount = mountThroughReactNativeWeb(<HappierUiEnvironmentProvider environment={projectHappierUiEnvironment(createSurfaceContextFixture())}><UsageMeterSurface /></HappierUiEnvironmentProvider>);
  const row = (name: string) => mount.container.querySelector(`[data-testid="meter-${name}"]`)!;
  try {
    expect(row('Weekly').textContent).toContain('~42% left');
    expect(row('Weekly').textContent).toContain('in 2h');
    expect(row('Weekly').getAttribute('aria-label')).toContain('approximately 42% left');
    expect(row('Unknown').textContent).toContain('Unavailable');
    expect(row('Unknown').getAttribute('aria-label')).toContain('resets in 1h');
    expect(row('Unknown cost').textContent).toContain('Unavailable');
    expect(row('Unknown cost').querySelector('[data-testid="meter-Unknown cost:bar"]')).toBeNull();
    expect(row('Unknown cost').getAttribute('aria-label')).toContain('unavailable');
    expect(row('Exhausted').textContent).toContain('0% left');
    expect(row('Exhausted').querySelector('[data-testid="meter-Exhausted:bar"]')).not.toBeNull();
    for (const [name, amount] of [['Cost', '$1.25'], ['Requests', '320 requests'], ['Zero cost', '$0.00']]) {
      expect(row(name).textContent).toContain(amount);
      expect(row(name).querySelector(`[data-testid="meter-${name}:bar"]`)).toBeNull();
      expect(row(name).getAttribute('aria-label')).toContain(amount);
    }
  } finally { mount.unmount(); }
});
