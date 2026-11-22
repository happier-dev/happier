import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { ExternalActionHttpErrorSchema, projectExternalActionHttpFailureV1 } from '@happier-dev/protocol/actions/externalActionHttpError';
import { PluginUiPresentActionFailureRequestV1Schema } from '@happier-dev/protocol/plugins/ui/client';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { completeSpawnActionResult } from '@happier-dev/protocol/actions/executor/resultProjection';
import { HappyError } from '@/utils/errors/errors';

import { t } from '@/text';

import { presentActionExecutionFailure, resolveActionExecutionErrorMessage, resolveActionExecutionFailureMessage, resolveActionExecutionFailureTitle } from './resolveActionExecutionFailureMessage';
import { resolveSessionSpawnNewResultFailureMessage } from './sessionSpawnFailurePresentation';

describe('Action failure presentation', () => {
    it('presents the deployment installation refusal from the HTTP failure envelope', () => {
        const details = { reason: 'machine_installation_replaced', requiredFact: 'installationId=retired-installation',
            remedy: 'This Machine was reinstalled. Create a new Environment on the current installation and add its required secrets.' };
        const refusal = projectExternalActionHttpFailureV1(ExternalActionHttpErrorSchema.parse({
            error: 'credential_scope_denied', requestId: 'backup-run', details,
        }));
        expect(presentActionExecutionFailure(refusal).reason).toBe(details.remedy);
        const bare = projectExternalActionHttpFailureV1(ExternalActionHttpErrorSchema.parse({ error: 'credential_scope_denied' }));
        expect(presentActionExecutionFailure(bare).reason).toBe(t('errors.permissionDenied'));
    });

    it('explains Team creation policy refusals and keeps a bare Team refusal generic', () => {
        const failure = { ok: false, errorCode: 'team_forbidden', error: 'team_forbidden' };
        const fallback = t('teams.errors.forbidden');
        expect(resolveActionExecutionFailureMessage(failure, fallback)).toBe(fallback);
        expect(resolveActionExecutionFailureMessage({ ...failure,
            details: { error: 'team_forbidden', details: { reason: 'managed_only' }, httpStatus: 403 },
        }, fallback)).toBe(t('teams.directory.createAdministeredUnnamed'));
        expect(resolveActionExecutionFailureMessage({ ...failure,
            details: { error: 'team_forbidden', details: { reason: 'disabled' }, httpStatus: 403 },
        }, fallback)).toBe(t('teams.directory.createOff'));
    });

    it('shows the typed spawn cause from the canonical terminal Action failure', () => {
        const failure = completeSpawnActionResult({ type: 'error', code: 'spawn_failed', retryable: true,
            launchError: { kind: 'launch_error', code: 'admission_unavailable', message: 'admission_unavailable' } });
        expect(failure.ok).toBe(false);
        expect(resolveActionExecutionFailureMessage(failure, 'Fallback')).toContain('admission_unavailable');
    });
    it('explains the retired plugin UI generation from the Install refusal and keeps its diagnostic reference', () => {
        // Captured product Install result: TH-QA-POOLS-1116/r2-install-cli.json.
        const failure = { ok: false as const, errorCode: 'plugin_ui_generation_retired', error: 'plugin_ui_generation_retired',
            requestId: 'bae9b445-56e4-4836-aff4-18af13e17405',
            details: { name: 'PluginError', code: 'plugin_ui_generation_retired', message: 'plugin_ui_generation_retired', retryable: false },
            failureCause: { phase: 'dispatch', errorClass: 'Error', errorCode: 'plugin_ui_generation_retired', httpStatus: null } } as const;
        const expected = t('pluginRuntime.viewNotCurrent');
        expect(resolveActionExecutionFailureMessage(failure, 'Fallback')).toBe(expected);
        const presented = presentActionExecutionFailure(failure);
        expect(presented.reason).toBe(expected);
        expect(presented.technicalDetails).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'code', value: failure.errorCode }),
            expect.objectContaining({ key: 'requestId', value: failure.requestId }),
        ]));
    });
    it.each(['stale_surface', 'plugin_ui_generation_retired', 'plugin_action_generation_retired'])(
        'explains a code-only %s failure while retaining authored recovery', code => {
            const expected = t('pluginRuntime.viewNotCurrent');
            expect(resolveActionExecutionFailureMessage({ ok: false, errorCode: code, message: code }, 'Fallback')).toBe(expected);
            expect(resolveActionExecutionErrorMessage(new PluginError({ code, message: code }), 'Fallback')).toBe(expected);
            const message = 'Reopen the Dev Containers page on the selected machine.';
            expect(resolveActionExecutionFailureMessage({ ok: false, errorCode: code, message }, 'Fallback')).toBe(message);
            expect(resolveActionExecutionErrorMessage(new PluginError({ code, message }), 'Fallback')).toBe(message);
        },
    );
    it('says the Machine is not answering when the Home refuses its target as offline (Deploy draft, QA #27b)', () => {
        const fallback = t('common.requestFailed');
        // The Home's action route answers 409 with the Machine admission's typed availability diagnostic.
        const diagnostic = { reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' };
        const refused = (details: unknown) => ({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable', details });
        expect(resolveActionExecutionFailureMessage(refused({ error: 'invalid_request', code: 'target_unavailable', diagnostic }), fallback))
            .toBe(t('errors.machineNotAnswering'));
        expect(resolveActionExecutionFailureMessage(refused(diagnostic), fallback)).toBe(t('errors.machineNotAnswering'));
        // Other target refusals keep the caller's sentence rather than guessing at a cause.
        expect(resolveActionExecutionFailureMessage(refused({ diagnostic: { reason: 'session_absent' } }), fallback)).toBe(fallback);
    });
    it('retains a child Session refusal through returned and thrown parent Action failures', () => {
        const child = SessionSpawnNewActionResultV1Schema.parse({ type: 'error', code: 'agent_signed_out',
            retryable: false, agentId: 'claude', launchError: { kind: 'launch_error', code: 'agent_signed_out',
                message: 'Private native authentication diagnostic',
                failureCause: { phase: 'authentication', failureReason: 'authentication_required' } } });
        if (child.type !== 'error') throw new Error('Expected a Session refusal');
        const expected = resolveSessionSpawnNewResultFailureMessage(child);
        const failure = { ok: false, errorCode: child.code, error: child.code, details: child };
        expect(resolveActionExecutionFailureMessage(failure, 'Parent unavailable')).toBe(expected);
        expect(resolveActionExecutionErrorMessage(new HappyError(child.code, false,
            { code: child.code, details: child }), 'Parent unavailable')).toBe(expected);
        expect(expected).not.toContain('Private native authentication diagnostic');
        expect(resolveActionExecutionFailureMessage({ ...failure, message: 'Choose another signed-in Agent.' }, 'fallback'))
            .toBe('Choose another signed-in Agent.');
    });
    it('presents a typed interrupted read without exposing socket adapter text', () => {
        const error = 'Socket disconnected before the read completed';
        const failure = { ok: false as const, errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE, error };
        expect(resolveActionExecutionErrorMessage(new RpcError(error, RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE), 'fallback'))
            .toBe(t('errors.networkError'));
        expect(resolveActionExecutionFailureMessage(failure, 'fallback')).toBe(t('errors.networkError'));
    });
    it('keeps consumer refusal reasons and recovery in prose, with correlation in Details', () => {
        const cases = [
            { consumer: 'plugin action', errorCode: 'credential_unavailable', message: 'Sign in to the provider.',
                remediation: { kind: 'retry' as const }, expected: `Sign in to the provider. ${t('errors.tryAgain')}` },
            { consumer: 'Account erasure', errorCode: 'action_forbidden', expected: t('errors.permissionDenied') },
            { consumer: 'provider CLI', errorCode: 'managed_cli_unavailable', expected: t('errors.machineManagedCliUnavailable') },
            { consumer: 'file save', errorCode: 'file_save_failed', expected: t('files.fileWriteFailed') },
        ];
        for (const row of cases) {
            const requestId = `refusal-${row.consumer}`;
            // Use the actual host API codec, rather than a fixture that bypasses its strict input boundary.
            const failure = PluginUiPresentActionFailureRequestV1Schema.parse({
                ok: false, errorCode: row.errorCode, requestId, effectAttempted: false,
                ...(row.message ? { message: row.message } : {}),
                ...(row.remediation ? { remediation: row.remediation } : {}),
            });
            const input = row.consumer === 'plugin action' ? { ok: true, result: failure } : failure;
            expect(resolveActionExecutionFailureMessage(input, 'Fallback'), row.consumer).toBe(row.expected);
            if (row.consumer === 'Account erasure') {
                expect(resolveActionExecutionErrorMessage(new HappyError('Private transport detail', false,
                    { code: row.errorCode, requestId }), 'Fallback')).toBe(row.expected);
            }
            const presented = presentActionExecutionFailure(failure);
            expect(presented.reason, row.consumer).toBe(row.expected);
            // Recovery is currently combined into reason by this owner; consumers must not invent a second step.
            expect(presented.nextStep, row.consumer).toBeNull();
            expect(presented.reason).not.toContain(requestId);
            expect(presented.technicalDetails, row.consumer).toEqual(expect.arrayContaining([
                expect.objectContaining({ key: 'code', value: row.errorCode }),
                expect.objectContaining({ key: 'requestId', value: requestId }),
                expect.objectContaining({ key: 'effectAttempted', value: 'false' }),
            ]));
        }
    });
    it('presents an invalid Action envelope without diagnosing cryptography or losing its technical code', () => {
        const failure = { ok: false as const, errorCode: 'invalid_encrypted_envelope', error: 'invalid_encrypted_envelope',
            requestId: 'setup-plan-request', effectAttempted: false };
        const expected = t('common.requestFailed');
        for (const result of [failure, { ok: true, result: failure }]) {
            expect(resolveActionExecutionFailureMessage(result, 'fallback')).toBe(expected);
        }
        expect(resolveActionExecutionErrorMessage(Object.assign(new Error(failure.error), { code: failure.errorCode }), 'fallback'))
            .toBe(expected);
        expect(presentActionExecutionFailure(failure)).toMatchObject({ reason: expected,
            technicalDetails: expect.arrayContaining([
                expect.objectContaining({ key: 'code', value: failure.errorCode }),
                expect.objectContaining({ key: 'requestId', value: failure.requestId }),
                expect.objectContaining({ key: 'effectAttempted', value: 'false' }),
            ]) });
        const authored = { ...failure, message: 'Reconnect the requesting device.', remediation: { kind: 'retry' } };
        expect(resolveActionExecutionFailureMessage(authored, 'fallback'))
            .toBe(`${authored.message} ${t('errors.tryAgain')}`);
    });
    it.each([
        { errorCode: 'required_fact_unavailable', details: { requiredFact: 'caddyContainer',
            failure: { kind: 'native_observation_unavailable', reason: 'required_fact_unavailable', requiredFact: 'caddyContainer', errorCode: 'ENOENT' },
            remedy: 'Restore native container inventory before reviewing Network again.' } },
        { errorCode: 'native_check_unavailable', details: {
            failure: { kind: 'native_check_unavailable', reason: 'required_fact_unavailable', requiredFact: 'administratorSudoToRoot',
                remedy: 'Choose an administrator with its own sudo-to-root right, then retry.' },
            remedy: 'Choose an administrator with its own sudo-to-root right, then retry.' } },
    ])('presents the closed native recovery across returned and thrown Network failures: $errorCode', ({ errorCode, details }) => {
        const failure = { ok: false, errorCode, error: errorCode, details };
        expect(resolveActionExecutionErrorMessage(failure, 'Network unavailable')).toBe(details.remedy);
        for (const result of [failure, { ok: true, result: failure }]) {
            expect(resolveActionExecutionFailureMessage(result, 'Network unavailable')).toBe(details.remedy);
        }
        const invalid = { ...failure, details: { ...details, stderr: 'private native diagnostic' } };
        expect(resolveActionExecutionErrorMessage(invalid, 'Network unavailable')).not.toBe(details.remedy);
        expect(resolveActionExecutionErrorMessage(invalid, 'Network unavailable')).not.toContain('private native diagnostic');
    });
    it.each(['credential_unavailable', 'preset_limit_reached'])('prefers authored repair over fallback copy for %s across thrown and returned failures', code => {
        const data = { code, message: 'Sign in to Docker: run sbx login', retryable: true, remediation: { kind: 'retry' as const } };
        const expected = `${data.message} ${t('errors.tryAgain')}`;
        expect(resolveActionExecutionErrorMessage(new PluginError(data), 'fallback')).toBe(expected);
        const failure = { ok: false, ...data };
        for (const result of [failure, { ok: true, result: failure }, { ok: true, result: { results: [failure] } }]) {
            expect(resolveActionExecutionFailureMessage(result, 'fallback')).toBe(expected);
        }
    });
    it('explains an unenforceable role policy and offers another Agent', () => {
        const expected = "This Agent cannot enforce this role's access restrictions. Choose another Agent for this role.";
        expect(resolveActionExecutionFailureMessage({ ok: false, errorCode: 'role_policy_unenforceable', error: 'role_policy_unenforceable' }, 'fallback')).toBe(expected);
        expect(resolveActionExecutionErrorMessage(Object.assign(new Error('role_policy_unenforceable'), { code: 'role_policy_unenforceable' }), 'fallback')).toBe(expected);
    });
    it('names the Account Voice feature repair', () => {
        expect(resolveActionExecutionFailureMessage({ ok: false, errorCode: 'feature_policy_disabled', details: { recovery: 'enable_voice_agent' } }, 'fallback')).toBe(t('settingsVoice.pages.conversations.agentFeatureRequired', { feature: t('settingsFeatures.expVoiceAgent') }));
    });
    it('keeps authored plugin reason and retry recovery across returned and thrown failures', () => {
        const failure = { ok: false, code: 'provider_unavailable', message: 'Provider is offline', remediation: { kind: 'retry' } };
        const expected = `Provider is offline ${t('errors.tryAgain')}`;
        expect(resolveActionExecutionFailureMessage(failure, 'fallback')).toBe(expected);
        expect(resolveActionExecutionErrorMessage(new PluginError({ code: 'provider_unavailable', message: failure.message, remediation: { kind: 'retry' } }), 'fallback')).toBe(expected);
    });
    it('keeps the Docker sign-in instruction without interpreting its text', () => {
        expect(resolveActionExecutionFailureMessage({ ok: false, code: 'credential_unavailable', message: 'Sign in to Docker: run sbx login' }, 'fallback')).toBe('Sign in to Docker: run sbx login');
        const expected = t('session.startFailure.cause.credential_unavailable');
        expect(expected).not.toContain('startFailure.cause.');
        expect(resolveActionExecutionFailureMessage({ ok: false, code: 'credential_unavailable' }, 'fallback')).toBe(expected);
        expect(resolveActionExecutionErrorMessage(new PluginError({ code: 'credential_unavailable' }), 'fallback')).toBe(expected);
    });
    it.each(['mode_none', 'not_preauthorized'])('names the administrator prerequisite for %s without treating it as transport failure', code => {
        expect(resolveActionExecutionFailureMessage({ ok: false, errorCode: code, error: code }, 'Could not read the network'))
            .toBe(t('machineDetailPage.security.reasons.needsAdminToCheck'));
        expect(resolveActionExecutionErrorMessage({ code }, 'Could not read the network'))
            .toBe(t('machineDetailPage.security.reasons.needsAdminToCheck'));
    });
    it.each(['access_denied', 'permission_denied', 'denied', RPC_ERROR_CODES.FORBIDDEN])('preserves the %s denial from a Machine Resource read', code => {
        expect(resolveActionExecutionErrorMessage({ code, message: 'Resource is unavailable' }, 'Could not read services'))
            .toBe(t('errors.permissionDenied'));
    });
    it('uses the surface fallback for projected adapter errors rather than treating their diagnostic message as authored repair', () => {
        const fallback = t('machineDetailPage.security.staleFailed');
        expect(resolveActionExecutionErrorMessage({ code: 'service_transport_unavailable', message: 'Resource is unavailable' }, fallback))
            .toBe(fallback);
    });
    it.each(['approval_required', 'approval_canceled', 'plugin_action_current_intent_rejected'])
    ('preserves the known unapplied outcome for %s without recommending repetition', (code) => {
        const options = { notAppliedMessage: 'Not saved' };
        expect(resolveActionExecutionErrorMessage(new PluginError({ code }), 'Fallback', options)).toBe('Not saved');
        expect(resolveActionExecutionFailureMessage({ ok: false, errorCode: code, error: code }, 'Fallback', options)).toBe('Not saved');
        if (code !== 'approval_required') {
            expect(resolveActionExecutionErrorMessage(new PluginError({ code }), 'Fallback')).toBe(t('voiceSurface.actionCanceled'));
        }
        expect(resolveActionExecutionErrorMessage(new PluginError({ code: 'outcome_unknown' }), 'Fallback', options))
            .toBe(t('errors.scmOutcomeUnknown'));
    });

    it.each([
        ['plugin_action_input_schema_invalid', 'common.requestFailed'],
        ['plugin_action_unavailable', 'ui.pluginUi.actionUnavailable'],
        ['approval_required', 'notifications.activity.permissionFallbackBody'],
        ['preset_limit_reached', 'machinePresets.limitWaits'],
        ['pool_no_available_machine', 'machinePresets.poolNoMachine'],
    ] as const)('presents plugin refusal %s through thrown errors and Action envelopes', (code, key) => {
        expect(resolveActionExecutionErrorMessage(new PluginError({ code }), 'Save failed')).toBe(t(key));
        expect(resolveActionExecutionFailureMessage({ ok: false, errorCode: code, error: code }, 'Save failed')).toBe(t(key));
    });

    it('offers safe repetition for busy reads and idempotent writes without asserting rollback', () => {
        for (const errorCode of ['database_transaction_conflict_exhausted', 'database_transaction_timeout', 'database_connection_unavailable']) {
            expect(resolveActionExecutionErrorMessage({ code: errorCode }, 'Fallback', { safeToRetry: true }))
                .toBe(t('approvals.transientFailureTitle'));
        }
        expect(resolveActionExecutionErrorMessage({ code: 'outcome_unknown' }, 'Fallback', { safeToRetry: true }))
            .toBe(t('errors.tryAgain'));
    });
    it('asks for another try when an Account Settings write gets no answer, never the engine text', () => {
        const unsettled = { ok: false, errorCode: 'account_settings_mutation_outcome_unknown',
            error: 'Account Settings mutation did not settle: outcomeUnknown' };
        expect(resolveActionExecutionErrorMessage(unsettled, 'Fallback')).toBe(t('errors.tryAgain'));
        expect(resolveActionExecutionFailureMessage(unsettled, 'Fallback')).toBe(t('errors.tryAgain'));
    });
    it('names a typed busy-server refusal through thrown and returned adapters', () => {
        const refused = { ok: false, errorCode: 'database_transaction_conflict_exhausted', error: 'private transport detail' };
        for (const result of [refused, { ok: true, result: refused }, { ok: true, result: { results: [refused] } }]) {
            expect(resolveActionExecutionFailureMessage(result, 'Delete failed')).toBe(t('approvals.transientFailure'));
            expect(resolveActionExecutionFailureTitle(result, 'Delete failed')).toBe(t('approvals.transientFailureTitle'));
        }
        expect(resolveActionExecutionErrorMessage({ code: refused.errorCode }, 'Delete failed')).toBe(t('approvals.transientFailure'));
        expect(resolveActionExecutionFailureTitle({ code: refused.errorCode }, 'Delete failed')).toBe(t('approvals.transientFailureTitle'));
        expect(resolveActionExecutionFailureTitle({ code: 'unknown' }, 'Delete failed')).toBe('Delete failed');
        expect(resolveActionExecutionErrorMessage({ code: 'database_transaction_timeout' }, 'Delete failed'))
            .toBe(t('toolView.pending.unknownDescription'));
        const uncertain = { ok: false, errorCode: 'outcome_uncertain', error: 'outcome_uncertain',
            failureCause: { phase: 'session.draft.delete', errorClass: 'HappyError', errorCode: 'database_transaction_timeout', httpStatus: 503 } };
        expect(resolveActionExecutionFailureTitle(uncertain, 'Delete failed')).toBe(t('approvals.transientFailureTitle'));
        expect(resolveActionExecutionFailureMessage(uncertain, 'Delete failed')).toBe(t('toolView.pending.unknownDescription'));
    });
    it('retains discussion refusal meanings across Action envelopes without assigning generic codes to Discussions', () => {
        const refused = { ok: false, errorCode: 'discussion_post_denied', error: 'discussion_post_denied' };
        for (const result of [refused, { ok: true, result: refused }, { ok: true, result: { results: [refused] } }]) {
            expect(resolveActionExecutionFailureMessage(result, 'Fallback'))
                .toBe(t('session.collaboration.discussion.postDenied'));
        }
        expect(resolveActionExecutionErrorMessage({ code: refused.errorCode }, 'Fallback'))
            .toBe(t('session.collaboration.discussion.postDenied'));
        expect(resolveActionExecutionErrorMessage({ code: 'invalid_parameters' }, 'Fallback')).toBe('Fallback');
        expect(resolveActionExecutionErrorMessage({ code: 'discussion_unknown_code' }, 'Fallback')).toBe('Fallback');
    });

    it.each([
        ['native_protocol_invalid', 'errors.machineNativeProtocolInvalid'],
        ['native_check_unavailable', 'errors.machineNativeCheckUnavailable'],
        ['native_check_unsupported', 'errors.machineNativeCheckUnsupported'],
        ['native_effect_failed', 'errors.machineNativeEffectFailed'],
    ] as const)('presents the native elevation reason %s through Action envelopes', (errorCode, key) => {
        const refused = { ok: false, errorCode, error: errorCode };
        for (const result of [refused, { ok: true, result: refused }]) {
            expect(resolveActionExecutionFailureMessage(result, 'Could not add domain')).toBe(t(key));
        }
        expect(resolveActionExecutionErrorMessage({ code: errorCode }, 'Could not add domain')).toBe(t(key));
    });
    it('directs a no-posture Domain refusal to Machine Network review through each Action envelope', () => {
        const refused = { ok: false, errorCode: 'machine_network_review_required', error: 'machine_network_review_required' };
        for (const result of [refused, { ok: true, result: refused }]) {
            expect(resolveActionExecutionFailureMessage(result, 'Could not add domain'))
                .toBe(t('errors.machineNetworkReviewRequired'));
        }
        expect(resolveActionExecutionErrorMessage({ code: refused.errorCode }, 'Could not add domain'))
            .toBe(t('errors.machineNetworkReviewRequired'));
    });

    it('explains how to recover a Domain add when the managed Happier CLI is unavailable', () => {
        const refused = { ok: false, errorCode: 'managed_cli_unavailable', error: 'managed_cli_unavailable',
            errorDetails: { recovery: { kind: 'install_managed_cli', executablePath: '/private/managed/happier' } } };
        for (const result of [refused, { ok: true, result: refused }]) {
            expect(resolveActionExecutionFailureMessage(result, 'Could not add domain'))
                .toBe(t('errors.machineManagedCliUnavailable'));
        }
        expect(resolveActionExecutionErrorMessage({ code: refused.errorCode }, 'Could not add domain'))
            .toBe(t('errors.machineManagedCliUnavailable'));
    });

    it('explains the administrator-access remedy for a refused Domain add at each Action envelope', () => {
        const refused = { ok: false, errorCode: 'machine_admin_access_required', error: 'machine_admin_access_required' };
        for (const result of [refused, { ok: true, result: refused }]) {
            expect(resolveActionExecutionFailureMessage(result, 'Could not add domain'))
                .toBe(t('errors.machineAdminAccessRequired'));
        }
        expect(resolveActionExecutionErrorMessage({ code: refused.errorCode }, 'Could not add domain'))
            .toBe(t('errors.machineAdminAccessRequired'));
    });

    it('keeps dashboard deletion refusals distinct from a generic delete failure', () => {
        for (const [code, key] of [
            ['widget_area_layout_default_protected', 'projects.dashboard.defaultProtected'],
            ['widget_area_layout_owner_required', 'errors.permissionDenied'],
            ['widget_area_layout_owner_ambiguous', 'widgetAdd.areaScopeRecovery'],
            ['widget_area_layout_owner_unavailable', 'widgetAdd.areaScopeRecovery'],
            ['artifact_access_unavailable', 'widgetAdd.refusals.areaUnavailable'],
            ['invalid_widget_area_record', 'errors.invalidFormat'],
            ['artifact_kind_internal', 'errors.permissionDenied'],
            ['project_account_rows_unavailable', 'widgetAdd.refusals.areaUnavailable'],
            ['version_mismatch', 'artifacts.browser.conflict.title'],
            ['widget_area_not_found', 'artifacts.notFound'],
        ] as const) {
            expect(resolveActionExecutionErrorMessage({ code, error: code }, 'Delete failed')).toBe(t(key));
            expect(resolveActionExecutionFailureMessage({ ok: false, errorCode: code, error: code }, 'Delete failed')).toBe(t(key));
        }
    });

    it('retains distinct actionable Settings refusal reasons for returned and thrown adapters', () => {
        for (const [code, key] of [
            ['invalid_setting_value', 'settings.writeValueRefused'],
            ['setting_not_bound', 'settings.writeContextChanged'],
            ['account_settings_mutation_conflict', 'settings.writeContextChanged'],
        ] as const) {
            expect(resolveActionExecutionFailureMessage({ ok: false, errorCode: code, error: code }, 'Fallback')).toBe(t(key));
            expect(resolveActionExecutionErrorMessage({ code }, 'Fallback')).toBe(t(key));
        }
    });

    it.each(['credential_scope_denied', 'action_forbidden'])('uses the existing permission denial for %s refusals', (errorCode) => {
        expect(resolveActionExecutionFailureMessage({ ok: false, errorCode, error: errorCode }, 'Fallback'))
            .toBe(t('errors.permissionDenied'));
        expect(resolveActionExecutionErrorMessage({ code: errorCode }, 'Fallback'))
            .toBe(t('errors.permissionDenied'));
    });
    it('uses runner restart guidance for returned Review launch failures at each Action envelope', () => {
        const refused = { ok: false, errorCode: 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING',
            error: 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING' };
        for (const result of [refused, { ok: true, result: refused },
            { ok: true, result: { results: [{ key: 'claude', ...refused }] } }]) {
            expect(resolveActionExecutionFailureMessage(result, 'Launch failed'))
                .toBe(t('session.staleRunner.banner.body'));
        }
        expect(resolveActionExecutionErrorMessage({ code: refused.errorCode }, 'Launch failed'))
            .toBe(t('session.staleRunner.banner.body'));
    });

    it('says the Home did not confirm a widget write whose acknowledgement never came back, instead of the generic fallback', () => {
        for (const errorCode of ['widget_add_unknown', 'widget_write_ack_unknown']) {
            expect(resolveActionExecutionErrorMessage({ kind: 'refused', errorCode }, 'Couldn’t add it.')).toBe(t('widgetAdd.refusals.writeUnconfirmed'));
        }
        expect(resolveActionExecutionErrorMessage({ kind: 'refused', errorCode: 'something_else' }, 'Couldn’t add it.')).toBe('Couldn’t add it.');
    });

    it('says what is wrong with a widget input the Home refused, from the refusal\'s own reason', () => {
        const refusal = (status: string, reasonCode: string) => ({ kind: 'refused', errorCode: 'widget_inputs_invalid',
            details: { status, fields: [{ path: 'session', status, reasonCode }] } });
        const message = (status: string, reasonCode: string) => resolveActionExecutionErrorMessage(refusal(status, reasonCode), 'Couldn’t add it.');
        // A pinned Session the person cannot read, a choice that is gone, and choices that could not load say different things.
        expect(message('denied', 'widget_session_access_denied')).toBe(t('widgetAdd.refusals.inputsAccessDenied'));
        expect(message('invalid', 'input_type_option_invalid')).toBe(t('widgetAdd.refusals.inputsChoiceGone'));
        expect(message('unavailable', 'input_type_options_unavailable')).toBe(t('widgetAdd.refusals.inputsChoicesUnavailable'));
        expect(new Set([message('denied', 'widget_session_access_denied'), message('invalid', 'input_type_option_invalid'),
            message('unavailable', 'input_type_options_unavailable')]).size).toBe(3);
        // Without a reason the refusal keeps the general sentence.
        expect(resolveActionExecutionErrorMessage({ kind: 'refused', errorCode: 'widget_inputs_invalid' }, 'Couldn’t add it.'))
            .toBe(t('widgetAdd.refusals.inputsInvalid'));
    });

    it('retains ordinary Action failure and successful-result behavior', () => {
        expect(resolveActionExecutionErrorMessage(new Error('Private transport detail'), 'Fallback'))
            .toBe('Fallback');
        expect(resolveActionExecutionFailureMessage({ ok: false, errorCode: 'other_failure', error: 'Details' }, 'Fallback'))
            .toBe('Details');
        expect(resolveActionExecutionFailureMessage({ ok: true, result: { results: [{ ok: true }] } }, 'Fallback'))
            .toBeNull();
    });

    it('keeps presentation-owned typed UI refusals specific through the shared Action-failure copy owner', () => {
        for (const [errorCode, key] of [
            ['file_save_failed', 'files.fileWriteFailed'],
            ['file_save_unavailable', 'files.fileWriteFailed'],
            ['browser_download_unavailable', 'files.fileWriteFailed'],
            ['navigation_placement_not_applied', 'entityDragDrop.reasons.generic'],
            ['space_reorder_not_applied', 'entityDragDrop.reasons.generic'],
            ['saved_view_reorder_not_applied', 'entityDragDrop.reasons.generic'],
        ] as const) {
            expect(resolveActionExecutionFailureMessage({ ok: false, errorCode }, 'Operation failed')).toBe(t(key));
            expect(resolveActionExecutionErrorMessage({ code: errorCode }, 'Operation failed')).toBe(t(key));
        }
    });
});
