import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import { resolveActionExecutionErrorMessage, resolveActionExecutionFailureMessage } from './resolveActionExecutionFailureMessage';

describe('Action failure presentation', () => {
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

    it('uses the existing permission denial for credential scope refusals', () => {
        expect(resolveActionExecutionFailureMessage({ ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' }, 'Fallback'))
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
        expect(resolveActionExecutionFailureMessage({ ok: false, errorCode: 'other_failure', error: 'Details' }, 'Fallback'))
            .toBe('Details');
        expect(resolveActionExecutionFailureMessage({ ok: true, result: { results: [{ ok: true }] } }, 'Fallback'))
            .toBeNull();
    });
});
