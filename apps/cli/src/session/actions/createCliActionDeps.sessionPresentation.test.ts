import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  HostCurrentSessionInteractionsService,
  HostCurrentSessionPresentationService,
  HostCurrentSessionUiServices,
} from '@/agent/runtime/state/currentSessionUiTypes';
import { registerCurrentSessionUiBinding } from '@/session/presentation/currentSessionUiBindings';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { dispatchBuiltInHappierTool } from '@/agent/tools/happierTools/dispatchBuiltInHappierTool';

import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';

const disposals: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

function createPresentationService(
  present: HostCurrentSessionPresentationService['present'],
): HostCurrentSessionPresentationService {
  return Object.freeze({
    notify: vi.fn(async () => ({ status: 'applied' as const, revision: '1' })),
    setStatus: vi.fn(async () => ({ status: 'applied' as const, revision: '1' })),
    setWidget: vi.fn(async () => ({ status: 'applied' as const, revision: '1' })),
    purgeOwner: vi.fn(async () => ({ status: 'applied' as const, revision: '1' })),
    replaceComposerText: vi.fn(async () => ({ status: 'applied' as const, revision: '1' })),
    present,
  });
}

function bindPresentation(
  sessionId: string,
  present: HostCurrentSessionPresentationService['present'],
): AbortController {
  const controller = new AbortController();
  const request = vi.fn() as HostCurrentSessionInteractionsService['request'];
  const services: HostCurrentSessionUiServices = Object.freeze({
    interactions: Object.freeze({ request }),
    presentation: createPresentationService(present),
  });
  disposals.push(registerCurrentSessionUiBinding({
    sessionId,
    service: services,
    signal: controller.signal,
    isCurrent: () => true,
  }));
  return controller;
}

describe('CLI current-Session presentation Action producer', () => {
  it('routes the projected Agent tool through the canonical Action executor into the live Session binding', async () => {
    const present = vi.fn<HostCurrentSessionPresentationService['present']>(async () => ({
      status: 'applied',
      revision: 'host-a:3',
    }));
    bindPresentation('session-a', present);
    const harness = createCliActionExecutorHarness({
      token: 'runtime-token',
      sessionId: 'session-a',
      mode: 'plain',
      ctx: null,
    });
    const requiredDirectActionIds = ['session.presentation.apply'] as const;
    const bridge = createActionToolExecutorBridge({
      surface: 'agent',
      executor: harness.executor,
      requiredDirectActionIds,
    });

    await expect(dispatchBuiltInHappierTool({
      toolName: 'session_presentation_apply',
      args: { intent: { kind: 'board.open', mode: 'beside_chat' } },
      sessionId: 'session-a',
      surface: 'agent',
      requiredDirectActionIds,
      approvalOrigin: {
        kind: 'transcript_tool_call',
        sessionId: 'session-a',
        toolCallId: 'tool-call-a',
        toolName: 'session_presentation_apply',
      },
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName: bridge.executeActionByToolName,
      },
    })).resolves.toEqual({
      ok: true,
      result: { status: 'applied', revision: 'host-a:3' },
    });
    expect(present).toHaveBeenCalledWith({
      operationId: 'tool-call-a',
      intent: { kind: 'board.open', mode: 'beside_chat' },
    }, undefined);
  });

  it.each(['agent', 'cli'] as const)('uses the exact live Session binding and host-stamped request identity end to end on %s', async (surface) => {
    const present = vi.fn<HostCurrentSessionPresentationService['present']>(async () => ({
      status: 'applied',
      revision: 'host-a:3',
    }));
    bindPresentation('session-a', present);
    const harness = createCliActionExecutorHarness({
      token: 'runtime-token',
      sessionId: 'session-a',
      mode: 'plain',
      ctx: null,
    });
    const signal = new AbortController().signal;

    await expect(harness.executor.execute('session.presentation.apply', {
      intent: { kind: 'board.open', mode: 'beside_chat' },
    }, {
      surface,
      authority: 'account_automation',
      defaultSessionId: 'session-a',
      actionRequestId: 'tool-call-a',
      signal,
    })).resolves.toEqual({
      ok: true,
      result: { status: 'applied', revision: 'host-a:3' },
    });

    expect(present).toHaveBeenCalledWith({
      operationId: 'tool-call-a',
      intent: { kind: 'board.open', mode: 'beside_chat' },
    }, { signal });
  });

  it.each(['agent', 'cli'] as const)('fails closed when the exact Session binding is absent, retired, or unstamped on %s', async (surface) => {
    const present = vi.fn<HostCurrentSessionPresentationService['present']>(async () => ({
      status: 'applied',
      revision: 'host-a:3',
    }));
    const controller = bindPresentation('session-a', present);
    const harness = createCliActionExecutorHarness({
      token: 'runtime-token',
      sessionId: 'session-a',
      mode: 'plain',
      ctx: null,
    });

    await expect(harness.executor.execute('session.presentation.apply', {
      intent: { kind: 'companion.show' },
    }, {
      surface,
      authority: 'account_automation',
      defaultSessionId: 'session-b',
      actionRequestId: 'tool-call-a',
    })).resolves.toMatchObject({ ok: false, errorCode: 'current_session_presentation_unavailable' });

    controller.abort();
    await expect(harness.executor.execute('session.presentation.apply', {
      intent: { kind: 'companion.show' },
    }, {
      surface,
      authority: 'account_automation',
      defaultSessionId: 'session-a',
      actionRequestId: 'tool-call-a',
    })).resolves.toMatchObject({ ok: false, errorCode: 'current_session_presentation_unavailable' });

    await expect(harness.executor.execute('session.presentation.apply', {
      intent: { kind: 'companion.show' },
    }, {
      surface,
      authority: 'account_automation',
      defaultSessionId: 'session-a',
    })).resolves.toMatchObject({ ok: false, errorCode: 'action_request_id_required' });
    expect(present).not.toHaveBeenCalled();
  });

  it('preserves the presentation owner diagnostic when a mounted target is invalid', async () => {
    bindPresentation('session-a', async () => ({
      status: 'unavailable',
      diagnostic: {
        code: 'current_session_presentation_invalid_target',
        severity: 'error',
        message: 'The requested Board or Companion target is unavailable',
      },
    }));
    const harness = createCliActionExecutorHarness({
      token: 'runtime-token',
      sessionId: 'session-a',
      mode: 'plain',
      ctx: null,
    });

    await expect(harness.executor.execute('session.presentation.apply', {
      intent: { kind: 'board.item.reveal', widgetId: 'missing-widget' },
    }, {
      surface: 'agent',
      authority: 'account_automation',
      defaultSessionId: 'session-a',
      actionRequestId: 'tool-call-invalid-target',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'current_session_presentation_invalid_target',
    });
  });
});
