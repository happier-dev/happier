import { describe, expect, it, vi } from 'vitest';

import { settleExecutionRunController } from './settleExecutionRunController';

describe('settleExecutionRunController', () => {
  it('settles the terminal marker before backend disposal releases cleanup custody', async () => {
    let markerSettled = false;
    let settleMarker!: () => void;
    const terminalMarkerWritePromise = new Promise<void>((resolve) => {
      settleMarker = () => {
        markerSettled = true;
        resolve();
      };
    });
    const dispose = vi.fn(async () => {
      expect(markerSettled).toBe(true);
    });
    const resolveTerminal = vi.fn();
    const controller = {
      kind: 'backend',
      backend: { dispose },
      settlementPromise: null,
      terminalMarkerWritePromise,
      resolveTerminal,
    } as never;
    const controllers = new Map([['run-1', controller]]);

    const settlement = settleExecutionRunController({
      runId: 'run-1',
      controller,
      controllers,
    });
    await Promise.resolve();
    expect(dispose).not.toHaveBeenCalled();

    settleMarker();
    await settlement;

    expect(dispose).toHaveBeenCalledOnce();
    expect(resolveTerminal).toHaveBeenCalledOnce();
    expect(controllers.has('run-1')).toBe(false);
  });
});
