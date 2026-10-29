import inspector from 'node:inspector';
import type { ReactElement } from 'react';
import { expect, it, vi } from 'vitest';

import { setStdioTtyForTest } from '@/testkit/process/stdio';

type SelectorCallbacks = Readonly<{
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
}>;

const inkBoundary = vi.hoisted(() => ({
  loaded: false,
  action: 'select' as 'select' | 'cancel',
  unmount: vi.fn(),
}));

// Ink owns the renderer/terminal boundary; React and the real selector remain loaded normally.
vi.mock('ink', async (importOriginal) => {
  inkBoundary.loaded = true;
  const actual = await importOriginal<typeof import('ink')>();
  return { ...actual, render: (element: ReactElement<SelectorCallbacks>) => {
    queueMicrotask(() => {
      if (inkBoundary.action === 'select') element.props.onSelect('session-1');
      else element.props.onCancel();
    });
    return { unmount: inkBoundary.unmount };
  } };
});

it('keeps the renderer cold for capability checks, then selects and cancels with stdin restored', async () => {
  const session = new inspector.Session();
  session.connect();
  const loadedScripts: string[] = [];
  session.on('Debugger.scriptParsed', ({ params }) => loadedScripts.push(params.url));
  const restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
  const pause = vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
  const resume = vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
  const encoding = vi.spyOn(process.stdin, 'setEncoding').mockReturnValue(process.stdin);
  const clear = vi.spyOn(console, 'clear').mockImplementation(() => undefined);
  try {
    await new Promise<void>((resolve, reject) => session.post('Debugger.enable', error => error ? reject(error) : resolve()));
    const rendererScripts = () => loadedScripts.filter(url => /node_modules\/(?:ink|react-reconciler)\//u.test(url));
    expect(rendererScripts()).toEqual([]);
    const selector = await import('./runSessionActionSelector');
    expect(selector.canUseInkSelector()).toBe(false);
    expect(inkBoundary.loaded).toBe(false);
    expect(rendererScripts()).toEqual([]);

    const params = { title: 'Sessions', actionVerb: 'resume', rows: [{ sessionId: 'session-1', agentId: 'codex', title: 'Session', path: '/repo', updatedAt: 1 }] };
    await expect(selector.runSessionActionSelector(params)).resolves.toEqual({ type: 'selected', sessionId: 'session-1' });
    expect(inkBoundary.loaded).toBe(true);
    expect(rendererScripts().length).toBeGreaterThan(0);
    inkBoundary.action = 'cancel';
    await expect(selector.runSessionActionSelector(params)).resolves.toEqual({ type: 'cancelled' });
    expect(inkBoundary.unmount).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalled();
    expect(encoding).toHaveBeenLastCalledWith(null);
  } finally {
    pause.mockRestore();
    resume.mockRestore();
    encoding.mockRestore();
    clear.mockRestore();
    restoreTty();
    session.disconnect();
  }
});
