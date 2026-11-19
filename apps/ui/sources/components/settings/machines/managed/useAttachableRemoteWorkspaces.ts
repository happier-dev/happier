import * as React from 'react';

import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { isMachineProvisionerCredentialPurposeRequiredV1,
    isMachineProvisionerWorkspaceAttachmentV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { createManagedCredentialSelectionV1, type ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { useManagedControllerScope } from './useManagedControllerScope';
import { useManagedProvisioners } from './useManagedProvisioners';
import { attachRemoteWorkspace, readAttachableRemoteWorkspaces,
    type AttachableRemoteWorkspaceAccount, type AttachableRemoteWorkspaceRequest,
    type AttachRemoteWorkspaceChoice, type AttachRemoteWorkspaceOutcome } from './attachableRemoteWorkspaceActions';

const attachSelectors = { attachExisting: true } as const;
type Account = Readonly<{
    bindingId: string;
    title: string;
    controller: ManagedControllerV1 & Readonly<{ name: string }>;
    workspaces: AttachableRemoteWorkspaceAccount['workspaces'];
}>;
type AccountChoice = Omit<Account, 'workspaces'>;
type Candidate = Readonly<{ account: AccountChoice; request: AttachableRemoteWorkspaceRequest }>;
type Settlement = Readonly<{
    request: AttachableRemoteWorkspaceRequest;
    retryRevision: number;
    result: Awaited<ReturnType<typeof readAttachableRemoteWorkspaces>>;
}>;
export type AttachableRemoteWorkspaces = Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'choose_account'; accounts: readonly AccountChoice[] }>
    | Readonly<{ kind: 'ready'; accounts: readonly Account[];
        attach(input: AttachRemoteWorkspaceChoice & Readonly<{ bindingId: string }>): Promise<AttachRemoteWorkspaceOutcome> }>
    | Readonly<{ kind: 'failed'; code: string; message: string | null; retry(): void }>;

export function useAttachableRemoteWorkspaces(input: Readonly<{
    serverId: string;
    open: boolean;
    bindingId?: string;
    onApprovalPending?: (registration: ActionApprovalRegistration) => void;
}>): AttachableRemoteWorkspaces {
    const approval = React.useRef(input.onApprovalPending);
    approval.current = input.onApprovalPending;
    const onApprovalPending = React.useCallback((registration: ActionApprovalRegistration) => approval.current?.(registration), []);
    const controllerScope = useManagedControllerScope({ serverId: input.serverId, disabled: !input.open,
        observeThisComputer: false, testIDPrefix: 'project-remote-workspace.controller' });
    const controller = controllerScope.controller;
    const machineId = controller?.machineId;
    const installationId = controller?.installationId;
    const controllerName = controllerScope.machine?.metadata?.name;
    const catalog = useManagedProvisioners(input.serverId, onApprovalPending, controller, { enabled: input.open && !!controller });
    const { binding, current, homeId, provisioners, isCurrentFor } = catalog;
    const candidates = React.useMemo<readonly Candidate[]>(() => {
        if (!input.open || !binding?.isCurrent() || !current || !homeId || !machineId || !installationId) return [];
        const selectedController = { machineId, installationId };
        return provisioners.flatMap(provisioner => {
            const { descriptor, contribution } = provisioner;
            if (!isCurrentFor(buildQualifiedPluginContributionKey(contribution))
                || !isMachineProvisionerWorkspaceAttachmentV1(descriptor, attachSelectors, 'options')) return [];
            const required = provisioner.credentialPurposes?.filter(({ purpose }) =>
                isMachineProvisionerCredentialPurposeRequiredV1(descriptor, purpose.purpose, attachSelectors));
            // The attachment listing is for a person's own connected Account.
            // F8 authorizes the exact selected binding on each Home Action.
            if (required?.length !== 1) return [];
            const { purpose, options } = required[0]!;
            return options.flatMap(({ label, value }) => {
                if (!('accountId' in value)) return [];
                return [{
                    account: {
                        bindingId: JSON.stringify([selectedController, provisioner.occurrenceId, purpose, value]),
                        title: label, controller: { ...selectedController, name: controllerName || machineId },
                    },
                    request: { scope: binding.scope, homeId, controller: selectedController, contribution, descriptor,
                        credentials: [createManagedCredentialSelectionV1(purpose, value)], selectors: attachSelectors },
                }];
            });
        });
    }, [binding, current, homeId, input.open, installationId, isCurrentFor, machineId, controllerName, provisioners]);

    const candidate = input.bindingId ? candidates.find(({ account }) => account.bindingId === input.bindingId) : undefined;
    const request = candidate?.request;
    const [settlement, setSettlement] = React.useState<Settlement>();
    const [retryRevision, retry] = React.useReducer(value => value + 1, 0);
    React.useEffect(() => {
        if (!binding || !request) return;
        const abort = new AbortController();
        const retirement = binding.onRetire(() => abort.abort());
        const publish = (result: Settlement['result']) => {
            if (!abort.signal.aborted && binding.isCurrent()) setSettlement({ request, retryRevision, result });
        };
        void readAttachableRemoteWorkspaces({ ...request, signal: abort.signal,
            onApprovalPending: approval.current ? onApprovalPending : undefined })
            .then(publish, () => publish({ kind: 'failed', code: 'provider_unavailable', message: null }));
        return () => { abort.abort(); retirement.dispose(); };
    }, [binding, request, onApprovalPending, retryRevision]);

    const selection = settlement?.request === request && settlement?.retryRevision === retryRevision ? settlement : undefined;
    const currentSelection = React.useRef<Settlement | undefined>(undefined);
    currentSelection.current = selection;
    React.useEffect(() => () => { currentSelection.current = undefined; }, []);
    if (!input.open) return { kind: 'loading' };
    if ((!controller && controllerScope.machineList === 'unavailable') || catalog.error) {
        return { kind: 'failed', code: catalog.error ?? 'target_unavailable', message: null, retry: catalog.refresh };
    }
    if (!controller && controllerScope.machineList === 'settled') return { kind: 'choose_account', accounts: [] };
    if (!binding || !current) return { kind: 'loading' };
    if (!candidate) return { kind: 'choose_account', accounts: candidates.map(({ account }) => account) };
    if (!selection) return { kind: 'loading' };
    const { result } = selection;
    if (result.kind === 'failed') return { ...result, retry };
    return {
        kind: 'ready',
        accounts: [{ ...candidate.account, workspaces: result.workspaces }],
        attach: async choice => {
            if (choice.bindingId !== candidate.account.bindingId || currentSelection.current !== selection || !binding.isCurrent()) {
                return { kind: 'failed', code: 'target_unavailable', message: null };
            }
            const retired = new AbortController();
            const retirement = binding.onRetire(() => retired.abort());
            const cancellation = mergeAbortSignals([choice.signal, retired.signal]);
            try {
                return await attachRemoteWorkspace({ ...choice, account: result, signal: cancellation.signal ?? choice.signal });
            } finally {
                cancellation.dispose();
                retirement.dispose();
            }
        },
    };
}
