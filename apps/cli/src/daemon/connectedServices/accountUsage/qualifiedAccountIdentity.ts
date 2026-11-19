import { buildQualifiedConnectedAccountLocalSubjectId } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { QualifiedProviderAccountUsagePersistenceTarget } from './persistence';
import type { ConnectedServiceUsageSourceV1, QualifiedConnectedAccountCredentialSnapshotV4 } from '@happier-dev/protocol';
import { buildProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginConnectedAccountDescriptorContributionV2, ProviderAccountUsageSnapshotV1, ProviderAccountUsageRecordKeyV1, QualifiedConnectedAccountProfileV4, QualifiedConnectedAccountRef } from '@happier-dev/protocol';

export type QualifiedProviderAccountUsageIdentity = Pick<ProviderAccountUsageSnapshotV1,
    'recordId' | 'recordKey' | 'providerId' | 'accountSubject'>;

/** Shared identity for quota probes, connection completion and native runtime observations. */
export function buildProviderAccountUsageIdentityFromQualifiedAccount(input: Readonly<{
    ref: QualifiedConnectedAccountRef;
    providerIdentity?: QualifiedConnectedAccountProfileV4['providerIdentity'];
    usageIdentity?: PluginConnectedAccountDescriptorContributionV2['usageIdentity'];
    providerOrganizationId?: string | null;
}>): QualifiedProviderAccountUsageIdentity {
    const providerId = input.usageIdentity?.providerId ?? buildQualifiedPluginContributionKey(input.ref.service);
    const providerAccountId = input.providerIdentity?.accountId?.trim() ?? '';
    const accountSubjectId = providerAccountId || buildQualifiedConnectedAccountLocalSubjectId(input.ref);
    // A provider account keeps its observed organization scope. An account naming only its organization (a Vercel team
    // token) keys identity-free usage to the organization stored on that account, whatever one probe reported, so its
    // source initialization and every acquisition share one record per team; Home's ownership check
    // (protocol isProviderAccountUsageIdentityMatch) admits exactly that organization.
    const providerOrganizationId = providerAccountId
        ? input.providerOrganizationId?.trim()
        : input.providerIdentity?.organizationId?.trim();
    const recordKey: ProviderAccountUsageRecordKeyV1 = {
        providerId, accountSubjectId,
        subjectKind: providerAccountId ? 'account' : 'unknown',
        quotaScope: providerOrganizationId ? 'organization' : 'account',
        ...(providerOrganizationId ? { quotaScopeId: providerOrganizationId } : {}),
    };
    return {
        providerId, recordKey, recordId: buildProviderAccountUsageRecordId(recordKey),
        accountSubject: providerAccountId
            ? { kind: 'providerSubject', id: accountSubjectId }
            : { kind: 'provisionalLocalSubject', id: accountSubjectId,
                mergeKey: accountSubjectId },
    };
}

/** Preserve the exact credential/configuration basis admitted by the qualified reader. */
export function buildProviderAccountUsagePersistenceTargetFromQualifiedCredential(input: Readonly<{
    source: ConnectedServiceUsageSourceV1;
    snapshot: Extract<QualifiedConnectedAccountCredentialSnapshotV4, { revisionSemantics: 'revisioned' }>;
}>): QualifiedProviderAccountUsagePersistenceTarget {
    return {
        source: input.source.bindingKind === 'profile'
            ? { ref: input.snapshot.ref, bindingKind: 'account' }
            : { ref: input.snapshot.ref, bindingKind: 'group_member', groupId: input.source.groupId,
                ...(input.source.groupGeneration === undefined ? {} : { groupGeneration: input.source.groupGeneration }) },
        expectedCredentialRevision: input.snapshot.credentialRevision,
        expectedConfigurationRevision: input.snapshot.configurationRevision,
    };
}
