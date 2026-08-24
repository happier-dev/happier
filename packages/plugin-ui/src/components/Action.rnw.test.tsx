import type { ActionContract } from '@happier-dev/plugin-sdk/actions';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginUiHostApi, SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { Action, ActionPanel } from './Action.js';
import { useExecutePluginAction } from '../hostApi/executeAction.js';
import { PluginUiProvider } from './PluginUiProvider.js';

declare const updateReview: ActionContract;
declare const completeReview: ActionContract;

/**
 * EU-7, family `Action` — the §3.10.9.2 "plugin adapters" row.
 *
 * This is the family every deciding author journey ends in: J1 runs a typed
 * action from a status panel, J3 groups per-item actions in an `ActionPanel`,
 * J4's Inspector refreshes and copies. Until it graduates, an author can render
 * a surface but cannot make anything happen from it.
 *
 * RED at 2026-08-07: `Action` was a single inert `happier-plugin-action` custom
 * element carrying a `PluginUiPortableAction` object nothing ever executed, and
 * `ActionPanel`, `ActionPanel.Section` and `useExecutePluginAction` did not
 * exist at all. A surface that declared an action rendered a dead element with
 * no role, no accessible name and no dispatch.
 *
 * §8.2's both-consumers rule explicitly does NOT apply here: these adapters have
 * no Happier core counterpart and must not acquire a fake one. What they must
 * not do is become a SECOND action owner — every branch below asserts the call
 * lands on the canonical `PluginUiHostApi` method, with the author's own
 * reference and input, unparsed and unreinterpreted (§3.5).
 *
 * Supporting evidence only (§7 excludes jsdom from layer 6); the packed browser
 * and device lanes own the gate.
 */
function mountSurface(children: ReactNode, hostApi: PluginUiHostApi, context?: SurfaceContext) {
  const resolved = context ?? createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={hostApi} context={resolved}>
      {children}
    </PluginUiProvider>,
  );
}

