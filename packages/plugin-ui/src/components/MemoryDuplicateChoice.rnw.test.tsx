import { act, useState } from 'react';
import { Text as NativeText, View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import * as publicComponents from '@happier-dev/plugin-ui/components';

import { MemoryDuplicateChoiceExample } from '../../fixtures/external-authoring/src/memoryDuplicateChoiceSurface.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { resetHappierPrimaryPointerForTesting } from '../environment/interactiveTarget.js';
import { readHitAreaReach } from '../presentation/interaction/hitArea.testSupport.js';

const byId = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('external author memory duplicate choice', () => {
  it('compares saved and new facts, reports the chosen effect and fact, and strikes what Replace retires', () => {
    expect(typeof publicComponents.MemoryDuplicateChoice).toBe('function');
    expect(typeof publicComponents.HappierMemoryDuplicateChoice).toBe('function');
    const onSave = vi.fn();
    const context = createSurfaceContext();
    const mounted = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <MemoryDuplicateChoiceExample onSave={onSave} />
    </PluginUiProvider>);
    try {
      const card = byId(mounted.container, 'author-duplicate')!;
      expect(card.textContent).toContain('This memory already has 2 similar facts');
      expect(byId(mounted.container, 'author-duplicate.new')!.textContent).toBe('Retry payment webhooks 5 times during deploys');
      expect(byId(mounted.container, 'author-duplicate.effect')!.textContent).toBe('Corrects the saved fact. Its source and approval stay.');
      // Several saved facts: the effect applies to the chosen one, the closest by default.
      const first = byId(mounted.container, 'author-duplicate.candidate.saved-retry')!;
      const second = byId(mounted.container, 'author-duplicate.candidate.saved-backoff')!;
      expect(first.getAttribute('role')).toBe('radio');
      expect(first.getAttribute('aria-checked')).toBe('true');
      act(() => second.click());
      expect(second.getAttribute('aria-checked')).toBe('true');

      act(() => byId(mounted.container, 'author-duplicate.choice:replace')!.click());
      expect(byId(mounted.container, 'author-duplicate.effect')!.textContent).toBe('The saved fact moves to history. Agents only see the new one.');

      act(() => [...mounted.container.querySelectorAll<HTMLElement>('[role="button"]')].find((node) => node.textContent === 'Save')!.click());
      expect(onSave).toHaveBeenCalledWith({ kind: 'replace', factId: 'saved-backoff' });

      // Keep both touches no saved fact, so there is nothing to pick.
      act(() => byId(mounted.container, 'author-duplicate.choice:keep_both')!.click());
      expect(byId(mounted.container, 'author-duplicate.candidate.saved-retry')!.getAttribute('role')).toBeNull();
      act(() => [...mounted.container.querySelectorAll<HTMLElement>('[role="button"]')].find((node) => node.textContent === 'Save')!.click());
      expect(onSave).toHaveBeenLastCalledWith({ kind: 'keep_both', factId: null });
    } finally { mounted.unmount(); }
  });

  it('offers the caller’s own view of each saved fact without changing the chosen fact or effect', () => {
    const onView = vi.fn();
    const context = createSurfaceContext();
    const mounted = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <MemoryDuplicateChoiceExample onView={onView} />
    </PluginUiProvider>);
    try {
      act(() => byId(mounted.container, 'author-duplicate.choice:replace')!.click());
      const view = byId(mounted.container, 'author-duplicate.candidate.saved-backoff.view')!;
      expect(view.getAttribute('role')).toBe('button');
      expect(view.textContent).toBe('View');
      act(() => view.click());
      expect(onView).toHaveBeenCalledWith('saved-backoff');
      // Viewing is not choosing: the closest fact stays chosen and the effect is unchanged.
      expect(byId(mounted.container, 'author-duplicate.candidate.saved-retry')!.getAttribute('aria-checked')).toBe('true');
      expect(byId(mounted.container, 'author-duplicate.effect')!.textContent).toBe('The saved fact moves to history. Agents only see the new one.');
    } finally { mounted.unmount(); }
  });

  it('lets a finger reach the small View action through the shared hit area (web ignores a raw hitSlop)', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' || query === '(hover: none)' }));
    resetHappierPrimaryPointerForTesting();
    const context = createSurfaceContext();
    const mounted = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <MemoryDuplicateChoiceExample onView={() => {}} />
    </PluginUiProvider>);
    try {
      const view = byId(mounted.container, 'author-duplicate.candidate.saved-backoff.view')!;
      const handler = Reflect.get(view, '__reactLayoutHandler');
      if (typeof handler === 'function') act(() => handler({ nativeEvent: { layout: { x: 0, y: 0, width: 32, height: 16 } } }));
      // Nested in the selectable row: the reach is the row's own gaps (half the 2 px body gap above), not the finger target.
      expect(readHitAreaReach(view)).toMatchObject({ top: 1, bottom: 4, left: 4, right: 4 });
    } finally {
      mounted.unmount();
      vi.unstubAllGlobals();
      resetHappierPrimaryPointerForTesting();
    }
  });

  it('draws no view control when the caller has none', () => {
    const context = createSurfaceContext();
    const mounted = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <MemoryDuplicateChoiceExample />
    </PluginUiProvider>);
    try {
      expect(byId(mounted.container, 'author-duplicate.candidate.saved-retry.view')).toBeNull();
    } finally { mounted.unmount(); }
  });

  it('retires only the chosen saved fact under Replace, through the caller’s own text leaf', () => {
    function Harness() {
      const [choice, setChoice] = useState<publicComponents.HappierMemoryDuplicateChoiceKind>('update');
      const [candidateId, setCandidateId] = useState<string | null>(null);
      return <publicComponents.HappierMemoryDuplicateChoice testID="core" newText="B" choice={choice} onChoiceChange={setChoice}
        candidateId={candidateId} onCandidateChange={setCandidateId} radius={6} colors={{ chosen: 'gray', hover: 'silver' }}
        candidates={[{ id: 'a', text: 'A' }, { id: 'c', text: 'C' }]}
        labels={{ title: 'T', saved: 'Saved', new: 'New', choice: 'Choice',
          options: { update: 'U', replace: 'R', keep_both: 'K' }, effects: { update: 'eu', replace: 'er', keep_both: 'ek' } }}
        Text={(props) => <NativeText testID={props.testID} accessibilityLabel={props.retired ? 'retired' : undefined}>{props.children}</NativeText>}
        Choice={(props) => <View>{props.options.map((option) => <NativeText key={option.id} testID={`${props.testIDPrefix}:${option.id}`}
          onPress={() => props.onChange(option.id)}>{option.label}</NativeText>)}</View>} />;
    }
    const mounted = mountThroughReactNativeWeb(<Harness />);
    try {
      const retired = () => [...mounted.container.querySelectorAll('[aria-label="retired"]')].map((node) => node.getAttribute('data-testid'));
      expect(retired()).toEqual([]);
      act(() => byId(mounted.container, 'core.candidate.c')!.click());
      act(() => byId(mounted.container, 'core.choice:replace')!.click());
      expect(retired()).toEqual(['core.candidate.c.text']);
      expect(byId(mounted.container, 'core.effect')!.textContent).toBe('er');
    } finally { mounted.unmount(); }
  });
});
