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

it('presents an issued unknown outcome as an unconfirmed operation rather than a hard failure', () => {
    alertActionFailure({ reason: 'socket has been disconnected', code: RPC_ERROR_CODES.OUTCOME_UNKNOWN,
        context: { phase: 'session.open', targetHome: 'home-1' } });
    expect(Modal.alert).toHaveBeenCalledWith(t('toolView.pending.unknownTitle'), t('toolView.pending.unknownDescription'), expect.any(Array));
    const buttons = vi.mocked(Modal.alert).mock.calls.at(0)?.[2];
    buttons?.[0]?.onPress?.();
    expect(Modal.alert).toHaveBeenLastCalledWith(t('approvals.technicalDetails'), JSON.stringify({
        code: RPC_ERROR_CODES.OUTCOME_UNKNOWN, phase: 'session.open', targetHome: 'home-1',
    }, null, 2));
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
