import * as React from 'react';
import { useActiveServerAccountScope, useProfile } from '@/sync/store/hooks';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { useConnectedServicesIndex } from '../model/useConnectedServicesIndex';
import { buildConnectedServiceSetupCatalog } from './buildConnectedServiceSetupCatalog';
import { useConnectedAccountPurposeSetup } from './useConnectedAccountPurposeSetup';
import { resolveConnectSheetOpening } from './connectSheetOpening';
import type { ConnectedServiceSetupTarget } from './ConnectedServiceSetupPanel';
import type { ConnectSheetAccountRequest, ConnectSheetAccountResult } from './ConnectedServiceSetupModal';

/** Account inventory, purpose admission and returned selection belong to their existing owners. */
export function useConnectAccountSheetModel(request: ConnectSheetAccountRequest,
    onResult: (result: ConnectSheetAccountResult) => void) {
    const viewer = useActiveServerAccountScope();
    const profiles = useProfile(profile => profile.connectedAccountsV4);
    const close = React.useCallback(() => onResult({ kind: 'dismissed' }), [onResult]);
    const selectedTarget = React.useMemo(() => request.account ? { kind: 'account' as const, account: request.account } : null, [request.account]);
    const settle = React.useCallback((account: QualifiedConnectedAccountRef, kind: 'selected' | 'connected') =>
        onResult({ kind, account }), [onResult]);
    const purposeSetup = useConnectedAccountPurposeSetup({ request: request.purposeRequest ?? null,
        selectedTarget, onClose: close,
        ...(request.purposeSettlement === 'resourceDefault' ? { onSettled: settle } : { onSelected: settle }) });
    const { indexModel } = useConnectedServicesIndex({ agents: 'cached', registry: purposeSetup.registry,
        targetSelection: request.targetSelection });
    const catalog = React.useMemo(() => purposeSetup.filterCatalog(buildConnectedServiceSetupCatalog(indexModel)),
        [indexModel, request.purposeRequest, purposeSetup.declaration]);
    const [target, setTarget] = React.useState<ConnectedServiceSetupTarget>(() => {
        if (!request.service) return { kind: 'catalog' };
        const serviceKey = buildQualifiedPluginContributionKey(request.service);
        return request.intent === 'reconnect' && request.account
            ? { kind: 'reconnect', serviceKey, accountId: request.account.accountId } : { kind: 'service', serviceKey };
    });
    const demandKey = JSON.stringify([viewer, target]);
    const [machineDemand, setMachineDemand] = React.useState<Readonly<{ key: string; required: boolean }> | null>(null);
    const machineRequired = machineDemand?.key === demandKey ? machineDemand.required : false;
    const onMachineRequirementChange = React.useCallback((required: boolean) => setMachineDemand(current =>
        current?.key === demandKey && current.required === required ? current : { key: demandKey, required }), [demandKey]);
    const selectedService = target.kind === 'catalog' ? null : catalog.find(entry => entry.serviceKey === target.serviceKey)?.service;
    const services = React.useMemo(() => selectedService ? [selectedService]
        : request.service ? [request.service] : purposeSetup.declaration?.serviceRefs,
        [selectedService, request.service, purposeSetup.declaration]);
    const savedAccounts = React.useMemo(() => profiles.filter(profile => !services || services.some(service =>
        service.pluginId === profile.ref.service.pluginId && service.localId === profile.ref.service.localId)), [profiles, services]);
    const opening = resolveConnectSheetOpening(selectedService ? { ...request, service: selectedService } : request,
        { accounts: savedAccounts, services });
    const onSelected = (account: QualifiedConnectedAccountRef) => {
        if (request.purposeRequest) void purposeSetup.select({ kind: 'account', account });
        else onResult({ kind: 'selected', account });
    };
    const onConnected = (account: QualifiedConnectedAccountRef) => {
        if (request.purposeRequest) purposeSetup.onConnected(account);
        else onResult({ kind: 'connected', account });
    };
    return { initialMode: opening.initialMode, preselected: typeof opening.preselected === 'object' ? opening.preselected : null,
        savedAccounts, catalog, target, setTarget, onSelected, onConnected, close, purposeSetup, machineRequired, onMachineRequirementChange,
        unavailableReason: request.scope !== undefined && !areServerAccountScopesEqual(request.scope, viewer)
            ? 'account_scope_mismatch' as const : purposeSetup.unavailableReason };
}
