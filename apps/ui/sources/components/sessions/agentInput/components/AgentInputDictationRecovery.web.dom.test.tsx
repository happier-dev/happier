/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => await vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return await createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/components/ui/icons/SafeIonicons', () => ({
  SafeIonicons: (props: Readonly<{ name?: string }>) =>
    React.createElement('span', { 'data-icon': props.name }),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

type Props = React.ComponentProps<
  typeof import('./AgentInputDictationRecovery').AgentInputDictationRecovery
>;

async function render(overrides: Partial<Props>): Promise<HTMLDivElement> {
  const { AgentInputDictationRecovery } =
    await import('./AgentInputDictationRecovery');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const props: Props = {
    failure: {
      id: 1,
      sessionId: 'dictation-1',
      kind: 'provider_error',
      reason: 'transcription_failed',
      canRetry: true,
    },
    status: 'idle',
    onRetry: vi.fn(
      async () => ({ ok: true, result: { status: 'completed' } }) as never,
    ),
    onDiscard: vi.fn(
      async () => ({ ok: true, result: { status: 'completed' } }) as never,
    ),
    ...overrides,
  };
  act(() => {
    root!.render(React.createElement(AgentInputDictationRecovery, props));
  });
  return container;
}

function button(host: HTMLElement, testID: string): HTMLElement {
  const element = host.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  if (!element) throw new Error(`${testID} did not render`);
  return element;
}

function isDisabled(element: HTMLElement): boolean {
  return (
    element.getAttribute('aria-disabled') === 'true' ||
    element.hasAttribute('disabled')
  );
}

describe('AgentInputDictationRecovery', () => {
  it('names the cause and offers Retry then Discard while the recording is kept', async () => {
    const onRetry = vi.fn(
      async () => ({ ok: true, result: { status: 'completed' } }) as never,
    );
    const onDiscard = vi.fn(
      async () => ({ ok: true, result: { status: 'completed' } }) as never,
    );
    const host = await render({ onRetry, onDiscard });
    expect(host.textContent).toContain(
      'voiceAssistant.dictationErrors.transcriptionFailed',
    );
    const retry = button(host, 'agent-input-dictation-recovery-retry');
    const discard = button(host, 'agent-input-dictation-recovery-discard');
    expect(isDisabled(retry)).toBe(false);
    await act(async () => {
      retry.click();
    });
    await act(async () => {
      discard.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('holds Retry while capture teardown settles and while a retry is transcribing', async () => {
    const settling = await render({
      failure: {
        id: 2,
        sessionId: 'dictation-2',
        kind: 'provider_error',
        reason: 'transcription_failed',
        canRetry: false,
      },
    });
    expect(
      isDisabled(button(settling, 'agent-input-dictation-recovery-retry')),
    ).toBe(true);
    act(() => {
      root?.unmount();
    });
    container?.remove();

    const transcribing = await render({ status: 'transcribing' });
    expect(
      isDisabled(button(transcribing, 'agent-input-dictation-recovery-retry')),
    ).toBe(true);
    // The reason stays on screen through the retry; only success or Discard removes the line.
    expect(transcribing.textContent).toContain(
      'voiceAssistant.dictationErrors.transcriptionFailed',
    );
  });
});

describe('useDictationRecoveryFailure', () => {
    it('keeps the cause in place while Retry transcribes, and clears it when the retry settles or is discarded', async () => {
        const { useDictationRecoveryFailure } = await import('./AgentInputDictationRecovery');
        const failure = { id: 3, sessionId: 'dictation-3', kind: 'provider_error' as const, reason: 'transcription_failed' as const, canRetry: true };
        const seen: Array<string | null> = [];
        function Probe(props: Readonly<{ failure: typeof failure | null; status: 'idle' | 'transcribing' }>) {
            seen.push(useDictationRecoveryFailure(props.failure, props.status)?.reason ?? null);
            return null;
        }
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        const step = (next: React.ComponentProps<typeof Probe>) => act(() => { root!.render(React.createElement(Probe, next)); });
        step({ failure, status: 'idle' });
        step({ failure: null, status: 'transcribing' });
        step({ failure: null, status: 'idle' });
        step({ failure: { ...failure, canRetry: undefined } as never, status: 'idle' });
        expect(seen).toEqual(['transcription_failed', 'transcription_failed', null, null]);
    });
});
