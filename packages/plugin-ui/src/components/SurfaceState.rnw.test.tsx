import type { ReactNode } from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import {
  createHostApiStub,
  createSurfaceContext,
} from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { ErrorState, SurfaceState } from './index.js';

function mountSurface(children: ReactNode) {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      {children}
    </PluginUiProvider>,
  );
}

function textOf(container: HTMLElement): string {
  return container.textContent ?? '';
}

/**
 * The full state composition Happier's own panes use (`SurfaceStateCard`), reachable by authors: copy,
 * the present, a domain summary, the one recovery and a quiet second way, a note, and the collapsed
 * diagnostic, in that reading order.
 */
describe('SurfaceState: the shared full state composition', () => {
  it('runs the one recovery and keeps reading order: copy, live, body, actions, note, details', async () => {
    let retried = 0;
    let browsed = 0;
    const mount = mountSurface(
      <SurfaceState
        testID="sync"
        kind="error"
        size="pane"
        title="Sync failed"
        description="The repository could not be read."
        live={{ text: 'Next try in 8 s' }}
        body={<span>main · 3 commits behind</span>}
        action={{
          label: 'Retry',
          onPress: () => {
            retried += 1;
          },
        }}
        secondaryAction={{
          label: 'Open settings',
          onPress: () => {
            browsed += 1;
          },
        }}
        note="Nothing is lost."
        details="E_REPO_READ"
      />,
    );
    const text = textOf(mount.container);
    const order = [
      'Sync failed',
      'The repository could not be read.',
      'Next try in 8 s',
      'main · 3 commits behind',
      'Retry',
      'Open settings',
      'Nothing is lost.',
    ].map((part) => text.indexOf(part));
    expect(
      order.every((index) => index >= 0),
      text,
    ).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The machine code stays behind the collapsed disclosure.
    expect(text).not.toContain('E_REPO_READ');

    const retry = mount.container.querySelector<HTMLElement>(
      '[data-testid="sync-action"]',
    );
    expect(retry?.getAttribute('role')).toBe('button');
    await act(async () => {
      retry?.click();
    });
    expect(retried).toBe(1);
    await act(async () => {
      mount.container
        .querySelector<HTMLElement>('[data-testid="sync-secondary-action"]')
        ?.click();
    });
    expect(browsed).toBe(1);

    await act(async () => {
      mount.container
        .querySelector<HTMLElement>('[data-testid="sync-details-toggle"]')
        ?.click();
    });
    expect(textOf(mount.container)).toContain('E_REPO_READ');
    mount.unmount();
  });

  it('draws a line state as one sentence with an inline recovery that cannot run while unavailable', async () => {
    let retried = 0;
    const mount = mountSurface(
      <SurfaceState
        testID="row"
        kind="error"
        size="line"
        title="Couldn't load members"
        description="Offline"
        details="E_MACHINE_UNREACHABLE"
        body={<span>never in a line</span>}
        action={{
          label: 'Retry',
          disabled: true,
          onPress: () => {
            retried += 1;
          },
        }}
      />,
    );
    expect(textOf(mount.container)).toContain(
      "Couldn't load members · Offline",
    );
    expect(textOf(mount.container)).not.toContain('never in a line');
    const retry = mount.container.querySelector<HTMLElement>(
      '[data-testid="row-action"]',
    );
    expect(retry?.getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      retry?.click();
    });
    expect(retried).toBe(0);
    // One row (owner 11-06): a failure line keeps its code one press away, Details beside Retry on the
    // trailing edge, opening the code on the next line; closed, the code is never read or in the tree.
    expect(mount.container.innerHTML).not.toContain('E_MACHINE_UNREACHABLE');
    const toggle = mount.container.querySelector<HTMLElement>('[data-testid="row-details-toggle"]');
    expect(toggle).not.toBeNull();
    // Beside Retry, before it, inside the same line.
    expect(mount.container.querySelector('[data-testid="row"]')!.contains(toggle)).toBe(true);
    expect(toggle!.compareDocumentPosition(retry!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => {
      toggle!.click();
    });
    expect(mount.container.querySelector('[data-testid="row-details-code"]')?.textContent).toBe('E_MACHINE_UNREACHABLE');
    mount.unmount();
  });

  it('gives ErrorState a Retry affordance with a host-localized default label', async () => {
    let retried = 0;
    const mount = mountSurface(
      <ErrorState
        testID="failed"
        title="Couldn't load"
        onRetry={() => {
          retried += 1;
        }}
      />,
    );
    const retry = mount.container.querySelector<HTMLElement>(
      '[data-testid="failed-action"]',
    );
    expect(retry?.textContent).toBe('Retry');
    await act(async () => {
      retry?.click();
    });
    expect(retried).toBe(1);
    mount.unmount();
  });
});
