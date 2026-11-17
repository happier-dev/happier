import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import {
  PUBLIC_ACTION_IDS,
  PublicActionIdSchema,
  getActionSpec,
  isPluginSurfaceExcludedActionId,
} from './actionSpecs.js';
import {
  SESSION_READ_STATE_ACTION_INPUT_SCHEMAS_V1,
  SESSION_READ_STATE_ACTION_OUTPUT_SCHEMAS_V1,
} from '../sessions/readState/actions.js';
import { SESSION_READ_STATE_HTTP_PATHS_V1 } from '../sessions/readState/api.js';
import { projectSessionReadStateActionTransportFailure } from '../sessions/readState/actionTransport.js';

describe('Session read-state Action vertical', () => {
  it('classifies only the exact HTTP scope refusal before domain decoding', () => {
    expect(projectSessionReadStateActionTransportFailure(403, { error: 'credential_scope_denied' }))
      .toEqual({ errorCode: 'credential_scope_denied' });
    expect(projectSessionReadStateActionTransportFailure(403, { error: 'credential_scope_denied', viewer: {} }))
      .toEqual({ errorCode: 'unavailable' });
    expect(projectSessionReadStateActionTransportFailure(403, { error: 'unknown_denial' }))
      .toEqual({ errorCode: 'unavailable' });
    expect(projectSessionReadStateActionTransportFailure(500, { error: 'credential_scope_denied' }))
      .toEqual({ errorCode: 'unavailable' });
  });
  it('declares one automation Action over the existing domain route including Agent/MCP exposure', () => {
    const spec = getActionSpec('session.read_state.set');

    expect(spec.inputSchema).toBe(SESSION_READ_STATE_ACTION_INPUT_SCHEMAS_V1['session.read_state.set']);
    expect(spec.outputSchema).toBe(SESSION_READ_STATE_ACTION_OUTPUT_SCHEMAS_V1['session.read_state.set']);
    expect(spec.requiredAuthority).toBe('account_automation');
    expect(spec.executionPlacement).toBe('account');
    expect(spec.sideEffectClass).toBe('write');
    expect(spec.surfaces).toMatchObject({
      ui: true,
      cli: true,
      agent: true,
      mcp: true,
      api: true,
      plugin: true,
      voice: true,
    });
    expect(spec.serverTransport).toEqual({
      method: 'POST',
      path: SESSION_READ_STATE_HTTP_PATHS_V1.set,
    });
    expect(spec.cli?.commands).toContainEqual(expect.objectContaining({
      path: ['session', 'read'],
      visibility: 'canonical',
    }));
    expect(isPluginSurfaceExcludedActionId(spec.id)).toBe(false);
    expect(PUBLIC_ACTION_IDS).toContain(spec.id);
    expect(PublicActionIdSchema.safeParse(spec.id).success).toBe(true);
  });

  it.each(['agent', 'mcp', 'voice'] as const)('allows %s to mark a session read without confirmation', async (surface) => {
    const sessionReadStateAction = vi.fn(async () => ({
      success: true, state: 'read', lastViewedSessionSeq: 7, didChange: true,
    }));
    const executor = createActionExecutor({ sessionReadStateAction } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.read_state.set', {
      sessionId: 'session-1',
      state: 'read',
    }, {
      surface,
      authority: 'account_automation',
      serverId: 'home-1',
    })).resolves.toEqual({
      ok: true,
      result: { state: 'read', lastViewedSessionSeq: 7, didChange: true },
    });
    expect(sessionReadStateAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'session.read_state.set', serverId: 'home-1',
      input: { sessionId: 'session-1', state: 'read' },
    }));
  });

  it('binds the exact Home and projects the domain response through one executor port', async () => {
    const controller = new AbortController();
    const sessionReadStateAction = vi.fn(async () => ({
      success: true,
      state: 'unread',
      lastViewedSessionSeq: 6,
      didChange: true,
    }));
    const executor = createActionExecutor({
      sessionReadStateAction,
      resolveServerIdForSessionId: () => 'home-1',
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.read_state.set', {
      sessionId: 'session-1',
      state: 'unread',
    }, {
      surface: 'ui',
      authority: 'present_user',
      signal: controller.signal,
    })).resolves.toEqual({
      ok: true,
      result: {
        state: 'unread',
        lastViewedSessionSeq: 6,
        didChange: true,
      },
    });
    expect(sessionReadStateAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'session.read_state.set',
      input: { sessionId: 'session-1', state: 'unread' },
      serverId: 'home-1',
      signal: controller.signal,
    }));
  });

  it('retains the canonical private viewer projection for the interactive host cache', async () => {
    const viewer = {
      latestFailureSeq: null,
      readState: { state: 'tracking' as const, lastViewedSessionSeq: 7, unreadSince: null },
      relevance: { relevant: true, reasons: ['owned_by_me' as const] },
      attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' as const },
      follow: { follows: false as const, notificationLevel: null },
      notification: { level: 'important' as const, source: 'owner' as const },
    };
    const executor = createActionExecutor({
      sessionReadStateAction: vi.fn(async () => ({
        success: true,
        state: 'read',
        lastViewedSessionSeq: 7,
        didChange: true,
        viewer,
      })),
      resolveServerIdForSessionId: () => 'home-1',
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.read_state.set', {
      sessionId: 'session-1',
      state: 'read',
    }, {
      surface: 'ui',
      authority: 'present_user',
    })).resolves.toEqual({
      ok: true,
      result: {
        state: 'read',
        lastViewedSessionSeq: 7,
        didChange: true,
        viewer,
      },
    });
  });

  it('rejects malformed input and malformed success output at the Action boundary', async () => {
    const diagnostics: unknown[] = [];
    const sessionReadStateAction = vi.fn(async () => ({
      success: true,
      state: 'read',
      lastViewedSessionSeq: 7,
      didChange: 'PRIVATE_READ_STATE_RESPONSE',
    }));
    const executor = createActionExecutor({ sessionReadStateAction,
      recordActionOutputDiagnostic: diagnostic => diagnostics.push(diagnostic) });

    await expect(executor.execute('session.read_state.set', {
      sessionId: 'session-1',
      state: 'read',
      accountId: 'forged-account',
    }, {
      surface: 'ui',
      authority: 'present_user',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
      details: { issues: [{ code: 'unrecognized_keys', path: [] }] },
    });
    expect(sessionReadStateAction).not.toHaveBeenCalled();

    await expect(executor.execute('session.read_state.set', {
      sessionId: 'session-1',
      state: 'read',
    }, {
      surface: 'ui',
      authority: 'present_user',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_action_output',
      error: 'invalid_action_output',
    });
    expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'action.session_read_state.output',
      issues: expect.arrayContaining([expect.objectContaining({ path: ['didChange'], code: 'invalid_type' })]) })]));
    expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE_');
  });

  it('projects only exact route failures into the closed Action vocabulary', () => {
    const viewer = {
      latestFailureSeq: null,
      readState: { state: 'not_started' as const },
      relevance: { relevant: false, reasons: [] },
      attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' as const },
      follow: { follows: false as const, notificationLevel: null },
      notification: { level: 'none' as const, source: 'none' as const },
    };

    expect(projectSessionReadStateActionTransportFailure(409, {
      error: 'session_not_tracked',
      viewer,
    })).toEqual({ errorCode: 'session_not_tracked', viewer });
    expect(projectSessionReadStateActionTransportFailure(404, {
      error: 'Session not found',
    })).toEqual({ errorCode: 'session_not_found' });
    expect(projectSessionReadStateActionTransportFailure(404, {
      error: 'missing route',
    })).toEqual({ errorCode: 'unsupported_action' });
    expect(projectSessionReadStateActionTransportFailure(403, {
      error: 'present_user_required',
    })).toEqual({ errorCode: 'present_user_required' });
    expect(projectSessionReadStateActionTransportFailure(403, {
      error: 'present_user_required',
      authority: 'present_user',
    })).toEqual({ errorCode: 'unavailable' });
    expect(projectSessionReadStateActionTransportFailure(403, {
      error: 'Forbidden',
    })).toEqual({ errorCode: 'forbidden' });
    expect(projectSessionReadStateActionTransportFailure(500, {
      error: 'caller-controlled-code',
    })).toEqual({ errorCode: 'unavailable' });
  });
});
