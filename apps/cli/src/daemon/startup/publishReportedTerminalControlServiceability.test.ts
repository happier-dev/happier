import { describe, expect, it, vi } from 'vitest';

import {
  createTerminalAttachmentId,
  type BoundTerminalHostAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';

import type { TrackedSession } from '../types';
import { publishReportedTerminalControlServiceability } from './publishReportedTerminalControlServiceability';

describe('publishReportedTerminalControlServiceability', () => {
  it('probes and publishes a live nested host once per exact attachment', async () => {
    const sessionId = 'sess-nested-host';
    const attachmentId = createTerminalAttachmentId();
    const terminal = {
      mode: 'tmux' as const,
      tmux: { target: 'nested-host:nested-pane' },
    };
    const attachment: BoundTerminalHostAttachmentInfo = {
      version: 2,
      attachmentId,
      sessionId,
      handle: {
        attachmentId,
        kind: 'tmux',
        sessionName: 'nested-host',
        paneId: 'nested-pane',
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'exclusive',
          locality: 'same_machine',
          liveProbe: 'required',
        },
      },
      updatedAt: 1,
    };
    const tracked: TrackedSession = {
      pid: 42,
      startedBy: 'daemon',
      happySessionId: sessionId,
      happySessionMetadataFromLocalWebhook: {
        path: '/tmp',
        host: 'test-host',
        homeDir: '/tmp/home',
        happyHomeDir: '/tmp/happier',
        happyLibDir: '/tmp/happier/lib',
        happyToolsDir: '/tmp/happier/tools',
        terminal,
      },
    };
    const readTerminalAttachmentInfo = vi.fn(async (_sessionId: string) => attachment);
    const probeSessionRunnerServiceability = vi.fn(async () => ({
      state: 'runner_present' as const,
      control: { state: 'servable' as const },
    }));
    const publishSessionRunnerControlServiceability = vi.fn(async () => true);

    await publishReportedTerminalControlServiceability({
      tracked,
      readTerminalAttachmentInfo,
      probeSessionRunnerServiceability,
      publishSessionRunnerControlServiceability,
    });
    await publishReportedTerminalControlServiceability({
      tracked,
      readTerminalAttachmentInfo,
      probeSessionRunnerServiceability,
      publishSessionRunnerControlServiceability,
    });

    expect(probeSessionRunnerServiceability).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(publishSessionRunnerControlServiceability).toHaveBeenCalledExactlyOnceWith(
      sessionId,
      {
        state: 'runner_present',
        control: { state: 'servable' },
      },
    );
    expect(tracked.publishedTerminalControlServiceabilityAttachmentId).toBe(attachmentId);
  });
});
