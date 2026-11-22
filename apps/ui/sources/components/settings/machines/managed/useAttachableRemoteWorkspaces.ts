import * as React from 'react';

import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/publicTypes';
import { isMachineProvisionerCredentialPurposeRequiredV1,
    isMachineProvisionerWorkspaceAttachmentV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { createManagedCredentialSelectionV1, type ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { useRemoteHostCatalogSnapshot } from '@/sync/store/settings/remoteHostCatalogSnapshot';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { useManagedControllerScope } from './useManagedControllerScope';
import { useManagedProvisioners } from './useManagedProvisioners';
import { attachRemoteWorkspace, readAttachableRemoteWorkspaces,
    type AttachableRemoteWorkspaceAccount, type AttachableRemoteWorkspaceRequest,
    type AttachRemoteWorkspaceChoice, type AttachRemoteWorkspaceOutcome } from './attachableRemoteWorkspaceActions';

const attachSelectors = { attachExisting: true } as const;
function bindsSavedRemoteHost({ workspaceAttachment }: AttachableRemoteWorkspaceRequest['descriptor']): boolean {
    return workspaceAttachment?.resourceIdentityPaths?.includes('remoteHostId') === true;
}

type Account = Readonly<{
    bindingId: string;
    title: string;
    workspaceId?: string;
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
    /**
     * A saved Remote Host (Remote Hosts "Use folders here"): the provisioners that attach it by id are the choices,
     * with no connected-account step; the controller binds the host's own saved credential.
     */
    remoteHostId?: string;
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
    const controllerName = machineId
        ? getMachineDisplayName(controllerScope.machine ?? { id: machineId, absence: 'unlisted' })
        : null;
    const catalog = useManagedProvisioners(input.serverId, onApprovalPending, controller, {
        enabled: input.open && !!controller,
        controllerOnly: true,
    });
    const { binding, current, homeId, provisioners, isCurrentFor } = catalog;
    const { remoteHostId } = input;
    const available = React.useMemo(() => current ? provisioners.filter(({ contribution }) =>
        isCurrentFor(buildQualifiedPluginContributionKey(contribution))) : [], [current, provisioners, isCurrentFor]);
    const readSavedHosts = !remoteHostId && available.some(({ descriptor }) => bindsSavedRemoteHost(descriptor));
    const hostCatalog = useRemoteHostCatalogSnapshot(readSavedHosts ? binding?.scope : null);
    const savedHosts = hostCatalog?.data;
    const candidates = React.useMemo<readonly Candidate[]>(() => {
        if (!input.open || !binding?.isCurrent() || !current || !homeId || !machineId || !installationId || !controllerName) return [];
        const selectedController = { machineId, installationId };
        return available.flatMap<Candidate>(({ descriptor, contribution, occurrenceId, credentialPurposes }) => {
            const request = { scope: binding.scope, homeId, controller: selectedController, contribution, descriptor };
            const controller = { ...selectedController, name: controllerName };
            if (bindsSavedRemoteHost(descriptor)) {
                const hosts = remoteHostId ? [{ id: remoteHostId, name: resolvePluginLocalizedStringV2Text(descriptor.title) }]
                    : savedHosts ?? [];
                return hosts.flatMap(({ id, name }) => {
                    const selectors = { remoteHostId: id };
                    if (!isMachineProvisionerWorkspaceAttachmentV1(descriptor, selectors, 'options')
                        || credentialPurposes?.some(({ purpose }) =>
                            isMachineProvisionerCredentialPurposeRequiredV1(descriptor, purpose.purpose, selectors))) return [];
                    return [{
                        account: { bindingId: JSON.stringify([selectedController, occurrenceId, id]), title: name, controller, workspaceId: id },
                        request: { ...request, selectors },
                    }];
                });
            }
            if (remoteHostId || !isMachineProvisionerWorkspaceAttachmentV1(descriptor, attachSelectors, 'options')) return [];
            const required = credentialPurposes?.filter(({ purpose }) =>
                isMachineProvisionerCredentialPurposeRequiredV1(descriptor, purpose.purpose, attachSelectors));
            // The attachment listing is for a person's own connected Account.
            // F8 authorizes the exact selected binding on each Home Action.
            if (required?.length !== 1) return [];
            const { purpose, options } = required[0]!;
            return options.flatMap(({ label, value }) => {
                if (!('accountId' in value)) return [];
                return [{
                    account: {
                        bindingId: JSON.stringify([selectedController, occurrenceId, purpose, value]),
                        title: label, controller,
                    },
                    request: { ...request,
                        credentials: [createManagedCredentialSelectionV1(purpose, value)], selectors: attachSelectors },
                }];
            });
        });
    }, [binding, current, homeId, input.open, installationId, machineId, controllerName, available, remoteHostId, savedHosts]);

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
    const controllerOffline = controllerScope.machineList === 'settled'
        && controllerScope.hasCandidates && !controllerScope.hasOnlineCandidate;
    if (!controller && (controllerScope.machineList === 'unavailable' || controllerOffline)) {
        return { kind: 'failed', code: 'target_unavailable',
            message: controllerOffline ? t('errors.machineNotAnswering') : null,
            retry: () => { void getSyncSingleton().refreshMachines({ serverId: input.serverId }).catch(() => {}); } };
    }
    if (catalog.error) return { kind: 'failed', code: catalog.error, message: null, retry: catalog.refresh };
    if (!controller && controllerScope.machineList === 'settled') return { kind: 'choose_account', accounts: [] };
    if (!binding || !current) return { kind: 'loading' };
    // Wait to choose a source until the host catalog answers, so an Account cannot auto-open ahead of its hosts.
    const loadingHosts = readSavedHosts && !savedHosts && (!hostCatalog || hostCatalog.catalog.status === 'loading');
    if (!candidate && (catalog.loading || loadingHosts)) return { kind: 'loading' };
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