/** Uses React's root-level strict-effects probe so cleanup → setup replays are observable in jsdom. */
function mountStrictEffectsSurface(children: ReactNode, hostApi: PluginUiHostApi, context?: SurfaceContext) {
  const resolved = context ?? createSurfaceContext();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container, { unstable_strictMode: true });
  act(() => {
    root.render(
      <PluginUiProvider hostApi={hostApi} context={resolved}>
        {children}
      </PluginUiProvider>,
    );
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function pressableByLabel(container: HTMLElement, label: string): HTMLElement {
  const element = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find((candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent ?? '').includes(label));
  expect(element, `no accessible button carrying "${label}" was rendered`).toBeTruthy();
  return element!;
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('plugin-ui Action family dispatches through the canonical host API', () => {
  it('keeps contributed Action refs on the structural JSON transport contract', () => {
    if (false) {
      const update = useExecutePluginAction(updateReview, { title: 'Rename review' });
      const complete = useExecutePluginAction(completeReview, null);
      expectTypeOf(update.execute).parameter(0).toEqualTypeOf<JsonValue | undefined>();
      if (update.execution.status === 'success') {
        expectTypeOf(update.execution.result).toEqualTypeOf<JsonValue>();
      }
      if (complete.execution.status === 'success') {
        expectTypeOf(complete.execution.result).toEqualTypeOf<JsonValue>();
      }

      const action = (
        <Action.Execute
          action={updateReview}
          input={{ title: 'Rename review' }}
          onSettled={(settled) => {
            if (settled.status === 'success') {
              expectTypeOf(settled.result).toEqualTypeOf<JsonValue>();
            }
          }}
        />
      );
      void action;

      useExecutePluginAction(updateReview, { title: 7 });
      const invalidAction = <Action.Execute action={updateReview} input={{ title: 7 }} />;
      void invalidAction;
    }
  });

  it('renders an ActionPanel as a real named toolbar, never a marker element', () => {
    const mount = mountSurface(
      <ActionPanel title="Review actions" testID="review-actions">
        <ActionPanel.Section title="Findings">
          <Action.Copy value="4 findings" title="Copy summary" />
        </ActionPanel.Section>
      </ActionPanel>,
      createHostApiStub(),
    );

    expect(mount.container.innerHTML).not.toContain('happier-plugin-');
    const toolbar = mount.container.querySelector('[role="toolbar"]');
    expect(toolbar, 'ActionPanel did not render a toolbar role').not.toBeNull();
    expect(toolbar?.getAttribute('aria-label')).toBe('Review actions');
    // The section is a named group inside the toolbar, not a second toolbar:
    // nested toolbars would make a screen reader announce two action contexts.
    expect(mount.container.querySelectorAll('[role="toolbar"]').length).toBe(1);
    const group = mount.container.querySelector('[role="group"]');
    expect(group?.getAttribute('aria-label')).toBe('Findings');

    mount.unmount();
  });

  it('executes the author\'s exact action reference and input through hostApi.executeAction', async () => {
    const executeAction = vi.fn(async () => ({ findings: 4 }));
    const mount = mountSurface(
      <Action.Execute
        action={{ pluginId: 'acme.review', localId: 'refresh' }}
        input={{ scope: 'workspace' }}
        title="Run review"
      />,
      createHostApiStub(createSurfaceContext(), { executeAction } as unknown as Partial<PluginUiHostApi>),
    );

    await press(pressableByLabel(mount.container, 'Run review'));

    expect(executeAction).toHaveBeenCalledTimes(1);
    expect(executeAction.mock.calls[0]?.[0]).toEqual({ pluginId: 'acme.review', localId: 'refresh' });
    expect(executeAction.mock.calls[0]?.[1]).toEqual({ scope: 'workspace' });

    mount.unmount();
  });

  it('preserves an omitted Action input instead of coercing it to null', async () => {
    const executeAction = vi.fn(async () => null);
    const mount = mountSurface(
      <Action.Execute action="review.refresh" title="Refresh review" />,
      createHostApiStub(createSurfaceContext(), { executeAction } as unknown as Partial<PluginUiHostApi>),
    );

    await press(pressableByLabel(mount.container, 'Refresh review'));

    expect(executeAction).toHaveBeenCalledOnce();
    expect(executeAction).toHaveBeenCalledWith('review.refresh');

    mount.unmount();
  });

  it('keeps an explicit null execution override instead of reusing the bound input', async () => {
    const executeAction = vi.fn(async () => null);

    function ExecutionHarness() {
      const { execute } = useExecutePluginAction('review.refresh', { scope: 'bound' });
      return <button type="button" onClick={() => { void execute(null); }}>Clear input</button>;
    }

    const mount = mountSurface(
      <ExecutionHarness />,
      createHostApiStub(createSurfaceContext(), { executeAction } as unknown as Partial<PluginUiHostApi>),
    );
    const trigger = mount.container.querySelector<HTMLButtonElement>('button');

    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });

    expect(executeAction).toHaveBeenCalledWith('review.refresh', null);
    mount.unmount();
  });

  it('announces the pending action as busy and refuses a second press until it settles', async () => {
    let settle: (() => void) | undefined;
    const executeAction = vi.fn(() => new Promise((resolve) => {
      settle = () => resolve(null);
    }));
    const mount = mountSurface(
      <Action.Execute action="review.refresh" title="Run review" />,
      createHostApiStub(createSurfaceContext(), { executeAction } as unknown as Partial<PluginUiHostApi>),
    );

    const button = pressableByLabel(mount.container, 'Run review');
    await press(button);
    expect(pressableByLabel(mount.container, 'Run review').getAttribute('aria-busy')).toBe('true');

    // A second press while the first is in flight must not dispatch again: a
    // mutation executed twice because the user pressed twice is exactly what
    // §2's no-blind-retry rule exists to prevent.
    await press(pressableByLabel(mount.container, 'Run review'));
    expect(executeAction).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle?.();
    });
    expect(pressableByLabel(mount.container, 'Run review').getAttribute('aria-busy')).toBeNull();

    mount.unmount();
  });

  it('starts replacement action state fresh and ignores settlement from the replaced action', async () => {
    let settleRefresh: ((value: JsonValue) => void) | undefined;
    const executeAction = vi.fn((action: unknown) => action === 'review.refresh'
      ? new Promise<JsonValue>((resolve) => { settleRefresh = resolve; })
      : Promise.resolve({ completed: true }));

    function ExecutionHarness({ action }: Readonly<{ action: 'review.refresh' | 'review.complete' }>) {
      const { execution, execute } = useExecutePluginAction(action);
      return (
        <>
          <button type="button" onClick={() => { void execute(); }}>Run direct hook</button>
          <output data-testid="action-execution-status">{execution.status}</output>
        </>
      );
    }

    const hostApi = createHostApiStub(
      createSurfaceContext(),
      { executeAction } as unknown as Partial<PluginUiHostApi>,
    );
    const context = createSurfaceContext();
    const mount = mountSurface(<ExecutionHarness action="review.refresh" />, hostApi, context);
    const status = () => mount.container.querySelector('[data-testid="action-execution-status"]')?.textContent;

    await act(async () => { mount.container.querySelector<HTMLButtonElement>('button')?.click(); });
    expect(status()).toBe('pending');

    await mount.render(
      <PluginUiProvider hostApi={hostApi} context={context}>
        <ExecutionHarness action="review.complete" />
      </PluginUiProvider>,
    );
    expect(status()).toBe('idle');

    await act(async () => { settleRefresh?.({ stale: true }); });
    expect(status()).toBe('idle');

    await act(async () => { mount.container.querySelector<HTMLButtonElement>('button')?.click(); });
    expect(executeAction.mock.calls.map(([action]) => action)).toEqual(['review.refresh', 'review.complete']);
    expect(status()).toBe('success');
    mount.unmount();
  });

  it('starts replacement host state fresh and does not cancel the prior host effect', async () => {
    let settleFirst: ((value: JsonValue) => void) | undefined;
    const firstExecute = vi.fn(() => new Promise<JsonValue>((resolve) => { settleFirst = resolve; }));
    const secondExecute = vi.fn(async () => ({ host: 'second' }));
    const context = createSurfaceContext();

    function ExecutionHarness() {
      const { execution, execute } = useExecutePluginAction('review.refresh');
      return (
        <>
          <button type="button" onClick={() => { void execute(); }}>Run direct hook</button>
          <output data-testid="action-execution-status">{execution.status}</output>
        </>
      );
    }

    const firstHost = createHostApiStub(context, { executeAction: firstExecute } as unknown as Partial<PluginUiHostApi>);
    const secondHost = createHostApiStub(context, { executeAction: secondExecute } as unknown as Partial<PluginUiHostApi>);
    const mount = mountSurface(<ExecutionHarness />, firstHost, context);
    const status = () => mount.container.querySelector('[data-testid="action-execution-status"]')?.textContent;

    await act(async () => { mount.container.querySelector<HTMLButtonElement>('button')?.click(); });
    await mount.render(<PluginUiProvider hostApi={secondHost} context={context}><ExecutionHarness /></PluginUiProvider>);
    expect(status()).toBe('idle');
    expect(firstExecute).toHaveBeenCalledOnce();

    await act(async () => { settleFirst?.({ host: 'first' }); });
    expect(status()).toBe('idle');
    await act(async () => { mount.container.querySelector<HTMLButtonElement>('button')?.click(); });
    expect(secondExecute).toHaveBeenCalledOnce();
    expect(status()).toBe('success');
    mount.unmount();
  });

  it('surfaces a failed execution without retrying it', async () => {
    const executeAction = vi.fn(async () => {
      throw Object.assign(new Error('The review service refused.'), { code: 'denied', retryable: false });
    });
    const onSettled = vi.fn();
    const mount = mountSurface(
      <Action.Execute action="review.refresh" title="Run review" onSettled={onSettled} />,
      createHostApiStub(createSurfaceContext(), { executeAction } as unknown as Partial<PluginUiHostApi>),
    );

    await press(pressableByLabel(mount.container, 'Run review'));

    expect(executeAction).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]?.[0]).toMatchObject({ status: 'error', code: 'denied' });

    mount.unmount();
  });

  it('settles success and failure after Strict Mode replays the action hook effect', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    let rejectSecond: ((error: Error) => void) | undefined;
    const executeAction = vi.fn(() => {
      if (executeAction.mock.calls.length === 1) {
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      return new Promise((_resolve, reject) => { rejectSecond = reject; });
    });

    function ExecutionHarness() {
      const { execution, execute } = useExecutePluginAction('review.refresh');
      return (
        <>
          <button type="button" onClick={() => { void execute(); }}>Run direct hook</button>
          <output data-testid="action-execution-status">{execution.status}</output>
        </>
      );
    }

    const mount = mountStrictEffectsSurface(
      <ExecutionHarness />,
      createHostApiStub(createSurfaceContext(), { executeAction } as unknown as Partial<PluginUiHostApi>),
    );
    const trigger = mount.container.querySelector<HTMLButtonElement>('button');
    const status = () => mount.container.querySelector('[data-testid="action-execution-status"]')?.textContent;

    await act(async () => { trigger?.click(); });
    expect(status()).toBe('pending');
    await act(async () => { resolveFirst?.({ completed: true }); });
    expect(status()).toBe('success');

    await act(async () => { trigger?.click(); });
    expect(status()).toBe('pending');
    await act(async () => { rejectSecond?.(Object.assign(new Error('denied'), { code: 'denied' })); });
    expect(status()).toBe('error');
    mount.unmount();
  });

  it('reports a timed-out execution as outcome-unknown rather than a plain failure', async () => {
    // The canonical client rejects a dispatched request with `timeout` (and a
    // post-dispatch cancellation with `aborted`). The request reached the host,
    // so the author must not be told the action definitely failed — that is the
    // reading that produces a duplicated mutation on retry.
    const executeAction = vi.fn(async () => {
      throw Object.assign(new Error('timeout'), { code: 'timeout', retryable: false });
    });
    const onSettled = vi.fn();
    const mount = mountSurface(
      <Action.Execute action="review.refresh" title="Run review" onSettled={onSettled} />,
      createHostApiStub(createSurfaceContext(), { executeAction } as unknown as Partial<PluginUiHostApi>),
    );

    await press(pressableByLabel(mount.container, 'Run review'));

    expect(onSettled.mock.calls[0]?.[0]).toMatchObject({ status: 'outcomeUnknown', code: 'timeout' });

    mount.unmount();
  });

  it('routes copy, external link, surface navigation and refresh to their own host owners', async () => {
    const writeClipboard = vi.fn(async () => undefined);
    const openExternalLink = vi.fn(async () => undefined);
    const openSurface = vi.fn(async () => undefined);
    const onRefresh = vi.fn();
    const mount = mountSurface(
      <ActionPanel title="Row actions">
        <Action.Copy value="sha256:abcd" title="Copy digest" />
        <Action.OpenExternal url="https://happier.dev/docs" title="Open docs" />
        <Action.OpenSurface view={{ pluginId: 'acme.review', localId: 'detail' }} input={{ id: '7' }} title="Open detail" />
        <Action.Refresh onRefresh={onRefresh} title="Refresh" />
      </ActionPanel>,
      createHostApiStub(createSurfaceContext(), {
        writeClipboard,
        openExternalLink,
        openSurface,
      } as unknown as Partial<PluginUiHostApi>),
    );

    await press(pressableByLabel(mount.container, 'Copy digest'));
    await press(pressableByLabel(mount.container, 'Open docs'));
    await press(pressableByLabel(mount.container, 'Open detail'));
    await press(pressableByLabel(mount.container, 'Refresh'));

    expect(writeClipboard).toHaveBeenCalledWith('sha256:abcd');
    expect(openExternalLink).toHaveBeenCalledWith('https://happier.dev/docs');
    expect(openSurface.mock.calls[0]?.[0]).toEqual({ pluginId: 'acme.review', localId: 'detail' });
    expect(openSurface.mock.calls[0]?.[1]).toEqual({ id: '7' });
    expect(onRefresh).toHaveBeenCalledTimes(1);

    mount.unmount();
  });

  it('resolves a declared translation key for the action label and falls back to author text', () => {
    const context = createSurfaceContext({ translations: { 'acme.review.run': 'Lancer la revue' } });
    const mount = mountSurface(
      <ActionPanel titleKey="acme.review.actions" title="Review actions">
        <Action.Execute action="review.refresh" titleKey="acme.review.run" title="Run review" />
        <Action.Execute action="review.clear" titleKey="acme.review.absent" title="Clear findings" />
      </ActionPanel>,
      createHostApiStub(context),
      context,
    );

    expect(mount.container.textContent).toContain('Lancer la revue');
    expect(mount.container.textContent).toContain('Clear findings');
    expect(mount.container.textContent).not.toContain('acme.review.absent');

    mount.unmount();
  });

  it('resolves framework-owned default action labels through the host translation bundle', () => {
    const context = createSurfaceContext({
      translations: {
        'happier.plugin-ui.action.execute': 'Ausführen',
        'happier.plugin-ui.action.copy': 'Kopieren',
        'happier.plugin-ui.action.open': 'Öffnen',
        'happier.plugin-ui.action.refresh': 'Aktualisieren',
      },
    });
    const mount = mountSurface(
      <ActionPanel title="Review actions">
        <Action.Execute action="review.refresh" />
        <Action.Copy value="sha256:abcd" />
        <Action.OpenExternal url="https://happier.dev/docs" />
        <Action.OpenSurface view="review.detail" />
        <Action.Refresh onRefresh={() => undefined} />
      </ActionPanel>,
      createHostApiStub(context),
      context,
    );

    for (const label of ['Ausführen', 'Kopieren', 'Öffnen', 'Aktualisieren']) {
      expect(pressableByLabel(mount.container, label)).toBeTruthy();
    }
    expect([...mount.container.querySelectorAll<HTMLElement>('[role="button"]')]
      .filter((button) => (button.getAttribute('aria-label') ?? button.textContent ?? '').includes('Öffnen')))
      .toHaveLength(2);

    mount.unmount();
  });
});
