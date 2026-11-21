import { describe, expect, it } from 'vitest';
import { getActionSpec} from '@happier-dev/protocol/actions/actionSpecs';
import { UiActionDispatchResultV1Schema } from '@happier-dev/protocol/actions/clientDispatchV1';
import { serializeVoiceActionExecuteResult } from '@/voice/tools/voiceActionResult';
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
  it('projects inventory labels without descriptions, refs or connection details', () => {
    const result = redactVoiceToolResultForProvider('listAgentModels', {
      items: [{ modelId: 'model', label: 'Model', providerConnectionId: 'private-connection', providerName: 'Private name', description: 'Private description' }],
      hasMore: true, nextCursor: 'private-model-cursor', totalCount: 12,
    }, { ...SHARE_ALL, shareSessionSummary: false, shareDeviceInventory: true });
    expect(result).toEqual({ items: [{ label: 'Model' }], hasMore: true, totalCount: 12 });
    // Inventory permission is not permission to disclose a Session summary
    // nested in another inventory-family Action's result.
    expect(redactVoiceToolResultForProvider('projects.open', { session: { id: 's1', title: 'PRIVATE SESSION' } }, {
      ...SHARE_ALL, shareSessionSummary: false, shareDeviceInventory: true,
    })).toEqual({ session: { id: 's1' } });
  });

  it.each(['provider_model_ambiguous', 'provider_model_not_found'])(
    'shares only permitted spawn labels for %s', errorCode => {
      const team = (resourceId: string) => ({ source: 'team_resource', teamId: 'private-team', resourceId,
        expectedResourceRevision: 1, deliveryMode: 'brokered', agentTargetKey: 'agent:codex', modelId: 'private-team-model' });
      const personal = { agentTargetKey: 'agent:codex', providerConnectionId: 'private-personal-id', modelId: 'private-personal-model' };
      const failure = { ok: false as const, errorCode, error: errorCode, details: {
        candidates: [
          { value: team('secret-resource-1'), label: 'Shared Model', description: 'Private Team credential name' },
          { value: team('secret-resource-2'), label: 'Shared Model', description: 'Other Team credential name' },
          { value: personal, label: 'Shared Model', description: 'Private Personal connection name' },
          { value: 'native-opaque-id', label: 'Another Model' },
          { value: 'slash-model-id', label: 'src/private.json' },
        ],
        session: { title: 'PRIVATE TITLE' },
      } };
      const prefs = { ...SHARE_ALL, shareSessionSummary: false, shareDeviceInventory: true, shareFilePaths: false };
      for (const canonicalResult of [false, true]) {
        const redact = canonicalResult ? redactVoiceActionExecutionResultForProvider : redactVoiceToolResultForProvider;
        const result: unknown = JSON.parse(serializeVoiceActionExecuteResult('session.spawn_new', failure, { canonicalResult }));
        const projected = redact('spawnSession', result, prefs);
        expect(projected).toEqual({ ok: false, errorCode, error: errorCode, details: {
          candidates: [{ label: 'Shared Model Team', needsModelPicker: true }, { label: 'Shared Model Personal' }, { label: 'Another Model' }],
        } });
        const retained = redact('spawnSession', result, { ...prefs, shareFilePaths: true });
        expect(retained).toMatchObject({ details: {
          candidates: expect.arrayContaining([{ label: 'src/private.json' }]),
        } });
        // Local effect custody projects on settlement and again before provider delivery.
        expect(redact('spawnSession', retained, prefs)).toEqual(projected);
        for (const shareDeviceInventory of [false, undefined, 'true']) {
          expect(Reflect.apply(redact, undefined, ['spawnSession', result, { ...prefs, shareDeviceInventory }]))
            .toMatchObject({ errorCode, details: { candidates: [] } });
        }
      }
    },
  );

  it('preserves slash-separated prose and dates in ordinary tool results with private paths', () => {
    const sample = { message: 'Use and/or in the update due 11/20.' };
    expect(redactVoiceToolResultForProvider('spawnSession', { sample }, {
      ...SHARE_ALL, shareFilePaths: false,
    })).toEqual({ sample });
  });

  it.each(['agents.models.available', 'teams.credential_models.available'])(
    'applies inventory consent and label-only projection to %s lookups', optionsSourceId => {
      const result = { ok: true, optionsSourceId, options: [{ value: 'private-ref', label: 'Model', description: 'Private' }],
        modelCatalog: { private: 'private-ref' }, machineRecipeDetails: { accountId: 'private-account' } };
      expect(redactVoiceToolResultForProvider('resolveActionOptions', result, { ...SHARE_ALL, shareDeviceInventory: true }))
        .toEqual({ ok: true, optionsSourceId, options: [{ label: 'Model' }] });
      expect(redactVoiceToolResultForProvider('resolveActionOptions', result, SHARE_ALL))
        .toMatchObject({ errorCode: 'privacy_disabled' });
      expect(redactVoiceActionExecutionResultForProvider('resolveActionOptions', { ok: true, result }, SHARE_ALL))
        .toEqual({ ok: false, errorCode: 'privacy_disabled', error: 'privacy_disabled' });
    },
  );

  it.each([
    ['sessions.spawn.machines.available', 'Studio Computer', 'private-machine-id'],
    ['host-input:machine', 'Studio Computer', { machineId: 'private-machine-id', serverId: 'private-home' }],
    ['sessions.spawn.paths.recent', 'Private Workspace', '{"kind":"path","path":"/home/example/private-workspace"}'],
    ['host-input:workspace', 'Private Workspace', { path: '/home/example/private-workspace' }],
    ['sessions.spawn.connected_services.available', 'Work Account', 'service:profile:private-profile'],
    ['session.connected_services_auth.available', 'Work Account', { profileId: 'private-profile' }],
    ['sessions.spawn.profiles.available', 'Work Profile', 'private-profile'],
  ])('withholds %s choices without explicit inventory sharing', (optionsSourceId, label, value) => {
    const result = { optionsSourceId, options: [{ label, value, description: 'PRIVATE DESCRIPTION' }] };
    for (const shareDeviceInventory of [false, undefined, 'true']) {
      for (const shareSessionSummary of [false, true]) {
        for (const shareFilePaths of [false, true]) {
          const prefs = { ...SHARE_ALL, shareDeviceInventory, shareSessionSummary, shareFilePaths };
          const direct = Reflect.apply(redactVoiceToolResultForProvider, undefined, ['resolveActionOptions', result, prefs]);
          const wrapped = Reflect.apply(redactVoiceActionExecutionResultForProvider, undefined,
            ['action.options.resolve', { ok: true, result }, prefs]);
          expect(JSON.parse(JSON.stringify(direct))).toEqual({
            ok: false, errorCode: 'privacy_disabled', errorMessage: 'privacy_disabled',
          });
          expect(JSON.parse(JSON.stringify(wrapped))).toEqual({
            ok: false, errorCode: 'privacy_disabled', error: 'privacy_disabled',
          });
        }
      }
    }
  });

  it.each([false, true])('retains connected-account selection without sending provider email (summaries=%s)', shareSessionSummary => {
    const result = {
      supportedServiceIds: ['happier.openai/account'],
      profileOptionsByServiceId: { 'happier.openai/account': [
        { profileId: 'work', label: 'Work Account', providerEmail: 'private@example.test', status: 'connected' },
        { profileId: 'personal', providerEmail: 'personal@example.test', status: 'connected' },
        { profileId: 'email-label', label: 'label@example.test', status: 'connected' },
      ] },
      groupOptionsByServiceId: { 'happier.openai/account': [{ groupId: 'group', label: 'Work Pool', providerEmail: 'group@example.test' }] },
      items: [{ value: 'happier.openai/account:profile:personal', label: 'personal@example.test' }],
      agentId: 'private-agent',
    };
    for (const shareFilePaths of [false, true]) {
      const prefs = { ...SHARE_ALL, shareSessionSummary, shareFilePaths, shareDeviceInventory: true };
      const projected = redactVoiceToolResultForProvider('listSpawnConnectedServices', result, prefs);
      const serialized = JSON.stringify(projected);
      expect(serialized).not.toContain('@example.test');
      expect(serialized).not.toContain('private-agent');
      expect(JSON.parse(serialized)).toEqual({
        supportedServiceIds: ['happier.openai/account'],
        profileOptionsByServiceId: { 'happier.openai/account': [
          { profileId: 'work', label: 'Work Account', status: 'connected' },
          { profileId: 'personal', status: 'connected' },
          { profileId: 'email-label', status: 'connected' },
        ] },
        groupOptionsByServiceId: { 'happier.openai/account': [{ groupId: 'group', label: 'Work Pool' }] },
      });
      expect(redactVoiceActionExecutionResultForProvider('sessions.spawn.connected_services.list', { ok: true, result }, prefs))
        .toEqual({ ok: true, result: projected });
      expect(redactVoiceToolResultForProvider('listSpawnConnectedServices', projected, prefs)).toEqual(projected);
      for (const shareDeviceInventory of [false, undefined, 'true']) {
        expect(Reflect.apply(redactVoiceToolResultForProvider, undefined, [
          'listSpawnConnectedServices', result, { ...prefs, shareDeviceInventory },
        ])).toMatchObject({ ok: false, errorCode: 'privacy_disabled' });
      }
    }
  });

  it('keeps a connected-account refusal valid for wrapped delivery without diagnostics', () => {
    const failure = { ok: false, errorCode: 'unknown_agent', error: 'PRIVATE ERROR', details: { secret: 'PRIVATE DETAIL' } };
    const execution = redactVoiceActionExecutionResultForProvider('listSpawnConnectedServices', failure, {
      ...SHARE_ALL, shareDeviceInventory: true,
    });
    expect(UiActionDispatchResultV1Schema.parse({ v: 1, execution }).execution).toEqual({
      ok: false, errorCode: 'unknown_agent', error: 'unknown_agent',
    });
  });

  it('keeps non-inventory action options available with inventory sharing off', () => {
    const result = { optionsSourceId: null, options: [{ label: 'Manual', value: 'manual' }] };
    expect(redactVoiceToolResultForProvider('resolveActionOptions', result, {
      ...SHARE_ALL, shareDeviceInventory: false,
    })).toEqual(result);
  });

  it('withholds a connected account email even when the options source uses it as a label', () => {
    const result = { optionsSourceId: 'sessions.spawn.connected_services.available', options: [
      { value: 'happier.openai/account:profile:work', label: 'Work Account' },
      { value: 'happier.openai/account:profile:personal', label: 'person@example.test' },
    ] };
    expect(redactVoiceToolResultForProvider('resolveActionOptions', result, {
      ...SHARE_ALL, shareSessionSummary: false, shareFilePaths: false, shareDeviceInventory: true,
    })).toEqual({ optionsSourceId: result.optionsSourceId, options: [
      { value: 'happier.openai/account:profile:work', label: 'Work Account' },
      { value: 'happier.openai/account:profile:personal' },
    ] });
  });

  it('retains incompleteness in model options and withholds opaque cursor values', () => {
    const result = { optionsSourceId: 'agents.models.available', options: [{ value: 'private-ref', label: 'Model' }],
      hasMore: true, nextCursor: 'private-model-cursor', totalCount: 3 };
    const prefs = { ...SHARE_ALL, shareDeviceInventory: true };
    expect(redactVoiceActionExecutionResultForProvider('action.options.resolve', { ok: true, result }, prefs))
      .toEqual({ ok: true, result: { optionsSourceId: 'agents.models.available', options: [{ label: 'Model' }], hasMore: true, totalCount: 3 } });
  });

  it('projects runner catalog titles and the task result without selectors or refs', () => {
    const prefs = { ...SHARE_ALL, shareDeviceInventory: true };
    expect(redactVoiceToolResultForProvider('listAgentModels', { ok: true, items: [], scmDiffSummaryCatalog: {
      profiles: [{ title: 'Model', catalogId: 'secret-catalog-id', modelSelector: { providerConnectionId: 'private-ref' } }],
      automaticProfiles: [], discoveryTargetKeys: ['hidden-agent-key'],
    } }, prefs)).toEqual({ ok: true, items: [], scmDiffSummaryCatalog: { profiles: [{ title: 'Model' }], automaticProfiles: [] } });
    expect(redactVoiceToolResultForProvider('listAgentModels', { ok: true, source: 'auto', title: 'Agent and model',
      runner: { modelSelection: { providerConnectionId: 'private-ref' } },
    }, prefs)).toEqual({ ok: true, source: 'auto', title: 'Agent and model' });
  });

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
