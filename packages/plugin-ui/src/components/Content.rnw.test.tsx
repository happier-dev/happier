import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { CodeBlock, DiffViewer, Markdown } from './index.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import {
  PluginUiPresentationHostProviderInternal,
  type PluginUiPresentationHost,
} from '../presentationHost/context.js';

describe('bounded Markdown and Code presentation', () => {
  it('degrades safely to selectable literal content when no host renderer is installed', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <Markdown value={'**Review**\n<script>alert(1)</script>'} />
      </PluginUiProvider>,
    );

    expect(mount.container.querySelector('script')).toBeNull();
    expect(mount.container.textContent).toContain('<script>alert(1)</script>');
    mount.unmount();
  });

  it('renders code through bounded horizontal scroll and delegates copy to the host', async () => {
    const writeClipboard = vi.fn(async () => undefined);
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context, { writeClipboard })} context={context}>
        <CodeBlock code={'const ready = true;'} language="ts" copyLabel="Copy code" copiedLabel="Copied" />
      </PluginUiProvider>,
    );

    expect(mount.container.textContent).toContain('const ready = true;');
    const copy = [...mount.container.querySelectorAll<HTMLElement>('[role="button"]')]
      .find((node) => node.textContent === 'Copy code');
    await act(async () => { copy?.click(); });
    expect(writeClipboard).toHaveBeenCalledWith('const ready = true;');
    expect(mount.container.textContent).toContain('Copied');
    mount.unmount();
  });

  it('does not arm a copied-state timer after its clipboard request outlives the surface', async () => {
    vi.useFakeTimers();
    let settleCopy: (() => void) | undefined;
    const writeClipboard = vi.fn(() => new Promise<void>((resolve) => { settleCopy = resolve; }));
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context, { writeClipboard })} context={context}>
        <CodeBlock code="const ready = true;" copyLabel="Copy code" copiedLabel="Copied" />
      </PluginUiProvider>,
    );

    try {
      const copy = [...mount.container.querySelectorAll<HTMLElement>('[role="button"]')]
        .find((node) => node.textContent === 'Copy code');
      await act(async () => { copy?.click(); });
      expect(writeClipboard).toHaveBeenCalledWith('const ready = true;');

      mount.unmount();
      await act(async () => {
        settleCopy?.();
        await Promise.resolve();
      });

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('read-only DiffViewer presentation', () => {
  const unifiedDiff = [
    'diff --git a/src/provider.ts b/src/provider.ts',
    '--- a/src/provider.ts',
    '+++ b/src/provider.ts',
    '@@ -1 +1 @@',
    '-const ready = false;',
    '+const ready = true;',
  ].join('\n');

  it('keeps a selectable literal fallback when no product renderer is mounted', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <DiffViewer
          unifiedDiff={unifiedDiff}
          filePath="src/provider.ts"
          label="Changes in src/provider.ts"
        />
      </PluginUiProvider>,
    );

    expect(mount.container.textContent).toContain('Changes in src/provider.ts');
    expect(mount.container.textContent).toContain('+const ready = true;');
    mount.unmount();
  });

  it('delegates the bounded diff request to the incumbent product renderer', () => {
    const renderDiffViewer = vi.fn(() => <span data-testid="host-diff">rendered diff</span>);
    const host = {
      renderMarkdown: () => null,
      renderCodeBlock: () => null,
      renderDiffViewer,
      renderPopover: () => null,
      renderIcon: () => null,
    } as unknown as PluginUiPresentationHost;
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <PluginUiPresentationHostProviderInternal host={host}>
          <DiffViewer
            unifiedDiff={unifiedDiff}
            filePath="src/provider.ts"
            label="Changes in src/provider.ts"
            testID="provider-diff"
          />
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>,
    );

    expect(renderDiffViewer).toHaveBeenCalledWith({
      unifiedDiff,
      filePath: 'src/provider.ts',
      testID: 'provider-diff',
    });
    expect(mount.container.textContent).toContain('Changes in src/provider.ts');
    expect(mount.container.querySelector('[data-testid="host-diff"]')).not.toBeNull();
    mount.unmount();
  });
});
