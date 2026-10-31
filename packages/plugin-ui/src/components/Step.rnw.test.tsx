import { describe, expect, it, onTestFinished } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { Step, Text } from './index.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { HappierStep } from '../presentation/content/Step.js';

function mountStep(element: React.ReactElement, context = createSurfaceContext()) {
  const mount = mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      {element}
    </PluginUiProvider>,
  );
  onTestFinished(() => mount.unmount());
  return mount;
}

function marker(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('[data-testid="step:marker"]');
  if (found === null) throw new Error('no marker');
  return found;
}

describe('Step', () => {
  it('renders core numbered steps with the explicit theme outside a plugin provider', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <HappierStep marker={{ kind: 'number', value: 2 }} title="Connect this computer"
        theme={context.theme} testID="step" />,
    );
    onTestFinished(() => mount.unmount());
    expect(marker(mount.container).textContent).toBe('2');
    expect(mount.container.querySelector('[role="heading"]')?.textContent).toBe('Connect this computer');
  });

  it('numbers a story step on a visible fill, and names it with its title', () => {
    const context = createSurfaceContext();
    const mount = mountStep(
      <Step marker={{ kind: 'number', value: 2 }} title="What changed" testID="step">
        <Text value="src/cart/totals.ts" />
      </Step>,
      context,
    );

    expect(marker(mount.container).textContent).toBe('2');
    // A marker on the page colour disappears in dark mode; it sits on the
    // raised control fill in every theme.
    expect(getComputedStyle(marker(mount.container)).backgroundColor)
      .not.toBe('rgba(0, 0, 0, 0)');
    expect(mount.container.querySelector('[role="heading"]')?.textContent).toBe('What changed');
    expect(mount.container.textContent).toContain('src/cart/totals.ts');
  });

  it('maps a checks state to its glyph and says it in the author\'s words', () => {
    const passed = mountStep(<Step marker={{ kind: 'state', state: 'passed', label: 'Passed' }} title="Checks" testID="step" />);
    expect(marker(passed.container).getAttribute('aria-label')).toBe('Passed');

    const failed = mountStep(<Step marker={{ kind: 'state', state: 'failed', label: '2 failing' }} title="Checks" testID="step" />);
    expect(marker(failed.container).getAttribute('aria-label')).toBe('2 failing');

    const running = mountStep(<Step marker={{ kind: 'state', state: 'running', label: 'Running' }} title="Checks" testID="step" />);
    expect(marker(running.container).getAttribute('aria-label')).toBe('Running');
    expect(running.container.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  it('places trailing content beside the title', () => {
    const mount = mountStep(
      <Step marker={{ kind: 'number', value: 1 }} title="The ask" trailing={<Text value="3h ago" />} testID="step" />,
    );
    expect(mount.container.textContent).toContain('3h ago');
  });
});
