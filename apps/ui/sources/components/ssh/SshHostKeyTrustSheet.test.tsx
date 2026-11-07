import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

type ShownSheet = {
  chrome?: { testID?: string };
  props?: { onResolve?: (trusted: boolean) => void };
};
const modal = vi.hoisted(() => ({
  shown: [] as ShownSheet[],
  hidden: [] as string[],
}));

vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({
    spies: {
      show: ((config: ShownSheet) => {
        modal.shown.push(config);
        return `sheet-${modal.shown.length}`;
      }) as never,
      hide: (id: string) => {
        modal.hidden.push(id);
      },
    },
  }).module;
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});

// Load the owner once at collection time; its UI graph is too large for a per-test import budget.
const { useSshHostKeyTrustSheet } = await import('./SshHostKeyTrustSheet');

afterEach(() => {
  standardCleanup();
  modal.shown.length = 0;
  modal.hidden.length = 0;
});

const request = {
  host: 'atlas.example',
  keyType: 'ssh-ed25519',
  fingerprint: 'SHA256:p3Ox1q9Z',
};

describe('useSshHostKeyTrustSheet', () => {
  it('shows one trust sheet per pending host key and hands the answer to the flow', async () => {
    const decide = vi.fn();
    const hook = await renderHook(
      ({ pending }: { pending: typeof request | null }) =>
        useSshHostKeyTrustSheet(pending, decide),
      { initialProps: { pending: request } },
    );
    await flushHookEffects();
    // A re-render with the same prompt does not stack a second sheet.
    await hook.rerender({ pending: { ...request } });
    await flushHookEffects();
    expect(modal.shown).toHaveLength(1);
    expect(modal.shown[0]!.chrome?.testID).toBe('ssh-host-key-modal');
    modal.shown[0]!.props?.onResolve?.(true);
    await flushHookEffects();
    expect(decide).toHaveBeenCalledWith(true);
  });

  it('closes the sheet without answering when the prompt goes away', async () => {
    const decide = vi.fn();
    const hook = await renderHook(
      ({ pending }: { pending: typeof request | null }) =>
        useSshHostKeyTrustSheet(pending, decide),
      { initialProps: { pending: request as typeof request | null } },
    );
    await flushHookEffects();
    await hook.rerender({ pending: null });
    await flushHookEffects();
    expect(modal.hidden).toEqual(['sheet-1']);
    // A late tap on the closed sheet cannot answer a prompt that is gone.
    modal.shown[0]!.props?.onResolve?.(true);
    await flushHookEffects();
    expect(decide).not.toHaveBeenCalled();
  });
});
