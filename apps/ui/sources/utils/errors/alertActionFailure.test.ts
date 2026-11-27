import { beforeEach, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import { Modal } from '@/modal';
import { t } from '@/text';
import { alertActionFailure } from './alertActionFailure';

beforeEach(() => vi.clearAllMocks());

it.each([RPC_ERROR_CODES.OUTCOME_UNKNOWN, 'outcome_unknown'])('presents %s as an unconfirmed operation', (code) => {
    alertActionFailure({ reason: 'socket has been disconnected', code,
        context: { phase: 'session.open', targetHome: 'home-1' } });
    expect(Modal.alert).toHaveBeenCalledWith(t('toolView.pending.unknownTitle'), t('toolView.pending.unknownDescription'), expect.any(Array));
    const buttons = vi.mocked(Modal.alert).mock.calls.at(0)?.[2];
    buttons?.[0]?.onPress?.();
    // DESIGN-ACCEPT-152 fix 3: Technical details read as labelled lines, never raw JSON.
    const details = String(vi.mocked(Modal.alert).mock.calls.at(-1)?.[1]);
    expect(vi.mocked(Modal.alert).mock.calls.at(-1)?.[0]).toBe(t('approvals.technicalDetails'));
    expect(details.split('\n')).toEqual([
        `${t('common.error')}: ${code}`,
        `${t('approvals.failureTechnicalLabels.phase')}: session.open`,
        `${t('common.home')}: home-1`,
    ]);
    expect(details).not.toMatch(/[{}"]/);
});

it('keeps a definite refusal as an error with its original reason', () => {
    alertActionFailure({ reason: 'Not allowed', code: RPC_ERROR_CODES.FORBIDDEN });
    expect(Modal.alert).toHaveBeenCalledWith(t('common.error'), 'Not allowed', expect.any(Array));
});

it('offers the supplied recovery action beside deliberate technical details', () => {
    const onPress = vi.fn();
    alertActionFailure({ reason: 'Plugin disabled', code: 'plugin_disabled', recovery: { label: 'Manage plugin', onPress } });
    const buttons = vi.mocked(Modal.alert).mock.calls[0]?.[2];
    buttons?.find(button => button.text === 'Manage plugin')?.onPress?.();
    expect(onPress).toHaveBeenCalledOnce();
    expect(buttons?.some(button => button.text === t('approvals.technicalDetails'))).toBe(true);
});

// The presenter receives the closed typed cause intact; its scalar context stays separate.
it('keeps the offline-delete cause code and phase alongside the operation result', () => {
    alertActionFailure({ reason: 'Not allowed', code: RPC_ERROR_CODES.FORBIDDEN,
        failureCause: { phase: 'session.delete', errorClass: 'Error', errorCode: RPC_ERROR_CODES.FORBIDDEN,
            httpStatus: 403, nativeErrorCode: 'PERMISSION_DENIED' }, context: { effectAttempted: false } });
    const technical = vi.mocked(Modal.alert).mock.calls.at(-1)?.[2]?.find(button => button.text === t('approvals.technicalDetails'));
    technical?.onPress?.();
    const details = String(vi.mocked(Modal.alert).mock.calls.at(-1)?.[1]);
    expect(details).toContain(`${t('approvals.failureTechnicalLabels.causeCode')}: ${RPC_ERROR_CODES.FORBIDDEN}`);
    expect(details).toContain(`${t('approvals.failureTechnicalLabels.phase')}: session.delete`);
    expect(details).toContain(`${t('approvals.failureTechnicalLabels.httpStatus')}: 403`);
    expect(details).toContain(`${t('approvals.failureTechnicalLabels.effectAttempted')}: false`);
    expect(details).toContain('nativeErrorCode: PERMISSION_DENIED');
});
