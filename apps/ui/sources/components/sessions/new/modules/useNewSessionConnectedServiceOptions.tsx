import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { connectedEntitySubjectKeyV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import type { ConnectedAccountServiceKey } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { PluginProjectedAgentConnectedAccountPurposeV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { Profile } from '@/sync/domains/profiles/profile';
import { storage } from '@/sync/domains/state/storageStore';
import type { StorageState } from '@/sync/store/types';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { useConnectedMetadataCatalog } from '@/hooks/server/connectedServices/useConnectedMetadataCatalog';
import type { ConnectedMetadataCatalogSnapshot } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';
import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { resolveQualifiedConnectedAccountServiceKey } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { applyProjectedCredentialKindRestrictions, buildQualifiedConnectedAccountGroupOptionsByServiceId,
    buildQualifiedConnectedAccountProfileOptionsByServiceId } from '@/sync/domains/connectedServices/qualifiedConnectedAccountServiceOptions';

type Account = Profile['connectedAccountsV4'][number];
type Group = Profile['connectedAccountGroupsV4'][number];
type Revision = Profile['connectedServiceCredentialRevisionsV1'][number];
type SelectionBindings = Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
export type NewSessionConnectedServiceOptionsInput = Readonly<{
    connectedAccounts: readonly PluginProjectedAgentConnectedAccountPurposeV2[];
    supportedServiceIds: readonly ConnectedAccountServiceKey[];
    scope: ServerAccountScope | null | undefined;
    resolveServiceTitle: (serviceId: string) => string;
}>;

const EMPTY_SUPPORTED_SERVICE_IDS: readonly ConnectedAccountServiceKey[] = [];
const EMPTY_CONNECTED_ACCOUNTS: readonly PluginProjectedAgentConnectedAccountPurposeV2[] = [];
const EMPTY_SELECTED_BINDINGS: readonly SelectionBindings[] = [];

/** The same option classification serves launch summaries and the mounted inventory. */
export function useNewSessionConnectedServiceOptions(
    input: NewSessionConnectedServiceOptionsInput | null,
    /** Omitted only in the mounted picker. Closed callers project their selected targets. */
    selectedTargets?: readonly SelectionBindings[],
) {
    const selectedBindings = input ? selectedTargets : EMPTY_SELECTED_BINDINGS;
    const supportedServiceIds = input?.supportedServiceIds ?? EMPTY_SUPPORTED_SERVICE_IDS;
    const connectedAccounts = input?.connectedAccounts ?? EMPTY_CONNECTED_ACCOUNTS;
    const resolveServiceTitle = input?.resolveServiceTitle;
    const selections = React.useMemo(() => selectedBindings?.flatMap(bindings => Object.entries(bindings)
        .flatMap(([serviceId, binding]) => binding?.source === 'connected'
            ? [{ serviceId: resolveQualifiedConnectedAccountServiceKey(serviceId) ?? serviceId, binding }] : [])), [selectedBindings]);
    // Selected names use the same peer census as the open list, including duplicate-name numbering.
    const requestedServiceIds = React.useMemo(() => new Set(selections?.length === 0 ? []
        : [...supportedServiceIds, ...(selections?.map(selection => selection.serviceId) ?? [])]),
        [selections, supportedServiceIds]);
    const rows = storage(useShallow(React.useCallback((state: StorageState) => {
        const result: Record<string, Account | Group | Revision> = {};
        if (requestedServiceIds.size === 0) return result;
        for (const account of state.profile.connectedAccountsV4) {
            const serviceId = buildQualifiedPluginContributionKey(account.ref.service);
            if (requestedServiceIds.has(serviceId)) result[connectedEntitySubjectKeyV1({ kind: 'account', account: account.ref })] = account;
        }
        for (const group of state.profile.connectedAccountGroupsV4) {
            const serviceId = buildQualifiedPluginContributionKey(group.ref.service);
            if (requestedServiceIds.has(serviceId) && (!selections || selections.some(selection => selection.serviceId === serviceId
                && selection.binding.selection === 'group' && selection.binding.groupId === group.ref.groupId))) {
                result[connectedEntitySubjectKeyV1({ kind: 'group', ...group.ref })] = group;
            }
        }
        for (const revision of state.profile.connectedServiceCredentialRevisionsV1) {
            const serviceId = resolveQualifiedConnectedAccountServiceKey(revision.serviceId);
            if (serviceId && requestedServiceIds.has(serviceId)) result[`revision:${JSON.stringify([serviceId, revision.profileId])}`] = revision;
        }
        return result;
    }, [requestedServiceIds, selections])), { profile: requestedServiceIds.size === 0 ? []
        : ['connectedAccountsV4', 'connectedAccountGroupsV4', 'connectedServiceCredentialRevisionsV1'] });
    const source = React.useMemo(() => {
        const values = Object.values(rows);
        return {
            accounts: values.filter((row): row is Account => 'ref' in row && 'accountId' in row.ref),
            groups: values.filter((row): row is Group => 'ref' in row && 'groupId' in row.ref),
            revisions: values.filter((row): row is Revision => 'serviceId' in row),
        };
    }, [rows]);
    const selectedAccounts = React.useMemo(() => {
        if (!selections) return source.accounts;
        const serviceAvailabilityWitnesses = new Set<string>();
        return source.accounts.filter(account => {
            const serviceId = buildQualifiedPluginContributionKey(account.ref.service);
            return selections.some(({ serviceId: selectedServiceId, binding }) => {
                if (serviceId !== selectedServiceId) return false;
                if (binding.selection === 'profile') return !binding.profileId || binding.profileId === account.ref.accountId;
                // The canonical auth classifier also distinguishes an unavailable
                // pool from a disabled pool with available accounts in its service.
                // One witness per observed kind/status preserves that fact without
                // constructing every unselected account option or reclassifying it.
                const witness = JSON.stringify([serviceId, account.kind ?? null, account.status]);
                const includeWitness = !serviceAvailabilityWitnesses.has(witness);
                serviceAvailabilityWitnesses.add(witness);
                const group = source.groups.find(group => buildQualifiedPluginContributionKey(group.ref.service) === serviceId && group.ref.groupId === binding.groupId);
                return includeWitness || group?.activeConnectedAccountId === account.ref.accountId || binding.appliedProfileId === account.ref.accountId
                    || group?.members.some(member => member.enabled && member.connectedAccountId === account.ref.accountId) === true;
            });
        });
    }, [selections, source]);
    const selectLabels = useShallow(React.useCallback((snapshot: ConnectedMetadataCatalogSnapshot) => {
        const labels: Record<string, string | undefined> = {};
        for (const account of source.accounts) {
            const key = connectedEntitySubjectKeyV1({ kind: 'account', account: account.ref });
            labels[key] = snapshot.labelsByKey[key];
        }
        for (const group of source.groups) {
            const key = connectedEntitySubjectKeyV1({ kind: 'group', ...group.ref });
            labels[key] = snapshot.labelsByKey[key];
        }
        return labels;
    }, [source]));
    const labelsByKey = useConnectedMetadataCatalog(input ? input.scope : null, selectLabels, { enabled: input !== null && selectedBindings === undefined });
    const { present } = useConnectedAccountIdentityPrivacy();
    const profileOptionsByServiceId = React.useMemo(() => applyProjectedCredentialKindRestrictions({
        optionsByServiceId: buildQualifiedConnectedAccountProfileOptionsByServiceId({
            accounts: selectedAccounts, presentationAccounts: source.accounts, supportedServiceIds, labelsByKey,
            presentIdentity: present, resolveServiceTitle,
        }), connectedAccounts,
    }), [selectedAccounts, source.accounts, supportedServiceIds, labelsByKey, present, resolveServiceTitle, connectedAccounts]);
    const groupOptionsByServiceId = React.useMemo(() => buildQualifiedConnectedAccountGroupOptionsByServiceId({
        groups: source.groups, supportedServiceIds, labelsByKey,
    }), [source.groups, supportedServiceIds, labelsByKey]);
    const accountProfile = React.useMemo(() => ({ connectedAccountsV4: selectedAccounts, connectedAccountGroupsV4: source.groups,
        connectedServiceCredentialRevisionsV1: source.revisions }), [selectedAccounts, source.groups, source.revisions]);
    return { accountProfile, profileOptionsByServiceId, groupOptionsByServiceId };
}
