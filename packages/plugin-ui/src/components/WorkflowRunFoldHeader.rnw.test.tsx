import { act, useState, type ComponentType } from 'react';
import { describe, expect, it } from 'vitest';

import * as PluginUi from '@happier-dev/plugin-ui/components';
import { PluginUiProviderInternal } from './PluginUiProvider.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';

describe('public Workflow Run band', () => {
  it('keeps disclosure, exact Run navigation and controls independent on the public surface', async () => {
    const Band = (PluginUi as typeof PluginUi & {
      WorkflowRunFoldHeader?: ComponentType<{
        runId: string;
        presentation: { verb: string; details: readonly string[]; meta: string | null };
        disclosure: { expanded: boolean; headerProps: { onPress(): void; accessibilityRole: 'button'; accessibilityState: { expanded: boolean } } } | null;
        onOpen: (() => void) | null;
        openLabel: string;
      }>;
    }).WorkflowRunFoldHeader;
    const context = createSurfaceContext();
    let opened: string | null = null;
    function Surface() {
      const [expanded, setExpanded] = useState(false);
      return <PluginUiProviderInternal context={context} hostApi={createHostApiStub(context)}>
        {Band ? <Band runId="run-a" presentation={{ verb: 'Review', details: ['Running'], meta: null }}
          disclosure={{ expanded, headerProps: { onPress: () => setExpanded(value => !value), accessibilityRole: 'button', accessibilityState: { expanded } } }}
          onOpen={() => { opened = 'run-a'; }} openLabel="Open" /> : null}
      </PluginUiProviderInternal>;
    }
    const view = mountThroughReactNativeWeb(<Surface />);
    try {
      const toggle = () => view.container.querySelector<HTMLElement>('[data-testid="workflow-run-fold-toggle:run-a"]');
      const open = () => view.container.querySelector<HTMLElement>('[data-testid="workflow-run-fold-open:run-a"]');
      expect(toggle(), 'the public Run presentation must render').not.toBeNull();
      expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
      act(() => open()!.click());
      expect(opened).toBe('run-a');
      expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
      act(() => toggle()!.click());
      expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
      expect(opened).toBe('run-a');
    } finally { view.unmount(); }
  });
});
