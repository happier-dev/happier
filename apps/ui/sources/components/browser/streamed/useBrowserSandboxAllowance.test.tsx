import { describe, expect, it } from 'vitest';

import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';

import { describeBrowserSandboxAllowance, useBrowserSandboxAllowance } from './useBrowserSandboxAllowance';

import { allowBrowserSandbox } from '@/sync/domains/browser/firstUse/browserFirstUse';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { t } from '@/text';

it.each(['returned', 'thrown'])('shows the owner’s %s sandbox permission refusal and safe technical details', async delivery => {
    const refusal = { ok: false, errorCode: 'action_forbidden', error: 'Private sandbox command diagnostic',
        requestId: 'sandbox-install-denied', effectAttempted: false,
        failureCause: { phase: 'action.owner', errorClass: 'HttpStatusError', errorCode: 'forbidden', httpStatus: 403 },
    } as const;
    const hook = await renderHook(() => useBrowserSandboxAllowance(() => allowBrowserSandbox(async () => {
        if (delivery === 'thrown') throw createActionExecuteFailureError(refusal);
        return refusal;
    }, { serverId: 'sandbox-server', accountId: 'sandbox-account', sessionId: 'sandbox-session', machineId: 'sandbox-machine' })));
    try {
        await act(async () => { await hook.getCurrent().allow?.(); });
        const { allowance } = hook.getCurrent();
        expect(allowance.kind).toBe('settled');
        if (allowance.kind !== 'settled') throw new Error('Sandbox request did not settle');
        const presentation = describeBrowserSandboxAllowance(allowance.outcome);
        expect(presentation.reason).toBe(t('errors.permissionDenied'));
        expect(presentation.technicalDetails).toContainEqual(expect.objectContaining({ key: 'requestId', value: refusal.requestId }));
        expect(JSON.stringify(presentation)).not.toContain(refusal.error);
    } finally {
        await hook.unmount();
    }
});

describe('useBrowserSandboxAllowance', () => {
    it('settles with the typed outcome, and returns to idle when the person declined', async () => {
        let outcome: Awaited<ReturnType<NonNullable<Parameters<typeof useBrowserSandboxAllowance>[0]>>> = { status: 'installed' };
        const hook = await renderHook(() => useBrowserSandboxAllowance(async () => outcome));
        expect(hook.getCurrent().allowance).toEqual({ kind: 'idle' });
        await act(async () => { await hook.getCurrent().allow?.(); });
        expect(hook.getCurrent().allowance).toEqual({ kind: 'settled', outcome: { status: 'installed' } });
        outcome = null;
        await act(async () => { await hook.getCurrent().allow?.(); });
        expect(hook.getCurrent().allowance).toEqual({ kind: 'idle' });
        await hook.unmount();
    });

    it('offers no control without an Action to run, and reads a thrown request as a failed one', async () => {
        const none = await renderHook(() => useBrowserSandboxAllowance(undefined));
        expect(none.getCurrent().allow).toBeUndefined();
        await none.unmount();
        const hook = await renderHook(() => useBrowserSandboxAllowance(async () => { throw new Error('offline'); }));
        await act(async () => { await hook.getCurrent().allow?.(); });
        expect(hook.getCurrent().allowance).toEqual({ kind: 'settled', outcome: { status: 'failed', code: 'request_failed' } });
        await hook.unmount();
    });
});

describe('describeBrowserSandboxAllowance', () => {
    it('reads a missing system permission as a warning, any other failure as an error, and success as success', () => {
        expect(describeBrowserSandboxAllowance({ status: 'failed', code: 'os_authorization_required' }).kind).toBe('warning');
        expect(describeBrowserSandboxAllowance({ status: 'failed', code: 'sandbox_install_failed' })).toMatchObject({ kind: 'error', code: 'sandbox_install_failed' });
        expect(describeBrowserSandboxAllowance({ status: 'installed' }, 'Claude').kind).toBe('success');
    });
});
