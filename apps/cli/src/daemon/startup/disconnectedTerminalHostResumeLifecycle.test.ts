import { describe, expect, it } from 'vitest';

import { createTerminalAttachmentId } from '@/terminal/attachment/terminalAttachmentInfo';

import { createDisconnectedTerminalHostResumeLifecycle } from './disconnectedTerminalHostResumeLifecycle';

describe('disconnected terminal-host resume lifecycle', () => {
  it('repairs unresolved legacy topology through the supplied canonical stop owner before Resume', async () => {
    const unresolved = new Set(['sess-unresolved']);
    const repairUnresolvedTopology = async () => ({ status: 'not_found' as const });
    const lifecycle = createDisconnectedTerminalHostResumeLifecycle({
      unresolvedTerminalHostSessionIds: unresolved,
      clearUnresolvedTerminalHostSession: (sessionId) => unresolved.delete(sessionId),
      findDisconnectedCandidate: () => null,
      resolveResumeGateForCandidate: async () => ({ action: 'resume' }),
      retireCandidate: () => {},
    });

    await expect(lifecycle.resolveResumePreGate(
      'sess-unresolved',
      repairUnresolvedTopology,
    )).resolves.toBeNull();
    expect(unresolved.has('sess-unresolved')).toBe(false);
  });

  it('keeps unresolved legacy topology fenced when the canonical stop owner cannot prove retirement', async () => {
    const unresolved = new Set(['sess-unresolved']);
    const lifecycle = createDisconnectedTerminalHostResumeLifecycle({
      unresolvedTerminalHostSessionIds: unresolved,
      clearUnresolvedTerminalHostSession: (sessionId) => unresolved.delete(sessionId),
      findDisconnectedCandidate: () => null,
      resolveResumeGateForCandidate: async () => ({ action: 'resume' }),
      retireCandidate: () => {},
    });

    await expect(lifecycle.resolveResumePreGate(
      'sess-unresolved',
      async () => ({ status: 'incomplete', reason: 'legacy_attachment' }),
    )).resolves.toEqual({
      type: 'error',
      errorMessage: 'The existing session has preserved terminal topology that cannot be verified. Stop it explicitly before retrying resume.',
    });
    expect(unresolved.has('sess-unresolved')).toBe(true);
  });

  it('waits for stop retirement before allowing a concurrent resume', async () => {
    const attachmentId = createTerminalAttachmentId();
    const candidates = [{
      sessionId: 'sess-stop-resume',
      pid: 7_001,
      happyHomeDir: '/tmp/happy',
      attachmentId,
      handle: {
        attachmentId,
        kind: 'tmux' as const,
        sessionName: 'happier-stop-resume',
        paneId: 'pane-1',
        attachMetadata: {
          attachStrategy: 'terminal_host' as const,
          topology: 'shared' as const,
          locality: 'same_machine' as const,
          liveProbe: 'required' as const,
        },
      },
      controlDescriptorAvailable: false,
    }];
    const retired = new Set<string>();
    let releaseStop!: () => void;
    const stopPending = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });

    const lifecycle = createDisconnectedTerminalHostResumeLifecycle({
      unresolvedTerminalHostSessionIds: new Set(),
      clearUnresolvedTerminalHostSession: () => {},
      findDisconnectedCandidate: (sessionId) =>
        candidates.find((candidate) =>
          candidate.sessionId === sessionId && !retired.has(candidate.attachmentId),
        ) ?? null,
      resolveResumeGateForCandidate: async () => ({ action: 'fence', reason: 'control_descriptor_missing' }),
      retireCandidate: ({ sessionId, attachmentId: retiredAttachmentId }) => {
        for (const candidate of candidates) {
          if (candidate.sessionId !== sessionId) continue;
          if (retiredAttachmentId && candidate.attachmentId !== retiredAttachmentId) continue;
          retired.add(candidate.attachmentId);
        }
      },
    });

    let resumeSettled = false;
    const stopPromise = lifecycle.runStop('sess-stop-resume', async () => {
      await stopPending;
      return {
        stopResult: { status: 'stopped' as const },
        retireCandidate: { sessionId: 'sess-stop-resume', attachmentId },
      };
    });
    const resumePromise = lifecycle.resolveResumePreGate('sess-stop-resume').finally(() => {
      resumeSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resumeSettled).toBe(false);

    releaseStop();
    await expect(stopPromise).resolves.toEqual({ status: 'stopped' });
    await expect(resumePromise).resolves.toBeNull();
  });

  it('retires the exact cached candidate after physical destruction even when serviceability retirement is incomplete', async () => {
    const attachmentId = createTerminalAttachmentId();
    let retired = false;
    const lifecycle = createDisconnectedTerminalHostResumeLifecycle({
      unresolvedTerminalHostSessionIds: new Set(),
      clearUnresolvedTerminalHostSession: () => {},
      findDisconnectedCandidate: () => retired ? null : {
        sessionId: 'sess-retirement-incomplete',
        pid: 7_002,
        happyHomeDir: '/tmp/happy',
        attachmentId,
        handle: {
          attachmentId,
          kind: 'tmux',
          sessionName: 'happier-retirement-incomplete',
          paneId: 'pane-2',
          attachMetadata: {
            attachStrategy: 'terminal_host',
            topology: 'shared',
            locality: 'same_machine',
            liveProbe: 'required',
          },
        },
      },
      resolveResumeGateForCandidate: async () => ({ action: 'fence', reason: 'control_descriptor_missing' }),
      retireCandidate: () => {
        retired = true;
      },
    });

    await expect(lifecycle.runStop('sess-retirement-incomplete', async () => ({
      stopResult: {
        status: 'incomplete',
        reason: 'terminal_control_serviceability_retirement_failed',
      },
      retireCandidate: { sessionId: 'sess-retirement-incomplete', attachmentId },
    }))).resolves.toEqual({
      status: 'incomplete',
      reason: 'terminal_control_serviceability_retirement_failed',
    });
    expect(retired).toBe(true);
    await expect(lifecycle.resolveResumePreGate('sess-retirement-incomplete')).resolves.toBeNull();
  });
});
