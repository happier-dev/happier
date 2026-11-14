import { describe, expect, it } from 'vitest';

import { classifyPrimarySessionRuntimeIssue, readSessionPreparationFailureDiagnostic } from './classifyPrimarySessionRuntimeIssue';
import { PromptStackPreparationError } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import { HomeTargetResolutionError } from '@happier-dev/cli-common/homeTarget';
import { AxiosError, AxiosHeaders } from 'axios';
import { createHttpStatusError } from '@/api/client/httpStatusError';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { AccountEncryptionCurrentnessUnavailableError } from '@/api/client/accountEncryptionCurrentness';
import { McpServerCatalogUnavailableError } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { PluginError } from '@happier-dev/plugin-sdk';
import { StructuredInputComposerAttachmentResolutionError, StructuredInputComposerAttachmentUnavailableError } from '@/agent/runtime/turns/resolveStructuredInputProviderContext';

describe('classifyPrimarySessionRuntimeIssue', () => {
  it.each(['pi_provider_session_error', 'opencode_provider_session_error'])('retains native turn failure provenance for %s', code => {
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', occurredAt: 100,
      error: { code, severity: 'error', message: 'terminated', details: { source: 'agent_session_error' } } });
    expect(issue).toMatchObject({ source: 'agent_session_error', code,
      failureCause: { phase: 'turn', failureReason: 'unclassified_provider_error', providerErrorCode: code } });
    const classified = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', occurredAt: 100,
      error: { code, severity: 'error', details: { failureCause: {
        phase: 'turn_start', failureReason: 'permission_denied', code: 'client_attestation_denied',
      } } } });
    expect(classified.failureCause).toMatchObject({ phase: 'turn_start', failureReason: 'permission_denied',
      code: 'client_attestation_denied' });
  });
  it.each([
    ['Authentication required PRIVATE_DEVICE_CODE', 'acp_session_start_failed', 'provider_endpoint_auth_required', 'authentication_required'],
    ['FX requires an access token with a known, current expiry. Refresh the Connected Account and retry. PRIVATE_TOKEN', 'fx_connected_account_expiry_unavailable', 'provider_endpoint_auth_required', 'auth_expired'],
    // A typed Provider refusal retains its canonical code instead of being reclassified from native prose.
    ['The selected Muse model is unavailable in the native catalog. PRIVATE_MODEL', 'model_selection_required', 'model_selection_required', undefined],
    ['OpenCode model "PRIVATE_MODEL" is not selectable', undefined, 'agent_startup_model_reconciliation_failed', 'model_selection_required'],
  ] as const)('classifies native construction without persisting provider prose (%s)', (message, code, expectedCode, failureReason) => {
    const error = code === 'acp_session_start_failed'
      ? { code, severity: 'error', message, details: { requestErrorCode: -32000 } }
      : code ? new PluginError({ code, message }) : new Error(message);
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', startupPhase: 'client_start', error, occurredAt: 100 });
    expect(issue).toMatchObject({ code: expectedCode, failureCause: { phase: 'client_start',
      ...(failureReason === undefined ? {} : { failureReason }),
      ...(message.startsWith('OpenCode model') ? { code: 'native_model_not_selectable' } : {}),
    } });
    expect(JSON.stringify(issue)).not.toContain('PRIVATE_');
    expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', occurredAt: 100,
      error: { code: issue.code, severity: 'error', details: { v: 1, source: issue.source, failureCause: issue.failureCause } } }))
      .toEqual(issue);
  });

  it.each(['plugin_exec_system_tool_resolution_unavailable', 'plugin_exec_managed_dependency_resolution_unavailable', 'native_adapter_invocation_unavailable'])(
    'retains the typed %s construction cause without exposing arbitrary PluginError text', code => {
      const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'copilot',
        startupPhase: 'client_start', occurredAt: 100,
        error: new PluginError({ code, message: 'PRIVATE_NATIVE_ENVIRONMENT' }) });
      expect(issue).toMatchObject({ code, source: 'agent_session_error',
        failureCause: { phase: 'client_start', failureReason: 'unclassified_provider_error' } });
      expect(issue.sanitizedPreview).toMatch(/executable resolution|native runtime invocation/);
      expect(JSON.stringify(issue)).not.toContain('PRIVATE_NATIVE_ENVIRONMENT');
      const republished = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'copilot',
        occurredAt: 100, error: { code: issue.code, severity: 'error',
          details: { v: 1, source: issue.source, failureCause: issue.failureCause } } });
      expect(republished).toEqual(issue);
    },
  );
  it('retains the native failure phase when construction supplies a fallback phase', () => {
    const failureCause = { code: 'agent_startup_transport_failed', phase: 'thread_open' as const,
      failureReason: 'unclassified_provider_error' as const };
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', startupPhase: 'client_start',
      error: new PluginError({ code: failureCause.code, message: 'PRIVATE_NATIVE_CONTEXT', details: { failureCause } }) });
    expect(issue.failureCause).toEqual(failureCause);
    expect(JSON.stringify(issue)).not.toContain('PRIVATE_NATIVE_CONTEXT');
  });
  it.each(['codex', 'claude', 'opencode'] as const)('keeps %s model refusal out of account recovery metadata', (provider) => {
    const issue = classifyPrimarySessionRuntimeIssue({ provider, cause: 'session_error', occurredAt: 1_000,
      error: { code: 'provider_model_not_found', details: { v: 1, source: 'agent_status_error',
        runtimeAuthClassification: { kind: 'plan', serviceId: 'happier.agent.codex/openai-codex',
          profileId: '705530f2-81e8-4ba2-bc7b-7929a4b95b5a', groupId: 'pool',
          quotaScope: 'model', providerLimitId: 'gpt-6.1-sol', limitCategory: 'plan_invalid',
          connectedServiceRecovery: 'available', resetsAtMs: null, rateLimits: null,
          source: 'structured_provider_error' },
      } },
    });
    expect(issue.code).toBe('provider_model_not_found');
    expect(issue.usageLimit?.connectedService).toBeUndefined();
    expect(issue.usageLimit?.recoverability).not.toBe('switch_account');
  });
  it.each(['agent_startup_transport_failed', 'PLUGIN_EXEC_CLIENT_REQUEST_TIMEOUT'])(
    'retains a sanitized native startup reason for %s through issue republication', code => {
      const failureCause = { code, phase: 'client_start', failureReason: 'unclassified_provider_error',
        providerErrorMessage: 'agent_launch_failed stage=exec errno=EACCES; Bearer synthetic-private-token' };
      const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'codex', occurredAt: 100,
        error: { code, message: 'PRIVATE_OUTER_MESSAGE', details: { v: 1, source: 'agent_session_error', failureCause } } });
      expect(issue.sanitizedPreview).toContain('stage=exec errno=EACCES');
      expect(issue.sanitizedPreview).not.toContain('synthetic-private-token');
      expect(JSON.stringify(issue)).not.toContain('synthetic-private-token');
      expect(issue.sanitizedPreview).not.toContain('PRIVATE_OUTER_MESSAGE');
      const published = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'codex', occurredAt: 100,
        error: { code: issue.code, details: { v: 1, source: issue.source, failureCause: issue.failureCause } } });
      expect(published.sanitizedPreview).toBe(issue.sanitizedPreview);
    },
  );

  it.each([new Error('PRIVATE_PREPARATION_DETAILS'), new StructuredInputComposerAttachmentUnavailableError()])(
    'keeps a failed host preparation out of Provider outage classification', (error) => {
      const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'codex',
        error, preparingPrompt: true, occurredAt: 100 });
      expect(issue).toMatchObject({ code: 'preparation_pending', source: 'dependency_failure' });
      expect(issue.sanitizedPreview).toMatch(/prompt.*prepared/iu);
      expect(JSON.stringify(issue)).not.toContain('PRIVATE_');
      const published = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'codex',
        error: { code: issue.code, details: { v: 1, source: issue.source } }, occurredAt: 100 });
      expect(published).toEqual(issue);
    },
  );
  it('preserves an actual Provider refusal and an unlocated native failure', () => {
    const error = createProviderErrorV1('provider_endpoint_rate_limited');
    const base = { cause: 'session_error' as const, provider: 'codex', occurredAt: 100 };
    expect(classifyPrimarySessionRuntimeIssue({ ...base, error, preparingPrompt: true }))
      .toEqual(classifyPrimarySessionRuntimeIssue({ ...base, error }));
    expect(classifyPrimarySessionRuntimeIssue({ ...base, error: new Error('PRIVATE_NATIVE_DETAILS') }))
      .toMatchObject({ code: 'agent_session_error', source: 'agent_session_error' });
  });
  it('uses the structured-input owner retryability for a definitive attachment refusal', () => {
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'codex',
      error: new StructuredInputComposerAttachmentResolutionError('composer_attachment_resolution_invalid', false, 'PRIVATE_INPUT') });
    expect(issue).toMatchObject({ code: 'attachment_unavailable', source: 'dependency_failure' });
    expect(JSON.stringify(issue)).not.toContain('PRIVATE_INPUT');
  });
  it('retains the safe attachment subcause through runtime diagnostic publication', () => {
    const preparationCause = { code: 'triage_account_storage_unavailable', stage: 'dispatch' as const };
    const input = { cause: 'session_error' as const, provider: 'codex', occurredAt: 100 };
    const issue = classifyPrimarySessionRuntimeIssue({ ...input,
      error: new StructuredInputComposerAttachmentResolutionError('composer_attachment_resolution_failed', true,
        'PRIVATE_ATTACHMENT_AND_CREDENTIAL', preparationCause) });
    expect(issue).toMatchObject({ code: 'preparation_pending', source: 'dependency_failure',
      failureCause: { phase: 'turn_start', failureReason: 'unknown', preparationCause } });
    const published = classifyPrimarySessionRuntimeIssue({ ...input, error: {
      code: issue.code, details: { v: 1, source: issue.source, failureCause: issue.failureCause },
    } });
    expect(published).toEqual(issue);
    expect(JSON.stringify(issue)).not.toContain('PRIVATE_');
  });
  it('retains the closed isolation refusal as the startup cause with visible owner remediation', () => {
    const error = new PluginError({ code: 'agent_isolation_unavailable', retryable: false,
      message: 'PRIVATE_MACHINE_DETAILS' });
    expect(readSessionPreparationFailureDiagnostic(error)).toEqual({
      originalCode: 'agent_isolation_unavailable', reason: 'agent_isolation_unavailable', contextSource: 'unknown',
    });
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error, occurredAt: 100 });
    expect(issue).toMatchObject({ code: 'agent_isolation_unavailable' });
    expect(issue.sanitizedPreview).toContain('machine owner');
    expect(JSON.stringify(issue)).not.toContain('PRIVATE_');
  });
  it('keeps plugin-projected startup auth recovery through a retained failure diagnostic', () => {
    const input = { cause: 'session_error' as const, provider: 'codex', occurredAt: 100 };
    const original = classifyPrimarySessionRuntimeIssue({ ...input, error: new PluginError({
      code: 'codex_refresh_free_auth_unsupported', retryable: false,
      details: { source: 'auth_error', reason: 'workspace_incompatible', failureCause: {
        phase: 'authentication', failureReason: 'unknown', reason: 'workspace_incompatible',
        providerErrorMessage: 'The selected account does not match this workspace. Sign in with the required account.',
      } },
    }) });
    expect(original.failureCause).toMatchObject({ reason: 'workspace_incompatible' });
    const retained = classifyPrimarySessionRuntimeIssue({ ...input, error: {
      code: original.code, severity: 'error',
      details: { v: 1, source: original.source, failureCause: original.failureCause },
    } });
    expect(retained).toEqual(original);
    expect(retained.sanitizedPreview).toContain('workspace');
  });
  it.each([
    ['project_requester_credentials_unavailable', 'ingress_missing'],
    ['project_finite_execution_unavailable', 'finite_runtime_unavailable'],
  ])('retains the closed Plugin Exec refusal reason for %s without plugin payloads or accessor reads', (code, reason) => {
    const failure = new PluginError({ code,
      message: 'PRIVATE_PLUGIN_MESSAGE', retryable: false,
      details: { cause: { code: reason, stage: 'dispatch' }, private: 'PRIVATE_PLUGIN_DETAILS' } });
    expect(readSessionPreparationFailureDiagnostic(failure)).toEqual({
      originalCode: failure.code, reason, contextSource: 'unknown',
    });
    for (const cause of [undefined, null, 'PRIVATE_PLUGIN_DETAILS',
      Object.assign([], { code: 'ingress_missing' }), { code: 'PRIVATE_PLUGIN_REASON' },
      Object.defineProperty({}, 'code', { get() { throw new Error('Unexpected cause getter'); } })]) {
      const opaque = new PluginError({ code: failure.code, retryable: false });
      Object.defineProperty(opaque, 'details', { value: { cause } });
      expect(readSessionPreparationFailureDiagnostic(opaque)).toEqual({
        originalCode: failure.code, reason: 'unknown', contextSource: 'unknown',
      });
    }
    const accessor = Object.defineProperty(new PluginError({ code: failure.code, retryable: false }),
      'details', { get() { throw new Error('Unexpected plugin details getter'); } });
    expect(readSessionPreparationFailureDiagnostic(accessor)).toEqual({
      originalCode: failure.code, reason: 'unknown', contextSource: 'unknown',
    });
    const causeAccessor = new PluginError({ code: failure.code, retryable: false });
    Object.defineProperty(causeAccessor, 'details', { value: Object.defineProperty({}, 'cause', {
      get() { throw new Error('Unexpected details cause getter'); },
    }) });
    expect(readSessionPreparationFailureDiagnostic(causeAccessor)).toEqual({
      originalCode: failure.code, reason: 'unknown', contextSource: 'unknown',
    });
    expect(readSessionPreparationFailureDiagnostic(new PluginError({ code: 'PRIVATE_PLUGIN_CODE',
      retryable: false, details: { cause: { code: 'ingress_missing', stage: 'dispatch' } } }))).toEqual({
      originalCode: 'unknown', reason: 'unknown', contextSource: 'unknown',
    });
    expect(readSessionPreparationFailureDiagnostic(new PluginError({ code: 'provider_connection_not_found',
      retryable: false, details: { cause: { code: reason, stage: 'dispatch' } } }))).toEqual({
      originalCode: 'provider_connection_not_found', reason: 'provider_connection_not_found', contextSource: 'unknown',
    });
    expect(readSessionPreparationFailureDiagnostic(Object.assign(failure, { reason: 'not-current' }))).toEqual({
      originalCode: failure.code, reason: 'not-current', contextSource: 'unknown',
    });
  });
  it('keeps native sign-in guidance distinct from Provider credential guidance through issue republication', () => {
    const diagnostic = { code: 'provider_endpoint_auth_required', severity: 'error', message: 'PRIVATE_BODY',
      details: { v: 1, source: 'auth_error' } };
    const native = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'codex', error: diagnostic, occurredAt: 100 });
    expect(native).toMatchObject({ code: diagnostic.code, source: 'auth_error',
      sanitizedPreview: 'Sign in to Codex or choose a Codex account.' });
    expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'codex', occurredAt: 100,
      error: Object.assign(new Error('PRIVATE_UPSTREAM_BODY'), { diagnostic }) })).toEqual(native);
    expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'codex', occurredAt: 100,
      error: { code: native.code, details: { v: 1, source: native.source } } })).toEqual(native);
    const provider = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'codex', occurredAt: 100,
      error: createProviderErrorV1('provider_endpoint_auth_required') });
    expect(provider).toMatchObject({ code: diagnostic.code, source: 'agent_session_error',
      sanitizedPreview: expect.stringContaining('The Provider endpoint requires a credential.') });
    expect(provider.sanitizedPreview).toContain('Add a Saved Secret to the Provider connection.');
    expect(JSON.stringify(native)).not.toContain('PRIVATE_');
  });
  it.each(['plugin_mcp_preparation_unavailable', 'agent_runtime_daemon_service_generation_not_current',
    'native_agent_privileged_effect_authority_unavailable', 'native_agent_privileged_effect_outcome_unknown', 'skills_unavailable',
    'agent_startup_model_reconciliation_failed'])(
    'publishes the closed preparation refusal %s without private plugin data', code => {
      const error = Object.assign(new Error('PRIVATE_BODY'), { code, details: { secret: 'PRIVATE_TOKEN' } });
      const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error, occurredAt: 100 });
      expect(issue).toMatchObject({ code, source: 'agent_session_error' });
      expect(JSON.stringify(issue)).not.toContain('PRIVATE');
      expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: {
        code: issue.code, details: { v: 1, source: issue.source },
      }, occurredAt: 100 })).toEqual(issue);
      expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: {
        code: `${code}_PRIVATE`,
      } }).code).toBe('agent_session_error');
    });
  it.each(['plugin_services_managed_provider_authority_unavailable', 'provider_endpoint_unavailable'])(
    'preserves the safe shared Provider startup cause %s through public issue publication', code => {
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error:
      Object.assign(new Error('private hub lease and access context'), { code }), occurredAt: 100 });
    expect(issue).toMatchObject({ code, source: 'agent_session_error' });
    expect(issue.sanitizedPreview).toMatch(/Provider.*retry/iu);
    expect(JSON.stringify(issue)).not.toContain('private');
    const published = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: {
      code: issue.code, details: { v: 1, source: issue.source },
    }, occurredAt: 100 });
    expect(published).toEqual(issue);
    expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error:
      Object.assign(new Error('private'), { code: `${code}_private` }) }).code).toBe('agent_session_error');
  });
  it.each(['provider_compatibility_unverified', 'provider_incompatible_with_agent'] as const)('retains %s through startup diagnostics and public issue publication', code => {
    const refusal = Object.assign(new Error('private upstream body'), createProviderErrorV1(code, { connectionId: 'private-resource' }));
    expect(readSessionPreparationFailureDiagnostic(refusal)).toEqual({
      originalCode: code, reason: code, contextSource: 'unknown',
    });
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: refusal, occurredAt: 100 });
    expect(issue).toMatchObject({ code, source: 'agent_session_error' });
    expect(issue.sanitizedPreview).toMatch(/compatib/iu);
    expect(JSON.stringify(issue)).not.toContain('private');
    expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: {
      code: issue.code, details: { v: 1, source: issue.source },
    }, occurredAt: 100 })).toEqual(issue);
  });
  it('lets required unreachable MCP preparation recover while real missing material remains closed', () => {
    expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: new McpServerCatalogUnavailableError('unreachable') }))
      .toMatchObject({ code: 'preparation_pending', source: 'dependency_failure' });
    expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: new McpServerCatalogUnavailableError('encryption-material-unavailable') }).code)
      .not.toBe('preparation_pending');
  });
  it.each(['ECONNRESET', 'ECONNABORTED'])('retains transient Account currentness %s as a Home preparation dependency', code => {
    const error = new AccountEncryptionCurrentnessUnavailableError(undefined, undefined, {
      cause: new AxiosError('private transport detail', code),
    });
    expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error }))
      .toMatchObject({ code: 'preparation_pending', source: 'dependency_failure' });
    expect(JSON.stringify(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error }))).not.toContain('private');
    expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: new AccountEncryptionCurrentnessUnavailableError(
      undefined, undefined, { cause: createHttpStatusError(403, 'refused') },
    ) }).code).not.toBe('preparation_pending');
  });
  it.each(['ECONNABORTED', 'ECONNRESET'])('classifies a Home %s as preparation while a foreign binding remains an Agent failure', code => {
    runWithServerHttpBaseUrl('https://home.example.test/happier', () => {
      const failure = new AxiosError('private transport detail', code, {
        url: 'https://home.example.test/happier/v1/access-keys/session/machine', headers: new AxiosHeaders(),
      });
      expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: failure }))
        .toMatchObject({ code: 'preparation_pending', source: 'dependency_failure' });
      failure.config!.url = 'https://home.example.test/happier-other/v1/access-keys/session/machine';
      expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: failure }))
        .toMatchObject({ code: 'agent_session_error', source: 'agent_session_error' });
    });
  });
  it('classifies responding Home bootstrap failures without treating native provider failures as Home preparation', () => {
    runWithServerHttpBaseUrl('https://home.example.test/happier', () => {
      const homeFailure = new AxiosError('private upstream detail', undefined,
        { url: 'https://home.example.test/happier/v1/machines', headers: new AxiosHeaders() }, undefined,
        { status: 503, data: { private: 'private body' }, statusText: '', headers: {}, config: { headers: new AxiosHeaders() } });
      for (const error of [homeFailure, createHttpStatusError(500, 'private Home detail'),
        new Error('private currentness wrapper', { cause: createHttpStatusError(503, 'private currentness detail') })]) {
        const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error });
        expect(issue).toMatchObject({ code: 'preparation_pending', source: 'dependency_failure' });
        expect(JSON.stringify(issue)).not.toContain('private');
      }
      const providerFailure = new AxiosError('provider unavailable', undefined,
        { url: 'https://provider.example.test/v1/messages', headers: new AxiosHeaders() }, undefined,
        { status: 503, data: {}, statusText: '', headers: {}, config: { headers: new AxiosHeaders() } });
      expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: providerFailure }))
        .toMatchObject({ code: 'agent_session_error', source: 'agent_session_error' });
      providerFailure.config!.url = 'https://home.example.test/happier-other/v1/messages';
      expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: providerFailure }).code)
        .toBe('agent_session_error');
      expect(classifyPrimarySessionRuntimeIssue({ cause: 'status_error', error: homeFailure }).code)
        .not.toBe('preparation_pending');
      for (const status of [401, 403, 404]) {
        expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: createHttpStatusError(status, 'refused') }).code)
          .not.toBe('preparation_pending');
      }
    });
  });
  it.each(['loading', 'source-unavailable', 'scope-retired', 'credentials-unavailable', 'account-mismatch', 'not-current'])('retains closed Role mutation diagnostics for %s', reason => {
    expect(readSessionPreparationFailureDiagnostic(Object.assign(new Error('private detail'), {
      code: 'account_role_overrides_unavailable', reason, contextSource: 'account_lifetime',
    }))).toEqual({ originalCode: 'account_role_overrides_unavailable', reason, contextSource: 'account_lifetime' });
  });
  it.each(['loading', 'account-not-found', 'account-inconsistent', 'source-version-conflict', 'authority-not-confirmed'])(
    'retains the closed Role catalog refusal reason %s', reason => {
      expect(readSessionPreparationFailureDiagnostic(Object.assign(new Error('private detail'), {
        code: 'role_overrides_unavailable', reason,
      }))).toEqual({ originalCode: 'role_overrides_unavailable', reason, contextSource: 'unknown' });
    },
  );
  it('keeps construction diagnostics closed without evaluating error accessors', () => {
    const privateError = Object.assign(new Error('private message'), {
      code: 'private-code', reason: 'private-reason', contextSource: 'private-source',
    });
    expect(readSessionPreparationFailureDiagnostic(privateError)).toEqual({
      originalCode: 'unknown', reason: 'unknown', contextSource: 'unknown',
    });
    const accessor = Object.defineProperties(new Error('private message'), {
      code: { get() { throw new Error('must not inspect private accessor'); } },
      reason: { get() { throw new Error('must not inspect private accessor'); } },
      contextSource: { get() { throw new Error('must not inspect private accessor'); } },
    });
    expect(readSessionPreparationFailureDiagnostic(accessor)).toEqual({
      originalCode: 'unknown', reason: 'unknown', contextSource: 'unknown',
    });
  });
  it('preserves typed ACP failure code and bounded redacted detail for the existing issue view', () => {
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: {
      code: 'acp_turn_failed', severity: 'error',
      message: 'Cannot connect to API Authorization: Bearer private-api-token',
      details: { requestErrorCode: -32603 },
    } });
    expect(issue.code).toBe('acp_turn_failed');
    expect(issue.sanitizedPreview).toContain('Cannot connect to API');
    expect(issue.sanitizedPreview).toContain('-32603');
    expect(JSON.stringify(issue)).not.toContain('private-api-token');
    const long = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: {
      code: 'acp_turn_failed', severity: 'error', message: 'x'.repeat(8_000),
    } });
    expect(long.sanitizedPreview?.length).toBeLessThanOrEqual(2_000);
  });
  it.each(['context_source_unavailable', 'role_overrides_unavailable', 'role_source_incomplete', 'project_requester_credentials_unavailable'])(
    'publishes %s as a private-safe preparation refusal', (code) => {
      const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error:
        Object.assign(new Error('private Account route'), {
          code, reason: 'scope-retired',
        }),
      });
      expect(issue).toMatchObject({ code: 'preparation_pending', source: 'dependency_failure' });
      expect(issue.sanitizedPreview).toMatch(/retry/iu);
      expect(JSON.stringify(issue)).not.toContain('private');
      const published = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: {
        code: issue.code, details: { v: 1, source: issue.source },
      } });
      expect(published).toMatchObject({ code: issue.code, source: issue.source, sanitizedPreview: issue.sanitizedPreview });
    },
  );
  it('retains the deterministic Home preparation cause through terminal publication', () => {
    const error = Object.assign(new PromptStackPreparationError('unavailable', { kind: 'doc', artifactId: 'private-doc' }), {
      cause: new HomeTargetResolutionError('profile_missing', 'private Home reference'),
    });
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error });
    expect(issue).toMatchObject({ code: 'profile_missing', source: 'dependency_failure' });
    const published = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: {
      code: issue.code, details: { v: 1, source: issue.source }, message: 'private error text',
    } });
    expect(published).toMatchObject({ code: issue.code, source: issue.source, sanitizedPreview: issue.sanitizedPreview });
    expect(JSON.stringify([issue, published])).not.toMatch(/private/iu);
  });
  it('retains closed startup failure codes in the Session issue without exposing provider payloads', () => {
    for (const code of ['agent_startup_rpc_rejected', 'agent_startup_transport_failed', 'agent_startup_invalid_state', 'agent_startup_failed', 'AGENT_RESUME_PROVIDER_STATE_MISSING', 'codex_refresh_free_auth_unsupported']) {
      const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error',
        error: Object.assign(new Error('Bearer private-startup-token /private/config'), { code }),
      });
      expect(issue.code).toBe(code);
      expect(JSON.stringify(issue)).not.toContain('private-startup-token');
      expect(JSON.stringify(issue)).not.toContain('/private/config');
      const published = classifyPrimarySessionRuntimeIssue({ cause: 'session_error',
        error: { code: issue.code, details: { v: 1, source: issue.source } },
      });
      expect(published).toMatchObject({ code, source: issue.source, sanitizedPreview: issue.sanitizedPreview });
    }
    expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error',
      error: { code: 'agent_startup_private-token' },
    }).code).toBe('agent_session_error');
  });
  it.each(['unavailable', 'locked', 'not_found', 'malformed', 'wrong_kind'] as const)(
    'classifies prompt preparation %s with static recovery and no private references', (reason) => {
      const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error',
        error: new PromptStackPreparationError(reason, { kind: 'doc', artifactId: 'private-prompt' }),
      });
      expect(issue).toMatchObject({
        code: reason === 'unavailable' ? 'preparation_pending' : 'attachment_unavailable',
        source: 'dependency_failure',
      });
      expect(issue.sanitizedPreview).toMatch(/prompt.*retry/iu);
      expect(JSON.stringify(issue)).not.toContain('private-prompt');
      const published = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: {
        code: issue.code, message: 'private-prompt', details: { v: 1, source: issue.source },
      } });
      expect(published).toMatchObject({ code: issue.code, source: issue.source,
        sanitizedPreview: issue.sanitizedPreview });
      expect(JSON.stringify(published)).not.toContain('private-prompt');
    },
  );

  it('does not infer a missing Agent CLI from arbitrary errors or unrelated unavailable system tools', () => {
    for (const error of [
      new ReferenceError('Agent CLI missing: secret startup detail'),
      { code: 'plugin_exec_system_tool_unavailable', message: 'secret startup detail' },
      { code: 'preparation_pending', message: 'secret startup detail' },
      { code: 'attachment_unavailable', message: 'secret startup detail', details: { v: 2, source: 'dependency_failure' } },
    ]) {
      expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error })).toMatchObject({
        code: 'agent_session_error', source: 'agent_session_error', sanitizedPreview: 'Provider session failed',
      });
    }
  });

  it('uses static missing-CLI remediation without exposing carried error text', () => {
    const issue = classifyPrimarySessionRuntimeIssue({
      cause: 'status_error',
      error: { code: 'agent_cli_missing', message: 'Bearer secret-startup-token at /private/agent' },
    });
    expect(issue).toMatchObject({ code: 'agent_cli_missing', source: 'dependency_failure' });
    expect(issue.sanitizedPreview).toMatch(/install.*CLI|CLI.*install/iu);
    expect(JSON.stringify(issue)).not.toContain('secret-startup-token');
    expect(JSON.stringify(issue)).not.toContain('/private/agent');
  });

  it('maps connected-service runtime auth classifications into usage-limit details', () => {
    const error = new Error('provider limit reached') as Error & {
      runtimeAuthClassification: {
        kind: 'usage_limit';
        serviceId: string;
        profileId: string | null;
        groupId: string | null;
        resetsAtMs: number | null;
        retryAfterMs?: number | null;
        limitCategory?: 'usage_limit';
        quotaScope?: 'account';
        providerLimitId?: string | null;
        planType: string | null;
        rateLimits: unknown | null;
        action?: { kind: 'open_url'; url: string } | null;
        source: string;
      };
    };
    error.runtimeAuthClassification = {
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'backup',
      groupId: 'codex-main',
      resetsAtMs: 2_000,
      retryAfterMs: 30_000,
      limitCategory: 'usage_limit',
      quotaScope: 'account',
      providerLimitId: 'weekly_tokens',
      planType: 'pro',
      rateLimits: {
        primary: { usedPercent: 100 },
        action: { kind: 'open_url', url: 'https://opencode.ai/billing' },
      },
      source: 'structured_provider_error',
    };

    expect(classifyPrimarySessionRuntimeIssue({
      provider: 'codex',
      cause: 'status_error',
      error,
      occurredAt: 1_000,
    })).toMatchObject({
      source: 'usage_limit',
      usageLimit: {
        v: 1,
        resetAtMs: 2_000,
        retryAfterMs: 30_000,
        quotaScope: 'account',
        recoverability: 'switch_account',
        limitCategory: 'usage_limit',
        providerLimitId: 'weekly_tokens',
        planType: 'pro',
        action: {
          kind: 'open_url',
          url: 'https://opencode.ai/billing',
        },
        connectedService: {
          serviceId: 'happier.agent.codex/openai-codex',
          profileId: 'backup',
          groupId: 'codex-main',
        },
      },
    });
  });

  it('sanitizes runtime auth classification metadata before surfacing session-visible usage-limit details', () => {
    const error = new Error('provider limit reached') as Error & {
      runtimeAuthClassification: {
        kind: 'usage_limit';
        serviceId: string;
        profileId: string | null;
        groupId: string | null;
        resetsAtMs: number | null;
        retryAfterMs?: number | null;
        limitCategory?: 'usage_limit';
        quotaScope?: 'account';
        providerLimitId?: string | null;
        planType: string | null;
        rateLimits: unknown | null;
        action?: { kind: 'open_url'; url: string } | null;
        source: string;
      };
      accessToken?: string;
    };
    error.runtimeAuthClassification = {
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-main',
      resetsAtMs: 2_000,
      retryAfterMs: 30_000,
      limitCategory: 'usage_limit',
      quotaScope: 'account',
      providerLimitId: 'Bearer secret-provider-limit-token',
      planType: 'enterprise secret plan',
      rateLimits: {
        primary: { usedPercent: 100 },
        refreshToken: 'secret-refresh-token',
      },
      action: {
        kind: 'open_url',
        url: 'https://provider.example/recover?access_token=secret-access-token#secret-fragment',
      },
      source: 'structured_provider_error',
    };
    error.accessToken = 'secret-access-token';

    const issue = classifyPrimarySessionRuntimeIssue({
      provider: 'codex',
      cause: 'status_error',
      error,
      occurredAt: 1_000,
    });

    expect(issue).toMatchObject({
      source: 'usage_limit',
      usageLimit: {
        v: 1,
        resetAtMs: 2_000,
        retryAfterMs: 30_000,
        quotaScope: 'account',
        recoverability: 'switch_account',
        limitCategory: 'usage_limit',
        planType: null,
        connectedService: {
          serviceId: 'happier.agent.codex/openai-codex',
          profileId: 'primary',
          groupId: 'codex-main',
        },
      },
    });
    expect(issue.usageLimit?.providerLimitId).toBeUndefined();
    expect(issue.usageLimit?.action).toBeUndefined();

    const issueText = JSON.stringify(issue);
    expect(issueText).not.toContain('secret-provider-limit-token');
    expect(issueText).not.toContain('enterprise secret plan');
    expect(issueText).not.toContain('secret-access-token');
    expect(issueText).not.toContain('secret-refresh-token');
  });

  it('surfaces native provider usage limits without connected-service recovery metadata', () => {
    const error = new Error('native provider limit reached') as Error & {
      runtimeAuthClassification: {
        kind: 'usage_limit';
        serviceId: string;
        profileId: string | null;
        groupId: string | null;
        resetsAtMs: number | null;
        retryAfterMs?: number | null;
        limitCategory?: 'usage_limit';
        quotaScope?: 'account';
        planType: string | null;
        rateLimits: unknown | null;
        source: string;
        connectedServiceRecovery: 'unavailable';
      };
    };
    error.runtimeAuthClassification = {
      kind: 'usage_limit',
      serviceId: 'claude-subscription',
      profileId: null,
      groupId: null,
      resetsAtMs: 2_000,
      retryAfterMs: 30_000,
      limitCategory: 'usage_limit',
      quotaScope: 'account',
      planType: 'pro',
      rateLimits: null,
      source: 'structured_provider_error',
      connectedServiceRecovery: 'unavailable',
    };

    const issue = classifyPrimarySessionRuntimeIssue({
      provider: 'claude',
      cause: 'status_error',
      error,
      occurredAt: 1_000,
    });

    expect(issue).toMatchObject({
      source: 'usage_limit',
      usageLimit: {
        v: 1,
        resetAtMs: 2_000,
        retryAfterMs: 30_000,
        quotaScope: 'account',
        recoverability: 'wait',
        limitCategory: 'usage_limit',
        planType: 'pro',
      },
    });
    expect(issue.usageLimit?.connectedService).toBeUndefined();
  });

  it('treats missing connected-service recovery context as native provider metadata', () => {
    const error = new Error('native provider limit reached') as Error & {
      runtimeAuthClassification: {
        kind: 'usage_limit';
        serviceId: string;
        profileId: string | null;
        groupId: string | null;
        resetsAtMs: number | null;
        retryAfterMs?: number | null;
        limitCategory?: 'usage_limit';
        quotaScope?: 'account';
        planType: string | null;
        rateLimits: unknown | null;
        source: string;
      };
    };
    error.runtimeAuthClassification = {
      kind: 'usage_limit',
      serviceId: 'claude-subscription',
      profileId: null,
      groupId: null,
      resetsAtMs: 2_000,
      retryAfterMs: 30_000,
      limitCategory: 'usage_limit',
      quotaScope: 'account',
      planType: 'pro',
      rateLimits: null,
      source: 'structured_provider_error',
    };

    const issue = classifyPrimarySessionRuntimeIssue({
      provider: 'claude',
      cause: 'status_error',
      error,
      occurredAt: 1_000,
    });

    expect(issue.usageLimit).toMatchObject({
      recoverability: 'wait',
    });
    expect(issue.usageLimit?.connectedService).toBeUndefined();
  });

  it('keeps provider wall-clock retry wording advisory when its timezone is absent', () => {
    const occurredAt = new Date(2026, 4, 18, 13, 2, 41, 0).getTime();

    expect(classifyPrimarySessionRuntimeIssue({
      provider: 'codex',
      cause: 'status_error',
      error: new Error("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 1:48 PM."),
      occurredAt,
    })).toMatchObject({
      source: 'usage_limit',
      usageLimit: {
        v: 1,
        resetAtMs: null,
        retryAfterMs: null,
        quotaScope: 'unknown',
        recoverability: 'wait',
      },
    });
  });

  it('uses shared provider-limit wording for quota exhaustion text', () => {
    expect(classifyPrimarySessionRuntimeIssue({
      provider: 'opencode',
      cause: 'status_error',
      error: new Error('Provider request failed because account credits exhausted.'),
      occurredAt: 1_000,
    })).toMatchObject({
      source: 'usage_limit',
      usageLimit: {
        v: 1,
        quotaScope: 'unknown',
        recoverability: 'wait',
      },
    });
  });

  it('keeps capacity runtime auth classifications distinct from usage limits', () => {
    const error = new Error('provider overloaded') as Error & {
      runtimeAuthClassification: {
        kind: 'capacity';
        serviceId: string;
        profileId: string | null;
        groupId: string | null;
        retryAfterMs?: number | null;
        limitCategory?: 'capacity';
        providerLimitId?: string | null;
        source: string;
      };
    };
    error.runtimeAuthClassification = {
      kind: 'capacity',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-main',
      retryAfterMs: 45_000,
      limitCategory: 'capacity',
      providerLimitId: 'server_overloaded',
      source: 'structured_provider_error',
    };

    expect(classifyPrimarySessionRuntimeIssue({
      provider: 'codex',
      cause: 'status_error',
      error,
      occurredAt: 1_000,
    })).toMatchObject({
      source: 'agent_status_error',
      usageLimit: {
        v: 1,
        retryAfterMs: 45_000,
        limitCategory: 'capacity',
        providerLimitId: 'server_overloaded',
        connectedService: {
          serviceId: 'happier.agent.codex/openai-codex',
          profileId: 'primary',
          groupId: 'codex-main',
        },
      },
    });
  });

  it('does not classify provider temporary throttles as usage-limit exhaustion', () => {
    const issue = classifyPrimarySessionRuntimeIssue({
      provider: 'codex',
      cause: 'status_error',
      error: {
        message: 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
        retryAfterMs: 12_000,
      },
      occurredAt: 1_000,
    });

    expect(issue).toMatchObject({
      source: 'agent_status_error',
      code: 'provider_temporary_throttle',
      sanitizedPreview: 'Provider is temporarily limiting requests',
      temporaryThrottle: {
        v: 1,
        retryAfterMs: 12_000,
        recoverability: 'retry',
      },
    });
    expect(issue.usageLimit).toBeUndefined();
  });

  it('reads retry-after-ms temporary throttle headers as milliseconds', () => {
    const error = Object.assign(
      new Error('API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited'),
      {
        headers: {
          'retry-after-ms': '2500',
        },
      },
    );

    expect(classifyPrimarySessionRuntimeIssue({
      provider: 'codex',
      cause: 'status_error',
      error,
      occurredAt: 1_000,
    })).toMatchObject({
      code: 'provider_temporary_throttle',
      temporaryThrottle: {
        retryAfterMs: 2_500,
      },
    });
  });

  it('maps connected-service runtime auth dependency failures into first-class runtime issues', () => {
    const error = new Error('provider dependency failed') as Error & {
      runtimeAuthClassification: {
        kind: 'dependency_failure';
        serviceId: string;
        profileId: string | null;
        groupId: string | null;
        resetsAtMs: number | null;
        planType: string | null;
        rateLimits: unknown | null;
        source: string;
      };
    };
    error.runtimeAuthClassification = {
      kind: 'dependency_failure',
      serviceId: 'anthropic',
      profileId: 'primary',
      groupId: 'pi-main',
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    };

    expect(classifyPrimarySessionRuntimeIssue({
      provider: 'pi',
      cause: 'status_error',
      error,
      occurredAt: 1_000,
    })).toMatchObject({
      source: 'dependency_failure',
      code: 'dependency_failure',
      sanitizedPreview: 'Provider dependency failed',
    });
    expect(classifyPrimarySessionRuntimeIssue({
      provider: 'pi',
      cause: 'status_error',
      error,
      occurredAt: 1_000,
    }).usageLimit).toBeUndefined();
  });

  it('keeps auth, plan, and validation runtime auth classifications structured', () => {
    for (const [kind, expectedSource, expectedCategory] of [
      ['auth_expired', 'auth_error', 'auth_invalid'],
      ['plan', 'agent_status_error', 'plan_invalid'],
      ['validation', 'agent_status_error', 'validation_failed'],
    ] as const) {
      const error = new Error(kind) as Error & {
        runtimeAuthClassification: {
          kind: typeof kind;
          serviceId: string;
          profileId: string | null;
          groupId: string | null;
          resetsAtMs?: number | null;
          limitCategory?: typeof expectedCategory;
          source: string;
        };
      };
      error.runtimeAuthClassification = {
        kind,
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-main',
        resetsAtMs: 9_000,
        limitCategory: expectedCategory,
        source: 'structured_provider_error',
      };

      expect(classifyPrimarySessionRuntimeIssue({
        provider: 'codex',
        cause: 'status_error',
        error,
        occurredAt: 1_000,
      })).toMatchObject({
        source: expectedSource,
        usageLimit: {
          v: 1,
          resetAtMs: 9_000,
          limitCategory: expectedCategory,
          connectedService: {
            serviceId: 'happier.agent.codex/openai-codex',
            profileId: 'primary',
            groupId: 'codex-main',
          },
        },
      });
    }
  });

  it('surfaces provider process exits after connected-service switches with structured details', () => {
    const issue = classifyPrimarySessionRuntimeIssue({
      provider: 'pi',
      cause: 'process_exit',
      occurredAt: 2_000,
      error: {
        agentProcessExitAfterSwitch: {
          exitCode: 1,
          signal: null,
          lastStderrLine: 'session file 019e... not found',
          vendorResumeId: '019e6942',
          materializationRoot: '/tmp/happier/connected-services/pi',
          effectiveStateMode: 'isolated',
        },
      },
    });

    expect(issue).toMatchObject({
      source: 'agent_process_exit_after_switch',
      code: 'agent_process_exit_after_switch',
      sanitizedPreview: 'Provider process exited after connected-service switch',
      agentProcessExitAfterSwitch: {
        exitCode: 1,
        signal: null,
        lastStderrLine: 'session file 019e... not found',
        vendorResumeId: '019e6942',
        materializationRoot: '/tmp/happier/connected-services/pi',
        effectiveStateMode: 'isolated',
      },
    });
  });

  it('does not attach temporary throttle details to provider process exits after switches', () => {
    const issue = classifyPrimarySessionRuntimeIssue({
      provider: 'pi',
      cause: 'process_exit',
      occurredAt: 2_000,
      error: {
        message: 'API Error: Server is temporarily limiting requests (not your usage limit)',
        agentProcessExitAfterSwitch: {
          exitCode: 1,
          signal: null,
          lastStderrLine: 'session file missing',
          vendorResumeId: '019e6942',
          materializationRoot: '/tmp/happier/connected-services/pi',
          effectiveStateMode: 'isolated',
        },
      },
    });

    expect(issue).toMatchObject({
      source: 'agent_process_exit_after_switch',
      code: 'agent_process_exit_after_switch',
    });
    expect(issue.temporaryThrottle).toBeUndefined();
  });

  it('normalizes a versioned provider-declared runtime issue source without reading provider prose', () => {
    const issue = classifyPrimarySessionRuntimeIssue({
      provider: 'unrelated-agent',
      cause: 'session_error',
      occurredAt: 1_000,
      error: {
        code: 'opaque_provider_terminal_failure',
        message: 'Opaque native terminal state.',
        details: {
          v: 1,
          source: 'permission_blocked',
          agentId: 'opencode',
        },
      },
    });

    expect(issue).toMatchObject({
      source: 'permission_blocked',
      code: 'permission_blocked',
      sanitizedPreview: 'Permission blocked',
    });
  });

  it('does not trust a typed diagnostic source from ACP status-error details', () => {
    const issue = classifyPrimarySessionRuntimeIssue({
      cause: 'status_error',
      occurredAt: 1_000,
      error: {
        message: '401 Unauthorized: login required',
        details: { v: 1, source: 'permission_blocked' },
      },
    });

    expect(issue).toMatchObject({
      source: 'auth_error',
      code: 'auth_error',
    });
  });

  it('does not infer session-failure provenance from provider prose without a declared source', () => {
    expect(classifyPrimarySessionRuntimeIssue({
      cause: 'session_error',
      occurredAt: 1_000,
      error: { message: 'Permission blocked by provider policy.' },
    })).toMatchObject({
      source: 'agent_session_error',
      code: 'agent_session_error',
    });
  });

  it('classifies a metadata privacy compatibility refusal as an actionable startup issue', () => {
    expect(classifyPrimarySessionRuntimeIssue({
      cause: 'session_error',
      occurredAt: 1_000,
      error: Object.assign(new Error('private server response'), {
        code: 'metadata_privacy_upgrade_required',
      }),
    })).toMatchObject({
      source: 'dependency_failure',
      code: 'metadata_privacy_upgrade_required',
      sanitizedPreview: 'Session startup needs a compatible Home. Update or reconnect, then retry the Session.',
    });
  });

  it.each([
    ['unknown source', { v: 1, source: 'future_permission_state' }],
    ['malformed version', { v: 2, source: 'permission_blocked' }],
  ])('fails closed for a %s declared runtime issue source', (_name, details) => {
    expect(classifyPrimarySessionRuntimeIssue({
      cause: 'session_error',
      occurredAt: 1_000,
      error: { details },
    })).toMatchObject({
      source: 'agent_session_error',
      code: 'agent_session_error',
    });
  });

  it('keeps incidental 401 identifiers out of auth issue classification', () => {
    expect(classifyPrimarySessionRuntimeIssue({
      cause: 'status_error',
      error: new Error('[agy-acp] WARN: failed to decode gen_metadata 401: cant skip wire type 6'),
      occurredAt: 1_000,
    })).toMatchObject({
      source: 'agent_status_error',
      code: 'agent_status_error',
    });
  });

  it('classifies contextual HTTP 401 failures as auth issues', () => {
    expect(classifyPrimarySessionRuntimeIssue({
      cause: 'status_error',
      error: new Error('Request failed with status code 401'),
      occurredAt: 1_000,
    })).toMatchObject({
      source: 'auth_error',
      code: 'auth_error',
    });
  });
});
