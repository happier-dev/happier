import { beforeEach, expect, it, vi } from 'vitest';

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
import { alertBrowserContextUnavailable } from '@/components/sessions/browser/alertBrowserContextUnavailable';
import { alertComposerActionResultFailure } from '@/components/sessions/composer/alertComposerFailure';
import { alertApprovalFailure } from '@/components/tools/shell/approvals/useApprovalDecisionHandler';

beforeEach(() => vi.clearAllMocks());

function revealDetails() {
    const buttons = vi.mocked(Modal.alert).mock.calls.at(-1)?.[2];
    const technical = buttons?.find(button => button.text === t('approvals.technicalDetails'));
    expect(technical).toBeDefined();
    technical?.onPress?.();
    const details = String(vi.mocked(Modal.alert).mock.calls.at(-1)?.[1]);
    return details.startsWith('{') ? JSON.parse(details) : { code: details };
}

// Sanitized real refusal from UI-INT-REPLAY-1111B/browser-action-failure-desktop.json.
const refusal = {
    error: 'runtime_action_disabled:browser:browser_context_annotation_unavailable',
    errorCode: 'runtime_action_disabled',
    ok: false as const,
    requestId: 'a794c7ec-0f9f-4747-bc2c-88ebc6e2ab2d',
};

it.each([
    ['Browser', alertBrowserContextUnavailable],
    ['composer Action result', alertComposerActionResultFailure],
    ['approval', alertApprovalFailure],
] as const)('%s preserves the real refusal code and request ID in deliberate Technical details', (_name, present) => {
    present(refusal);
    expect(vi.mocked(Modal.alert).mock.calls[0]?.[1]).not.toContain(refusal.requestId);
    expect(revealDetails()).toEqual({ code: refusal.errorCode, requestId: refusal.requestId });
});

it('keeps Browser failure cause and safe details alongside the request ID without page or transport text', () => {
    alertBrowserContextUnavailable({ ...refusal, error: 'private transport text',
        details: { reasonCode: 'browser_context_annotation_unavailable', path: '/private/page' },
        failureCause: { phase: 'browser.context.annotation.start', errorClass: 'Error',
            errorCode: 'machine_socket_unavailable', httpStatus: null } });
    expect(revealDetails()).toEqual({ code: refusal.errorCode, requestId: refusal.requestId,
        reasonCode: 'browser_context_annotation_unavailable', phase: 'browser.context.annotation.start',
        errorClass: 'Error', causeCode: 'machine_socket_unavailable', httpStatus: null });
});
