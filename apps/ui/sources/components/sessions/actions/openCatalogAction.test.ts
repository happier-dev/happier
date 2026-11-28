import { beforeEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { openCatalogAction } from './openCatalogAction';
import { Modal } from '@/modal';
import { t } from '@/text';

// Resolve the real presentation graph during collection, outside the interaction's timeout.
await Promise.all([
    import('@/sync/ops/actions/resolveActionExecutionFailureMessage'),
    import('@/components/plugins/actions/actionInputForm'),
    import('@/components/plugins/actions/presentActionInputForm'),
    import('@/sync/domains/scope/activeServerAccountScope'),
]);

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

beforeEach(() => vi.clearAllMocks());

it('presents a direct Action refusal with its original code through the shared failure disclosure', async () => {
    const failure = { ok: false as const, errorCode: 'unsupported_action', error: 'unsupported_action', requestId: 'request-1' };
    await expect(openCatalogAction({ spec: getActionSpec('session.pending.next'), context: {},
        execute: async () => failure })).resolves.toBeUndefined();
    const alert = vi.mocked(Modal.alert).mock.calls.at(-1);
    expect(alert).toBeDefined();
    const details = alert?.[2]?.find(button => button.quiet === true);
    expect(details).toBeDefined();
    details?.onPress?.();
    expect(vi.mocked(Modal.alert).mock.calls.at(-1)?.[1]).toContain(failure.errorCode);
    expect(vi.mocked(Modal.alert).mock.calls.at(-1)?.[1]).toContain(failure.requestId);
});

it.each(['direct', 'form'] as const)('discloses a Before-check approval receipt on the %s path', async path => {
    const actionId = path === 'direct' ? 'session.pending.next' : 'session.open';
    const result = { ok: true as const, result: { kind: 'approval_request_created' as const,
        actionId, artifactId: 'before-check-approval' } };
    await openCatalogAction({ spec: getActionSpec(actionId), context: {}, execute: async () => result });
    if (path === 'form') {
        const shown = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
        const form = (shown as unknown as { props: { form: import('@/components/plugins/actions/actionInputForm').ActionInputForm } }).props.form;
        form.replaceInput({ ...form.getInput(), sessionId: 'session-a' });
        await form.submit();
    }
    expect(Modal.alert).toHaveBeenCalledWith(t('toolView.approvalRequested.title'), t('toolView.approvalRequested.description'));
});
