import { describe, expect, it } from 'vitest';
import { getActionSpec} from '@happier-dev/protocol/actions/actionSpecs';
import { UiActionDispatchResultV1Schema } from '@happier-dev/protocol/actions/clientDispatchV1';
import { projectSessionActivityCompatibilityV1 } from '@happier-dev/protocol/sessions/awareness/action';

import {
  redactVoiceToolResultForProvider,
  redactVoiceActionExecutionResultForProvider,
  redactVoiceToolResultValue,
} from './redactVoiceToolResult';

const SHARE_ALL = { shareFilePaths: true, shareSessionSummary: true, sharePermissionRequests: true } as const;

describe('redactVoiceToolResultValue', () => {
  it.each([true, false])('retains the canonical Action envelope around bounded mounted settlement (ok=%s)', ok => {
    const toolName = getActionSpec('action.invoke').bindings!.voiceClientToolName!;
    const result = ok ? { ok: true, result: { privatePayload: 'PRIVATE_RESULT' } }
      : { ok: false, errorCode: 'invalid_parameters', error: 'PRIVATE_ERROR', details: { privatePayload: 'PRIVATE_RESULT' } };
    const execution = redactVoiceActionExecutionResultForProvider(toolName, result, SHARE_ALL);
    expect(UiActionDispatchResultV1Schema.parse({ v: 1, execution }).execution).toEqual(ok
      ? { ok: true, result: { ok: true } }
      : { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
  });
  it.each(['approval_request_list', 'approval_request_get', 'approval.request.list', 'approval.request.get'])(
    'withholds Account request details from %s when request sharing is off', toolName => {
      const request = { ok: true, items: [{ artifactId: 'own-request', summary: 'PRIVATE REQUEST', actionId: 'settings.set' }] };
      expect(redactVoiceToolResultForProvider(toolName, request, { ...SHARE_ALL, sharePermissionRequests: false }))
        .toMatchObject({ ok: false, errorCode: 'privacy_disabled' });
      expect(redactVoiceToolResultForProvider(toolName, request, SHARE_ALL)).toEqual(request);
    },
  );
  it('keeps admitted inventory labels and owner paging while omitting private connection details', () => {
    const result = redactVoiceToolResultForProvider('listAgentModels', {
      items: [{ modelId: 'model', label: 'Model', uiConnectedService: 'private', flavorAliases: ['alias'] }],
      hasMore: true, nextCursor: 'next', totalCount: 12,
    }, { ...SHARE_ALL, shareSessionSummary: false, shareDeviceInventory: true });
    expect(result).toEqual({ items: [{ modelId: 'model', label: 'Model' }], hasMore: true, nextCursor: 'next', totalCount: 12 });
    // Inventory permission is not permission to disclose a Session summary
    // nested in another inventory-family Action's result.
    expect(redactVoiceToolResultForProvider('projects.open', { session: { id: 's1', title: 'PRIVATE SESSION' } }, {
      ...SHARE_ALL, shareSessionSummary: false, shareDeviceInventory: true,
    })).toEqual({ session: { id: 's1' } });
  });

  it.each(['provider_model_ambiguous', 'provider_model_not_found'])(
    'keeps the exact spawn choices for %s when Session summaries are private', errorCode => {
      const value = { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'cloudflare/@cf/openai/gpt-oss-120b' };
      const result = { ok: false, errorCode, error: errorCode, details: {
        candidates: [{ value, label: 'Named Model', description: 'Configured at /home/user/private.json and src/private.json' }],
        session: { title: 'PRIVATE TITLE' },
      } };
      const prefs = { ...SHARE_ALL, shareSessionSummary: false, shareDeviceInventory: true, shareFilePaths: false };
      for (const redact of [redactVoiceToolResultForProvider, redactVoiceActionExecutionResultForProvider]) {
        const projected = redact('spawnSession', result, prefs);
        expect(projected).toMatchObject({ details: { candidates: [{ value, label: 'Named Model', description: 'Configured at <path_redacted> and <path_redacted>' }] } });
        expect(JSON.stringify(projected)).not.toContain('PRIVATE TITLE');
        expect(redact('spawnSession', result, { ...prefs, shareDeviceInventory: false }))
          .toMatchObject({ errorCode, details: { candidates: [] } });
      }
    },
  );

  it('withholds awareness request state and private work without changing the canonical result', () => {
    const awareness = {
      v: 1, sessionId: 's1', runtime: 'waiting', freshness: 'live', lifecycle: 'active',
      operational: {
        primary: 'action_required',
        // The same preference gates permission prompts and user-action questions, so neither
        // pending agent request may survive as a reason or as the compact primary state.
        reasons: ['action_required', 'permission_required', 'working'],
      },
      currentWork: { title: 'PRIVATE WORK' },
      title: 'PRIVATE TITLE', encryption: 'ready', availability: 'complete',
    };
    const redacted = redactVoiceToolResultValue(awareness, {
      ...SHARE_ALL, shareSessionSummary: false, sharePermissionRequests: false,
    });
    expect(JSON.stringify(redacted)).not.toContain('permission_required');
    expect(JSON.stringify(redacted)).not.toContain('action_required');
    expect(JSON.stringify(redacted)).not.toContain('PRIVATE WORK');
    expect(redacted).toMatchObject({ operational: { primary: 'working', reasons: ['working'] } });
    expect(awareness.operational.primary).toBe('action_required');
  });
  it.each([
    undefined,
    null,
    {
      shareFilePaths: 'true',
      shareSessionSummary: 'true',
      sharePermissionRequests: 'true',
    },
    {
      shareFilePaths: 1,
      shareSessionSummary: 1,
      sharePermissionRequests: 1,
    },
  ])('fails closed for omitted or malformed redaction prefs=%p', (privacyPrefs) => {
    const result = Reflect.apply(redactVoiceToolResultValue, undefined, [
      {
        title: 'PRIVATE SESSION TITLE',
        locationLabel: 'PRIVATE LOCATION LABEL',
        path: '/Users/alice/Company/PrivateProject/README.md',
        requestId: 'PRIVATE_REQUEST_ID',
        safe: 'visible',
      },
      privacyPrefs,
    ]);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('PRIVATE SESSION TITLE');
    expect(serialized).not.toContain('PRIVATE LOCATION LABEL');
    expect(serialized).not.toContain('/Users/alice/Company/PrivateProject/README.md');
    expect(serialized).not.toContain('PRIVATE_REQUEST_ID');
    expect(serialized).toContain('visible');
  });

  it('drops session titles (summaries) when shareSessionSummary is false', () => {
    const result = redactVoiceToolResultValue(
      { ok: true, session: { id: 's1', title: 'Secret Summary', serverName: 'Box' } },
      { ...SHARE_ALL, shareSessionSummary: false },
    ) as { session: Record<string, unknown> };

    expect(result.session.title).toBeUndefined();
    expect(result.session.id).toBe('s1');
    expect(result.session.serverName).toBe('Box');
  });

  it('drops session titles nested inside session arrays', () => {
    const result = redactVoiceToolResultValue(
      { ok: true, sessions: [{ id: 's1', title: 'Secret A' }, { id: 's2', title: 'Secret B' }] },
      { ...SHARE_ALL, shareSessionSummary: false },
    ) as { sessions: Array<Record<string, unknown>> };

    expect(result.sessions[0]!.title).toBeUndefined();
    expect(result.sessions[1]!.title).toBeUndefined();
    expect(result.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('keeps session titles when shareSessionSummary is true', () => {
    const result = redactVoiceToolResultValue(
      { ok: true, session: { id: 's1', title: 'Visible Summary' } },
      SHARE_ALL,
    ) as { session: Record<string, unknown> };

    expect(result.session.title).toBe('Visible Summary');
  });

  it('drops session summary keys under label/name aliases when shareSessionSummary is false (X-L2)', () => {
    const result = redactVoiceToolResultValue(
      { ok: true, sessions: [{ id: 's1', label: 'Secret Label' }, { id: 's2', name: 'Secret Name' }] },
      { ...SHARE_ALL, shareSessionSummary: false },
    ) as { sessions: Array<Record<string, unknown>> };

    expect(result.sessions[0]!.label).toBeUndefined();
    expect(result.sessions[1]!.name).toBeUndefined();
    expect(result.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('keeps label/name session keys when shareSessionSummary is true', () => {
    const result = redactVoiceToolResultValue(
      { ok: true, session: { id: 's1', label: 'Visible Label', name: 'Visible Name' } },
      SHARE_ALL,
    ) as { session: Record<string, unknown> };

    expect(result.session.label).toBe('Visible Label');
    expect(result.session.name).toBe('Visible Name');
  });

  it('drops location labels and redacts path-like strings when shareFilePaths is false', () => {
    const result = redactVoiceToolResultValue(
      { ok: true, session: { id: 's1', locationLabel: 'voice-agent' }, path: '/Users/leeroy/secret' },
      { ...SHARE_ALL, shareFilePaths: false },
    ) as { session: Record<string, unknown>; path: string };

    expect(result.session.locationLabel).toBeUndefined();
    expect(result.path).toBe('<path_redacted>');
  });

  it('drops pending permission-request identifiers when sharePermissionRequests is false', () => {
    const result = redactVoiceToolResultValue(
      {
        ok: true,
        sessionId: 's1',
        permissionRequestIds: ['req_1', 'req_2'],
        requestId: 'req_single',
        requestIds: ['req_3', 'req_4'],
      },
      { ...SHARE_ALL, sharePermissionRequests: false },
    ) as { permissionRequestIds?: unknown; requestId?: unknown; requestIds?: unknown; sessionId: string };

    expect(result.permissionRequestIds).toBeUndefined();
    expect(result.requestId).toBeUndefined();
    expect(result.requestIds).toBeUndefined();
    expect(result.sessionId).toBe('s1');
  });

  it('withholds released digest request state, not only identities, when sharing is disabled', () => {
    // The released digest is the other representation of the same Action as awareness above, so
    // it must not disclose the pending request that awareness hides (`ui-web-v0.2.11` behavior).
    const digest = projectSessionActivityCompatibilityV1({
      awareness: {
        v: 1, sessionId: 's1', lifecycle: 'active', runtime: 'waiting', freshness: 'live',
        operational: {
          primary: 'action_required',
          reasons: ['action_required', 'permission_required', 'working'],
        },
        encryption: 'plain', availability: 'complete',
      },
      facts: {
        presence: 'online', active: true, thinking: false, updatedAt: 123,
        permissionRequestIds: ['req_1'],
      },
    });
    expect(digest).toMatchObject({ permissionRequired: true, actionRequired: true, blocked: true });

    const result = redactVoiceToolResultValue(
      digest,
      { ...SHARE_ALL, sharePermissionRequests: false },
    ) as Record<string, unknown>;

    expect(result.permissionRequestIds).toBeUndefined();
    expect(result).toMatchObject({
      ok: true, sessionId: 's1', presence: 'online', active: true, updatedAt: 123,
      // Working is an operational fact of its own and survives the pending-request gate.
      working: true, permissionRequired: false, actionRequired: false, blocked: false,
    });
  });

  it('withholds released digest pending-request counts when sharing is disabled', () => {
    const result = redactVoiceToolResultValue(
      {
        ok: true, sessionId: 's1', active: true, updatedAt: 123,
        pendingCount: 2, pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 1,
      },
      { ...SHARE_ALL, sharePermissionRequests: false },
    ) as Record<string, unknown>;

    expect(result.pendingPermissionRequestCount).toBeUndefined();
    expect(result.pendingUserActionRequestCount).toBeUndefined();
    // `pendingCount` is queued user input, not a pending agent request, so it is not gated here.
    expect(result).toMatchObject({ ok: true, sessionId: 's1', active: true, updatedAt: 123, pendingCount: 2 });
  });

  it('keeps released digest request state when sharePermissionRequests is true', () => {
    const digest = projectSessionActivityCompatibilityV1({
      awareness: {
        v: 1, sessionId: 's1', lifecycle: 'active', runtime: 'waiting', freshness: 'live',
        operational: { primary: 'permission_required', reasons: ['permission_required'] },
        encryption: 'plain', availability: 'complete',
      },
      facts: {
        presence: 'online', active: true, thinking: false, updatedAt: 123,
        permissionRequestIds: ['req_1'],
      },
    });

    expect(redactVoiceToolResultValue(digest, SHARE_ALL)).toMatchObject({
      permissionRequired: true, blocked: true, permissionRequestIds: ['req_1'],
    });
  });

  it('keeps permission-request identifiers when sharePermissionRequests is true', () => {
    const result = redactVoiceToolResultValue(
      { ok: true, permissionRequestIds: ['req_1'] },
      SHARE_ALL,
    ) as { permissionRequestIds: string[] };

    expect(result.permissionRequestIds).toEqual(['req_1']);
  });

  it('fails closed instead of leaking gated values beyond the traversal depth limit', () => {
    let nested: Record<string, unknown> = {
      permissionRequestIds: ['req_deep_secret'],
      title: 'Deep secret session summary',
      path: '/Users/alice/private/deep-secret.txt',
    };
    for (let depth = 0; depth < 24; depth += 1) {
      nested = { child: nested };
    }

    const result = redactVoiceToolResultValue(
      nested,
      {
        shareFilePaths: false,
        shareSessionSummary: false,
        sharePermissionRequests: false,
      },
    );
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('req_deep_secret');
    expect(serialized).not.toContain('Deep secret session summary');
    expect(serialized).not.toContain('/Users/alice/private/deep-secret.txt');
  });
});

describe('redactVoiceToolResultForProvider', () => {
  it('keeps explicitly-authorized current UI labels independent from session-summary sharing', () => {
    const result = redactVoiceToolResultForProvider(
      'readCurrentUiContext',
      {
        navigation: { area: 'plugin', screen: 'detail', title: 'Triage issue' },
        entity: { kind: 'github_issue', label: 'happier#123' },
        commands: [{ id: 'open-124', title: 'Open issue #124' }],
        detail: { path: '/Users/alice/private-repo/issue.md' },
      },
      {
        ...SHARE_ALL,
        shareFilePaths: false,
        shareSessionSummary: false,
      },
    );

    expect(result).toEqual({
      navigation: { area: 'plugin', screen: 'detail', title: 'Triage issue' },
      entity: { kind: 'github_issue', label: 'happier#123' },
      commands: [{ id: 'open-124', title: 'Open issue #124' }],
      detail: { path: '<path_redacted>' },
    });
  });

  it('projects Action and current-UI command outcomes to a bounded public settlement', () => {
    const invokeActionTool = getActionSpec('action.invoke').bindings?.voiceClientToolName;
    const invokeCurrentUiCommandTool = getActionSpec('ui.current_context.command.invoke')
      .bindings?.voiceClientToolName;
    if (!invokeActionTool || !invokeCurrentUiCommandTool) {
      throw new Error('Expected canonical Voice tool bindings');
    }

    const privateResult = {
      ok: false,
      errorCode: 'stale_surface',
      errorMessage: 'raw provider failure: credential=private-token',
      result: {
        credential: { token: 'private-token' },
        providerId: 'private-provider',
        connectionId: 'private-connection',
        originalInput: { body: 'private action body' },
        error: { message: 'raw provider failure' },
      },
      action: { pluginId: 'acme.triage', localId: 'comment' },
      commandId: 'current-ui-command:private-selection',
    };

    expect(redactVoiceToolResultForProvider(invokeActionTool, privateResult, SHARE_ALL)).toEqual({
      ok: false,
      errorCode: 'stale_surface',
      errorMessage: 'stale_surface',
    });
    expect(redactVoiceToolResultForProvider(invokeCurrentUiCommandTool, {
      ...privateResult,
      ok: true,
    }, SHARE_ALL)).toEqual({ ok: true });
    expect(redactVoiceToolResultForProvider(invokeActionTool, {
      ok: false,
      errorCode: 'tool_cancelled',
      errorMessage: 'raw cancellation diagnostics',
    }, SHARE_ALL)).toEqual({
      ok: false,
      errorCode: 'tool_cancelled',
      errorMessage: 'tool_cancelled',
    });
    expect(redactVoiceToolResultForProvider(invokeActionTool, {
      ok: false,
      errorCode: 'outcome_unknown',
      errorMessage: 'private issued Action diagnostics',
    }, SHARE_ALL)).toEqual({
      ok: false,
      errorCode: 'outcome_unknown',
      errorMessage: 'outcome_unknown',
    });

    // Ordinary read-only tool results can legitimately carry identifiers; the
    // Action projection must not turn into a global identifier scrubber.
    expect(redactVoiceToolResultForProvider('getSessionSummary', {
      ok: true,
      providerId: 'visible-provider',
      connectionId: 'visible-connection',
    }, SHARE_ALL)).toEqual({
      ok: true,
      providerId: 'visible-provider',
      connectionId: 'visible-connection',
    });
  });
});
