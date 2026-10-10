import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageRecapComposeResultSchema } from '@happier-dev/protocol';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { ModalProvider } from '@/modal';
import { renderUsageRecapImage } from './renderUsageRecapImage';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
const modal = await vi.hoisted(async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }));
vi.mock('@/modal', () => modal.module);
const capture = vi.hoisted(() => ({ run: vi.fn<() => Promise<void>>(), painted: '' }));
vi.mock('react-native-view-shot/src/RNViewShot.web', () => ({ default: { captureRef: async (node: { accessibilityLabel: string }) => {
  capture.painted = node.accessibilityLabel;
  await capture.run();
  return 'data:image/png;base64,iVBORw==';
} } }));
afterEach(() => { standardCleanup(); capture.run.mockReset(); modal.module.Modal.hideAll(); });

const parsed = UsageRecapComposeResultSchema.parse({ kind: 'composed', v: 1, style: 'sigil', format: 'story', selectedFields: ['tokens'],
  unavailableFields: [], period: { startMs: 100, endMs: 900, timeZoneOffsetMinutes: 0 }, asOfMs: 900,
  coverage: { accounting: null, sourceCoverage: [], sourceStatuses: [], pending: false },
  facts: { tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 } },
});
if (parsed.kind !== 'composed') throw new Error('invalid fixture');
const composed = parsed;

describe('client recap image rendering through the shared private card', () => {
  it('produces pixels from the real selected preview without sharing or uploading them', async () => {
    const screen = await renderScreen(<ModalProvider children={null} />, { createNodeMock: element => element.props });
    let pending!: ReturnType<typeof renderUsageRecapImage>;
    await act(async () => { pending = renderUsageRecapImage(composed, {}); });
    const card = screen.findByTestId('usage-recap-image.card')!;
    const label = card.props.accessibilityLabel;
    expect(label).toContain('12');
    expect(label).not.toMatch(/\$|private/);
    await act(async () => {
      screen.findByTestId('usage-recap-image.stage')!.props.onLayout();
      expect(await pending).toEqual({ kind: 'rendered', base64: 'iVBORw==' });
    });
    expect(capture.painted).toBe(label);
    expect(screen.findByTestId('usage-recap-image.card')).toBeNull();
  });

  it('settles unavailable and removes the preview when cancelled during native/browser rendering', async () => {
    const screen = await renderScreen(<ModalProvider children={null} />, { createNodeMock: element => element.props });
    const controller = new AbortController();
    let release!: () => void;
    let started!: () => void;
    const captureStarted = new Promise<void>(resolve => { started = resolve; });
    capture.run.mockImplementation(() => new Promise(resolve => { release = resolve; started(); }));
    let pending!: ReturnType<typeof renderUsageRecapImage>;
    await act(async () => { pending = renderUsageRecapImage(composed, { signal: controller.signal }); });
    await act(async () => { screen.findByTestId('usage-recap-image.stage')!.props.onLayout(); await captureStarted; });
    await act(async () => { controller.abort(); });
    await expect(pending).resolves.toMatchObject({ kind: 'unavailable' });
    expect(screen.findByTestId('usage-recap-image.card')).toBeNull();
    await act(async () => { release(); });
    await expect(pending).resolves.toMatchObject({ kind: 'unavailable' });
  });

  it('returns explicit unavailability when no client presentation host is mounted', async () => {
    modal.spies.show.mockReturnValueOnce('');
    await expect(renderUsageRecapImage(composed, {})).resolves.toEqual({ kind: 'unavailable', reason: 'render_target_unavailable' });
  });
  it('settles unavailable if the mounted image stage is removed by the modal owner', async () => {
    await renderScreen(<ModalProvider children={null} />, { createNodeMock: element => element.props });
    let settled: unknown;
    await act(async () => { void renderUsageRecapImage(composed, {}).then(result => { settled = result; }); });
    await act(async () => { modal.module.Modal.hideAll(); });
    expect(settled).toEqual({ kind: 'unavailable', reason: 'render_target_unavailable' });
  });
});
