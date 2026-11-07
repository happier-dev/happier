import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { useEnvironmentBindingApprovalChoice } from './useEnvironmentBindingApprovalChoice';
import type { SavedSecretPickerModal } from '@/components/ui/forms/valueRefs/SavedSecretPickerModal';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { Modal } = await import('@/modal');
// The actual lazy owners keep running in the hook; their cold Vitest transforms
// belong to collection, before the interaction's assertion window.
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
await import('@/components/ui/forms/valueRefs/presentSavedSecretReferencePicker');
beforeEach(async () => { await homes.reset(); });
afterEach(async () => { standardCleanup(); await homes.reset(); vi.clearAllMocks(); });

async function addCurrentHome() {
    const serverId = await homes.addHome({ name: 'Approval', serverUrl: 'https://binding-approval.test',
        accountId: 'account', currentAccount: true });
    const captured = await captureLazyActionAccountContext(serverId);
    try {
        expect({ authority: captured.credentialAuthorityKind, accountId: captured.accountId,
            current: captured.accountLifetime.isCurrent() }).toEqual({ authority: 'account', accountId: 'account', current: true });
    } finally { captured.dispose(); }
    return serverId;
}

function request(): ApprovalRequestV2 {
    return ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        actionId: 'deployments.bindings.set', summary: 'Set binding', requestedSurface: 'agent',
        actionArgs: { serverId: 'home', environmentId: 'environment', expectedRevision: 7,
            set: [{ purpose: 'variable', name: 'API_TOKEN', phase: 'runtime',
                source: { kind: 'secret', ref: 'person_selects' } }], remove: [] },
        createdBy: { surface: 'agent', sessionId: 'session' },
        executionOriginV1: { v: 1, actionId: 'deployments.bindings.set', requestId: 'request',
            authority: 'account_automation', surface: 'agent', serverId: 'home', accountId: 'account',
            caller: { kind: 'session', sessionId: 'session', starterDepth: 0, turnDepth: 0 } },
    });
}

function pickerDelivery(index: number) {
    const modal = vi.mocked(Modal.show<typeof SavedSecretPickerModal>).mock.calls[index]?.[0];
    const props = modal?.props;
    if (!modal || !props || !('referenceSelection' in props) || !modal.onRequestClose) {
        throw new Error('Expected the Saved Secret reference-selection modal');
    }
    return { props, onRequestClose: modal.onRequestClose };
}

