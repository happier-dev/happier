import { describe, expect, it, vi } from 'vitest';

import {
  createTerminalAttachmentId,
  type BoundTerminalHostAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';

import type { TrackedSession } from '../types';
import { publishReportedTerminalControlServiceability } from './publishReportedTerminalControlServiceability';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

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
      trackingKey: legacyPidSessionTrackingKey(42), pid: 42,
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
    expect(tracked).toMatchObject({ publishedTerminalControlServiceabilityAttachmentLifecycle: 'owned' });
  });

  it.each([false, true])('tracks a borrowed foreground runner with already-published serviceability=%s', async (alreadyPublished) => {
    const sessionId = 'sess-borrowed-herdr';
    const attachmentId = createTerminalAttachmentId();
    const terminal = {
      mode: 'herdr' as const,
      herdr: { sessionName: 'default', socketPath: '/tmp/herdr.sock', terminalId: 'terminal_1' },
      ...(alreadyPublished ? { controlServiceabilityV1: { v: 1 as const, attachmentId, state: 'servable' as const, observedAt: 1 } } : {}),
    };
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(43), pid: 43,
      startedBy: 'terminal',
      happySessionId: sessionId,
      happySessionMetadataFromLocalWebhook: {
        path: '/tmp', host: 'test-host', homeDir: '/tmp/home', happyHomeDir: '/tmp/happier',
        happyLibDir: '/tmp/happier/lib', happyToolsDir: '/tmp/happier/tools', terminal,
      },
    };
    let published = false;
    await publishReportedTerminalControlServiceability({
      tracked,
      readTerminalAttachmentInfo: async () => ({
        version: 3, lifecycle: 'borrowed', attachmentId, sessionId, updatedAt: 1,
        handle: {
          kind: 'herdr', attachmentId, ...terminal.herdr,
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
        },
      }),
      probeSessionRunnerServiceability: async () => ({ state: 'runner_present', control: { state: 'servable' } }),
      publishSessionRunnerControlServiceability: async () => { published = true; return true; },
    });
    expect(published).toBe(!alreadyPublished);
    expect(tracked).toMatchObject({
      publishedTerminalControlServiceabilityAttachmentId: attachmentId,
      publishedTerminalControlServiceabilityAttachmentLifecycle: 'borrowed',
    });
  });
});
