import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoordinationMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { MemoryDocBodyV1Schema } from '@happier-dev/protocol/prompts/library/memoryDocV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMemoryDecisionHomeFixture } from '@/dev/testkit/harness/memoryDecisionHomeFixture';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installDisconnectedServerSocketBoundary();

const viewport = vi.hoisted(() => ({ width: 1440 }));
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'ios' }, {
    useWindowDimensions: () => ({ width: viewport.width, height: 900, scale: 1, fontScale: 1 }),
    Dimensions: { get: () => ({ width: viewport.width, height: 900, scale: 1, fontScale: 1 }) },
  });
});
// Safe-area measurements come from the device SDK; the overlay policy stays real.
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 34, left: 0 }),
  initialWindowMetrics: null,
}));

const { SaveMemoryDecisionSheet } = await import('./SaveMemoryDecisionSheet');
const { seedMemoryDecisionFromMessage } = await import('./memoryDecisionSeed');
afterEach(() => { standardCleanup(); viewport.width = 1440; });

async function open() {
  const f = await createMemoryDecisionHomeFixture();
  const source: CoordinationMessageRefV1 = { kind: 'discussion',
    discussion: { serverId: f.serverId, discussionId: 'discussion-1' }, messageId: 'committed-source' };
  const screen = await renderScreen(<SaveMemoryDecisionSheet seed={seedMemoryDecisionFromMessage(source, 'Keep the cap at 5')}
    anchorRef={{ current: null }} onClose={() => {}} onSaved={() => {}} />);
  return { f, screen };
}

describe('Save as decision presentation', () => {
  it('is the shared phone sheet on a phone-width window, with the form carrying its own header', async () => {
    viewport.width = 390;
    const { f, screen } = await open();
    try {
      const dialog = screen.findAll(node => node.props.role === 'dialog')[0];
      expect(dialog?.props.accessibilityLabel).toBeTruthy();
      expect(screen.findByTestId('save-memory-decision')).toBeTruthy();
    } finally { await screen.unmount(); await f.home.dispose(); }
  });

  it('stays the anchored panel on a wide window', async () => {
    const { f, screen } = await open();
    try {
      expect(screen.findAll(node => node.props.role === 'dialog')).toHaveLength(0);
      expect(screen.findByTestId('save-memory-decision')).toBeTruthy();
    } finally { await screen.unmount(); await f.home.dispose(); }
  });

  it('keeps the edited Project decision and duplicate choice across phone and panel presentations', async () => {
    const f = await createMemoryDecisionHomeFixture();
    f.recover();
    const { memoryDocumentActions, readMemoryCreationReceipt } = await import('@/sync/ops/promptLibrary/memoryDocuments');
    const target = { scope: 'project' as const, projectRef: { serverId: f.serverId, projectKey: 'payments' } };
    const initial = await memoryDocumentActions.rememberInScope(target, { text: 'Retry cap stays at 5' }, f.serverId);
    const receipt = readMemoryCreationReceipt(initial);
    if (!receipt) throw new Error('Missing existing Project memory');
    const before = MemoryDocBodyV1Schema.parse(JSON.parse(f.home.boundary.readPlainBody(receipt.ref.artifactId)!));
    const source: CoordinationMessageRefV1 = { kind: 'discussion',
      discussion: { serverId: f.serverId, discussionId: 'discussion-1' }, messageId: 'committed-source' };
    const seed = seedMemoryDecisionFromMessage(source, 'Initial decision\nInitial reason');
    const onSaved = vi.fn();
    const anchorRef = { current: null };
    const sheet = () => <SaveMemoryDecisionSheet seed={seed} anchorRef={anchorRef} onClose={() => {}} onSaved={onSaved} />;
    const screen = await renderScreen(sheet());
    const projectId = `save-memory-decision.target:project:${f.serverId}:payments`;
    const text = 'Retry cap stays at 5 with bounded backoff';
    const reason = 'Retries must leave time for the next attempt.';
    try {
      await vi.waitFor(() => expect(screen.findByTestId(projectId)).toBeTruthy());
      await screen.pressByTestIdAsync(projectId);
      await act(async () => {
        screen.changeTextByTestId('save-memory-decision.text', text);
        screen.changeTextByTestId('save-memory-decision.reason', reason);
      });
      const save = async () => {
        const button = screen.find(node => node.props.testID === 'save-memory-decision.save' && typeof node.props.action === 'function');
        await act(async () => { await button.props.action(); });
      };
      await save();
      expect(screen.findHostByTestId('save-memory-decision.duplicate')).toBeTruthy();
      await screen.pressByTestIdAsync('save-memory-decision.duplicate.choice:keep_both');
      expect(onSaved).not.toHaveBeenCalled();
      expect(f.home.boundary.readPlainBody(receipt.ref.artifactId)).toBe(JSON.stringify(before));

      for (const width of [390, 1440]) {
        viewport.width = width;
        await screen.update(sheet());
        expect(screen.findAll(node => node.props.role === 'dialog').length > 0).toBe(width === 390);
        expect(screen.findByTestId('save-memory-decision.text')?.props.value).toBe(text);
        expect(screen.findByTestId('save-memory-decision.reason')?.props.value).toBe(reason);
        expect(screen.findByTestId(projectId)?.props['aria-checked']).toBe(true);
        expect(screen.findHostByTestId('save-memory-decision.duplicate')).toBeTruthy();
        expect(screen.findHostByTestId(`save-memory-decision.duplicate.candidate.${before.index[0]!.id}`)).toBeTruthy();
        expect(screen.findByTestId('save-memory-decision.duplicate.choice:keep_both')?.props['aria-checked']).toBe(true);
      }

      await save();
      expect(onSaved).toHaveBeenCalledTimes(1);
      const after = MemoryDocBodyV1Schema.parse(JSON.parse(f.home.boundary.readPlainBody(receipt.ref.artifactId)!));
      expect(after.index).toHaveLength(2);
      expect(after.index).toContainEqual(before.index[0]);
      expect(after.index).toContainEqual(expect.objectContaining({ text, decision: expect.objectContaining({ reason, sourceMessageRef: source }) }));
      expect(f.home.boundary.list()).toHaveLength(1);
    } finally { await screen.unmount(); await f.home.dispose(); }
  });
});
