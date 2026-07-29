import { describe, expect, it } from 'vitest';

import {
  applyTerminalControlServiceabilityProjection,
  clearTerminalControlServiceabilityProjection,
  resolveRunnerTerminalControlServiceabilityEvidence,
  shouldPublishReportedTerminalControlServiceability,
} from './terminalControlServiceabilityProjection';

describe('terminal control serviceability projection', () => {
  it('publishes a reported nested attachment only until exact live evidence exists', () => {
    const terminal = {
      mode: 'tmux' as const,
      tmux: { target: 'nested-host:nested-pane' },
    };

    expect(shouldPublishReportedTerminalControlServiceability({
      terminal,
      attachmentId: 'attachment-1',
      publishedAttachmentId: undefined,
    })).toBe(true);
    expect(shouldPublishReportedTerminalControlServiceability({
      terminal: {
        ...terminal,
        controlServiceabilityV1: {
          v: 1 as const,
          attachmentId: 'attachment-1',
          state: 'servable' as const,
          observedAt: 1,
        },
      },
      attachmentId: 'attachment-1',
      publishedAttachmentId: undefined,
    })).toBe(false);
    expect(shouldPublishReportedTerminalControlServiceability({
      terminal,
      attachmentId: 'attachment-1',
      publishedAttachmentId: 'attachment-1',
    })).toBe(false);
  });

  it('projects a present but unservable reattached runner as recoverable', () => {
    expect(resolveRunnerTerminalControlServiceabilityEvidence({
      serviceability: { state: 'recoverable_unservable', reason: 'rpc_method_unavailable' },
      attachmentId: 'attachment-zombie-wrapper',
      observedAt: 150,
    })).toEqual({
      attachmentId: 'attachment-zombie-wrapper',
      state: 'recoverable_unservable',
      reason: 'rpc_method_unavailable',
      observedAt: 150,
    });
  });

  it('refuses a delayed observation from a replaced terminal attachment', () => {
    const replacement = applyTerminalControlServiceabilityProjection({
      metadata: { terminal: { mode: 'tmux' } },
      evidence: { attachmentId: 'replacement', state: 'servable', observedAt: 200 },
    });
    expect(applyTerminalControlServiceabilityProjection({
      metadata: replacement,
      evidence: {
        attachmentId: 'original',
        state: 'recoverable_unservable',
        reason: 'rpc_method_unavailable',
        observedAt: 100,
      },
    })).toEqual(replacement);
  });

  it('clears only serviceability evidence bound to the retired attachment', () => {
    const metadata = {
      terminal: {
        mode: 'tmux',
        controlServiceabilityV1: {
          v: 1,
          attachmentId: 'retired',
          state: 'recoverable_unservable',
          reason: 'rpc_method_unavailable',
          observedAt: 100,
        },
      },
    };
    expect(clearTerminalControlServiceabilityProjection({
      metadata,
      retiredAttachmentId: 'retired',
      retiredAt: 150,
      terminalMode: 'tmux',
    })).toEqual({
      terminal: {
        mode: 'tmux',
        controlServiceabilityV1: {
          v: 1,
          attachmentId: 'retired',
          state: 'unknown',
          observedAt: 150,
          reason: 'attachment_retired',
          retired: true,
        },
      },
    });

    const replacement = {
      terminal: {
        ...metadata.terminal,
        controlServiceabilityV1: {
          ...metadata.terminal.controlServiceabilityV1,
          attachmentId: 'replacement',
          state: 'servable',
          observedAt: 200,
        },
      },
    };
    expect(clearTerminalControlServiceabilityProjection({
      metadata: replacement,
      retiredAttachmentId: 'retired',
      retiredAt: 250,
      terminalMode: 'tmux',
    })).toEqual(replacement);
  });

  it('rejects delayed evidence for a retired attachment but accepts replacement evidence', () => {
    const retired = clearTerminalControlServiceabilityProjection({
      metadata: {
        terminal: {
          mode: 'tmux',
          controlServiceabilityV1: {
            v: 1,
            attachmentId: 'retired',
            state: 'recoverable_unservable',
            observedAt: 100,
          },
        },
      },
      retiredAttachmentId: 'retired',
      retiredAt: 150,
      terminalMode: 'tmux',
    });
    expect(applyTerminalControlServiceabilityProjection({
      metadata: retired,
      evidence: { attachmentId: 'retired', state: 'recoverable_unservable', observedAt: 200 },
    })).toEqual(retired);
    expect(applyTerminalControlServiceabilityProjection({
      metadata: retired,
      evidence: { attachmentId: 'replacement', state: 'servable', observedAt: 150 },
    })).toMatchObject({
      terminal: { controlServiceabilityV1: { attachmentId: 'replacement', state: 'servable' } },
    });
  });

  it('creates a retirement tombstone when no projection exists yet', () => {
    const retired = clearTerminalControlServiceabilityProjection({
      metadata: { terminal: { mode: 'tmux' } },
      retiredAttachmentId: 'retired-before-publish',
      retiredAt: 150,
      terminalMode: 'tmux',
    });
    expect(retired).toMatchObject({
      terminal: {
        mode: 'tmux',
        controlServiceabilityV1: {
          attachmentId: 'retired-before-publish',
          state: 'unknown',
          observedAt: 150,
          reason: 'attachment_retired',
          retired: true,
        },
      },
    });
    expect(applyTerminalControlServiceabilityProjection({
      metadata: retired,
      evidence: { attachmentId: 'retired-before-publish', state: 'recoverable_unservable', observedAt: 200 },
    })).toEqual(retired);
  });

  it('carries the actual terminal mode when retirement creates terminal metadata', () => {
    expect(clearTerminalControlServiceabilityProjection({
      metadata: {},
      retiredAttachmentId: 'retired-before-terminal-publish',
      retiredAt: 150,
      terminalMode: 'zellij',
    })).toMatchObject({
      terminal: {
        mode: 'zellij',
        controlServiceabilityV1: {
          attachmentId: 'retired-before-terminal-publish',
          retired: true,
        },
      },
    });
  });
});
