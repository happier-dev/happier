import { describe, expect, it, vi } from 'vitest';

import { TmuxUtilities } from './TmuxUtilities';

describe('TmuxUtilities.killWindow', () => {
  it('reports success only after exact window absence is observed', async () => {
    const tmux = new TmuxUtilities('happy');
    const execute = vi.spyOn(tmux, 'executeTmuxCommand')
      .mockResolvedValueOnce({
        returncode: 0,
        stdout: '',
        stderr: '',
        command: [],
      })
      .mockResolvedValueOnce({
        returncode: 0,
        stdout: 'other-window\n',
        stderr: '',
        command: [],
      });

    await expect(tmux.killWindow('happy:owned-window')).resolves.toBe(true);
    expect(execute).toHaveBeenNthCalledWith(
      2,
      ['list-windows', '-t', 'happy', '-F', '#{window_name}'],
    );
  });

  it('does not equate kill-window exit zero with exact window absence', async () => {
    const tmux = new TmuxUtilities('happy');
    vi.spyOn(tmux, 'executeTmuxCommand')
      .mockResolvedValueOnce({
        returncode: 0,
        stdout: '',
        stderr: '',
        command: [],
      })
      .mockResolvedValueOnce({
        returncode: 0,
        stdout: 'owned-window\n',
        stderr: '',
        command: [],
      });

    await expect(tmux.killWindow('happy:owned-window')).resolves.toBe(false);
  });

  it('accepts a recognized absent-session inventory result', async () => {
    const tmux = new TmuxUtilities('happy');
    vi.spyOn(tmux, 'executeTmuxCommand')
      .mockResolvedValueOnce({
        returncode: 0,
        stdout: '',
        stderr: '',
        command: [],
      })
      .mockResolvedValueOnce({
        returncode: 1,
        stdout: '',
        stderr: "can't find session: happy",
        command: [],
      });

    await expect(tmux.killWindow('happy:owned-window')).resolves.toBe(true);
  });
});