describe('Environment binding approval choice', () => {
    it('requests no material or choice before the person acts and leaves terminal and unrelated approvals alone', async () => {
        const approval = request();
        const hook = await renderHook((value: ReturnType<typeof request>) => useEnvironmentBindingApprovalChoice({
            artifactId: 'approval', approval: value, serverId: 'home',
        }), { initialProps: approval });
        expect(hook.getCurrent().needsChoiceBeforeApprove).toBe(true);
        expect(hook.getCurrent().reviewRequest).toBe(approval);
        expect(hook.getCurrent().decisionOptions).toEqual({});
        expect(homes.requests).toEqual([]);
        expect(Modal.show).not.toHaveBeenCalled();
        await hook.rerender({ ...approval, status: 'canceled' });
        expect(hook.getCurrent().needsChoiceBeforeApprove).toBe(false);
        await hook.rerender({ ...approval, actionId: 'session.list' });
        expect(hook.getCurrent().needsChoiceBeforeApprove).toBe(false);
    });

    it('refreshes exact local review without normalizing the signed patch or recording consent', async () => {
        const serverId = await addCurrentHome();
        const base = request();
        const actionArgs = { serverId: 'home', environmentId: 'environment', expectedRevision: 7,
            set: [{ purpose: 'dataRole', service: ' database ', role: 'readOnlyPassword',
                source: { kind: 'secret', ref: 'person_selects' } },
            { purpose: 'variable', name: 'URL', phase: 'runtime', source: { kind: 'reference',
                environmentId: 'source', export: ' database ', via: 'auto' } }],
            remove: [{ purpose: 'domainCredential', domainId: 'domain', role: 'basicAuth' }] };
        const approval: ApprovalRequestV2 = { ...base, actionArgs,
            preview: { actionId: base.actionId, actionArgs } };
        const hook = await renderHook((value: ApprovalRequestV2) => useEnvironmentBindingApprovalChoice({
            artifactId: 'approval', approval: value, serverId,
        }), { initialProps: approval });
        let choosing: Promise<void> | undefined;
        await act(async () => { choosing = hook.getCurrent().choose(); });
        await vi.waitFor(() => expect(Modal.show).toHaveBeenCalledTimes(1));
        // The native modal delivery is the boundary. Picker validation and the
        // captured Account lifetime remain the production owners.
        const modal = pickerDelivery(0);
        // A body reader reparses unchanged signed JSON while the picker is open.
        await hook.rerender(ApprovalRequestV2Schema.parse(approval));
        const selected = { ref: formatSharedSavedSecretRefV1('credential'), resourceRevision: 3 };
        await act(async () => { modal.props.referenceSelection.onSelect(selected); await choosing; });
        const expected = { ...actionArgs, set: [{ ...actionArgs.set[0],
            source: { kind: 'secret', ...selected } }, actionArgs.set[1]] };
        expect(hook.getCurrent().needsChoiceBeforeApprove).toBe(false);
        expect(hook.getCurrent().decisionOptions).toEqual({ narrowedInput: expected });
        expect(hook.getCurrent().reviewRequest?.actionArgs).toEqual(expected);
        expect(hook.getCurrent().reviewRequest?.preview).toBeUndefined();
        expect(approval.preview).toEqual({ actionId: base.actionId, actionArgs });
        await hook.rerender(ApprovalRequestV2Schema.parse(approval));
        expect(hook.getCurrent().reviewRequest?.actionArgs).toEqual(expected);
        expect(hook.getCurrent().needsChoiceBeforeApprove).toBe(false);
        expect(actionArgs.set[0]?.source.ref).toBe('person_selects');
        expect(homes.requestsFor('/v1/deployments/environments/environment/bindings')).toEqual([]);
        expect(homes.requests.some(value => value.input !== null)).toBe(false);
        await hook.rerender({ ...approval, actionArgs: { ...actionArgs, expectedRevision: 8 } });
        expect(hook.getCurrent().needsChoiceBeforeApprove).toBe(true);
        expect(hook.getCurrent().decisionOptions).toEqual({});
        // A reloaded receipt has no local choice; its saved decision, not the
        // original pending preview, supplies the historical review.
        const settled = ApprovalRequestV2Schema.parse({ ...approval, status: 'executed',
            decision: { kind: 'approve', decidedAtMs: 2, narrowedInput: expected },
            execution: { executedAtMs: 2, ok: true, result: {} } });
        const reloaded = await renderHook(() => useEnvironmentBindingApprovalChoice({
            artifactId: 'approval', approval: settled, serverId,
        }));
        expect(reloaded.getCurrent().reviewRequest?.actionArgs).toEqual(expected);
        expect(reloaded.getCurrent().reviewRequest?.preview).toBeUndefined();
        expect(reloaded.getCurrent().needsChoiceBeforeApprove).toBe(false);
        expect(reloaded.getCurrent().decisionOptions).toEqual({});
    });

    it('ignores cancellation and late choices after the approval, Account or Home scope retires', async () => {
        const serverId = await addCurrentHome();
        const approval = request();
        const hook = await renderHook((value: { approval: typeof approval; serverId: string }) => useEnvironmentBindingApprovalChoice({
            artifactId: 'approval', ...value,
        }), { initialProps: { approval, serverId } });
        let choosing: Promise<void> | undefined;
        await act(async () => { choosing = hook.getCurrent().choose(); });
        await vi.waitFor(() => expect(Modal.show).toHaveBeenCalledTimes(1));
        const canceled = pickerDelivery(0);
        await act(async () => { canceled.onRequestClose(); await choosing; });
        expect(hook.getCurrent().decisionOptions).toEqual({});
        await act(async () => { choosing = hook.getCurrent().choose(); });
        await vi.waitFor(() => expect(Modal.show).toHaveBeenCalledTimes(2));
        const late = pickerDelivery(1);
        await hook.rerender({ approval: { ...approval, status: 'canceled' }, serverId });
        await act(async () => { late.props.referenceSelection.onSelect({
            ref: formatSharedSavedSecretRefV1('credential'), resourceRevision: 3 }); await choosing; });
        expect(hook.getCurrent().decisionOptions).toEqual({});
        await hook.rerender({ approval, serverId });
        await act(async () => { choosing = hook.getCurrent().choose(); });
        await vi.waitFor(() => expect(Modal.show).toHaveBeenCalledTimes(3));
        const oldAccount = pickerDelivery(2);
        await act(async () => { await homes.switchAccount(serverId, 'another-account', { currentAccount: true }); });
        await act(async () => { oldAccount.props.referenceSelection.onSelect({
            ref: formatSharedSavedSecretRefV1('credential'), resourceRevision: 3 }); await choosing; });
        expect(hook.getCurrent().decisionOptions).toEqual({});
        await homes.switchAccount(serverId, 'account', { currentAccount: true });
        await act(async () => { choosing = hook.getCurrent().choose(); });
        await vi.waitFor(() => expect(Modal.show).toHaveBeenCalledTimes(4));
        const oldHome = pickerDelivery(3);
        await hook.rerender({ approval, serverId: 'another-home' });
        await act(async () => { oldHome.props.referenceSelection.onSelect({
            ref: formatSharedSavedSecretRefV1('credential'), resourceRevision: 3 }); await choosing; });
        expect(hook.getCurrent().decisionOptions).toEqual({});
        expect(homes.requestsFor('/v1/deployments/environments/environment/bindings')).toEqual([]);
    });
});
