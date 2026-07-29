import type {
    ConnectedAccountConsumerFailureV1,
    ConnectedServiceLimitCategoryV1,
    ProviderAccountUsageQuotaScopeV1,
    QualifiedConnectedAccountRef,
    QualifiedConnectedAccountServiceRef,
} from '@happier-dev/protocol';

import type { ConnectedServiceAuthGroupSwitchCoordinator } from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import {
    decideConnectedServiceRecovery,
    type ConnectedServiceRecoveryPolicyDecision,
    type ConnectedServiceRecoveryPolicySelection,
} from '../runtimeAuth/ConnectedServiceRecoveryPolicy';
import type { ConnectedServiceRuntimeFailureClassification } from '../runtimeAuth/types';
import type { ConnectedAccountRequestAuthResolvedBinding } from './ConnectedAccountRequestAuthService';

type SwitchAfterClassifiedFailure = ConnectedServiceAuthGroupSwitchCoordinator<
    QualifiedConnectedAccountServiceRef
>[
    'switchAfterClassifiedFailure'
];

export type ConnectedAccountRequestAuthTemporaryRetry = Readonly<{
    service: QualifiedConnectedAccountServiceRef;
    accountId: string;
    groupId: string | null;
    groupGeneration: number | null;
    limitCategory: ConnectedServiceLimitCategoryV1;
    quotaScope: ProviderAccountUsageQuotaScopeV1;
    retryAfterMs: number | null;
    resetAtMs: number | null;
    providerCode: string | null;
}>;

export type ConnectedAccountRequestAuthTemporaryRetryRecordResult =
    | Readonly<{ status: 'recorded' }>
    | Readonly<{
        status: 'unavailable';
        reason: 'backoff_owner_unavailable' | 'backoff_record_failed';
    }>;

export type ConnectedAccountRequestAuthRecoveryInput = Readonly<{
    resolved: ConnectedAccountRequestAuthResolvedBinding;
    failure: ConnectedAccountConsumerFailureV1;
    refreshCredential: (input: Readonly<{
        account: QualifiedConnectedAccountRef;
        expectedCredentialRevision: string;
    }>) => Promise<boolean>;
    switchAfterClassifiedFailure: (
        input: Parameters<SwitchAfterClassifiedFailure>[0],
    ) => Promise<unknown>;
    recordTemporaryRetry: (
        input: ConnectedAccountRequestAuthTemporaryRetry,
    ) => Promise<ConnectedAccountRequestAuthTemporaryRetryRecordResult>;
}>;

export type ConnectedAccountRequestAuthRecoveryResult =
    | Readonly<{
        effect: 'refresh' | 'switch_account' | 'none';
        decision: ConnectedServiceRecoveryPolicyDecision<
            QualifiedConnectedAccountServiceRef
        >;
    }>
    | Readonly<{
        effect: 'temporary_retry';
        decision: ConnectedServiceRecoveryPolicyDecision<
            QualifiedConnectedAccountServiceRef
        >;
        temporaryRetry: Readonly<{ status: 'recorded' }>;
    }>
    | Readonly<{
        effect: 'temporary_retry_unavailable';
        decision: ConnectedServiceRecoveryPolicyDecision<
            QualifiedConnectedAccountServiceRef
        >;
        temporaryRetry: Extract<
            ConnectedAccountRequestAuthTemporaryRetryRecordResult,
            Readonly<{ status: 'unavailable' }>
        >;
    }>
    | Readonly<{
        effect: 'stale_context';
        decision: ConnectedServiceRecoveryPolicyDecision<
            QualifiedConnectedAccountServiceRef
        >;
    }>;

function runtimeFailureKindForCategory(
    category: ConnectedServiceLimitCategoryV1,
): ConnectedServiceRuntimeFailureClassification['kind'] {
    switch (category) {
        case 'usage_limit':
        case 'rate_limit':
        case 'capacity':
        case 'temporary_throttle':
        case 'unknown':
            return category;
        case 'auth_invalid':
            return 'auth_expired';
        case 'plan_invalid':
            return 'plan';
        case 'validation_failed':
            return 'validation';
        case 'disabled':
            return 'account_disabled';
    }
}

function buildSelection(
    input: ConnectedAccountRequestAuthRecoveryInput,
): ConnectedServiceRecoveryPolicySelection<
    QualifiedConnectedAccountServiceRef
> {
    if (input.resolved.group) {
        return {
            kind: 'group',
            serviceId: input.resolved.account.service,
            groupId: input.resolved.group.groupId,
            activeProfileId: input.resolved.account.accountId,
        };
    }
    return {
        kind: 'profile',
        serviceId: input.resolved.account.service,
        profileId: input.resolved.account.accountId,
    };
}

type QualifiedConnectedServiceRuntimeFailureClassification =
    Omit<ConnectedServiceRuntimeFailureClassification, 'serviceId'>
    & Readonly<{ serviceId: QualifiedConnectedAccountServiceRef }>;

function buildClassification(
    input: ConnectedAccountRequestAuthRecoveryInput,
): QualifiedConnectedServiceRuntimeFailureClassification {
    const evidence = input.failure.evidence;
    return {
        kind: runtimeFailureKindForCategory(evidence.limitCategory),
        limitCategory: evidence.limitCategory,
        serviceId: input.resolved.account.service,
        profileId: input.resolved.account.accountId,
        groupId: input.resolved.group?.groupId ?? null,
        groupGeneration: input.resolved.group?.generation ?? null,
        expectedCredentialRevision: input.resolved.credentialRevision,
        resetsAtMs: evidence.resetAtMs ?? null,
        retryAfterMs: evidence.retryAfterMs ?? null,
        planType: null,
        providerLimitId: evidence.providerCode ?? null,
        quotaScope: evidence.quotaScope,
        rateLimits: null,
        source: evidence.evidenceSource.kind === 'structured'
            ? 'structured_provider_error'
            : 'stable_provider_message',
    };
}

async function applySwitch(
    input: ConnectedAccountRequestAuthRecoveryInput,
    classification: QualifiedConnectedServiceRuntimeFailureClassification,
    decision: Extract<
        ConnectedServiceRecoveryPolicyDecision<
            QualifiedConnectedAccountServiceRef
        >,
        Readonly<{ action: 'switch_account' }>
    >,
): Promise<ConnectedAccountRequestAuthRecoveryResult> {
    if (!input.resolved.group) {
        return { effect: 'none', decision };
    }
    const switchResult = await input.switchAfterClassifiedFailure({
        serviceId: input.resolved.account.service,
        groupId: input.resolved.group.groupId,
        observedProfileId: input.resolved.account.accountId,
        expectedFailureSource: {
            profileId: input.resolved.account.accountId,
            credentialRevision:
                input.resolved.credentialRevision,
            groupGeneration: input.resolved.group.generation,
        },
        reason: decision.reason,
        ...(classification.retryAfterMs == null
            ? {}
            : { retryAfterMs: classification.retryAfterMs }),
        ...(classification.resetsAtMs == null
            ? {}
            : { resetsAtMs: classification.resetsAtMs }),
        ...(classification.limitCategory == null
            ? {}
            : { limitCategory: classification.limitCategory }),
        ...(classification.quotaScope == null
            ? {}
            : { quotaScope: classification.quotaScope }),
        ...(classification.providerLimitId == null
            ? {}
            : { providerLimitId: classification.providerLimitId }),
    });
    if (
        switchResult
        && typeof switchResult === 'object'
        && !Array.isArray(switchResult)
        && 'status' in switchResult
        && switchResult.status === 'stale_context'
    ) {
        return { effect: 'stale_context', decision };
    }
    return { effect: 'switch_account', decision };
}

/**
 * Applies only Connected Services-owned credential/group effects.
 *
 * This adapter deliberately has no session id, continuation, resume, retry budget, or replay
 * callback. Consumer leaves remain the sole owners of resubmitting an exact failed request/turn.
 */
export async function applyConnectedAccountRequestAuthRecovery(
    input: ConnectedAccountRequestAuthRecoveryInput,
): Promise<ConnectedAccountRequestAuthRecoveryResult> {
    const classification = buildClassification(input);
    const selection = buildSelection(input);
    let decision = decideConnectedServiceRecovery({
        actor: 'automatic',
        issue: classification,
        selection,
        ...(classification.kind === 'auth_expired'
            ? { credentialRefresh: { status: 'refreshable' } }
            : {}),
    });

    if (decision.action === 'refresh') {
        const refreshed = await input.refreshCredential({
            account: {
                service: input.resolved.account.service,
                accountId: decision.profileId,
            },
            expectedCredentialRevision: input.resolved.credentialRevision,
        });
        if (refreshed) return { effect: 'refresh', decision };

        decision = decideConnectedServiceRecovery({
            actor: 'automatic',
            issue: classification,
            selection,
            credentialRefresh: { status: 'not_refreshable' },
            credentialHealth: { liveEvidence: 'auth_failed' },
        });
    }

    if (decision.action === 'switch_account') {
        return await applySwitch(input, classification, decision);
    }
    if (decision.action === 'temporary_retry') {
        const temporaryRetry = await input.recordTemporaryRetry({
            service: input.resolved.account.service,
            accountId: input.resolved.account.accountId,
            groupId: input.resolved.group?.groupId ?? null,
            groupGeneration: input.resolved.group?.generation ?? null,
            limitCategory: input.failure.evidence.limitCategory,
            quotaScope: input.failure.evidence.quotaScope,
            retryAfterMs: input.failure.evidence.retryAfterMs ?? null,
            resetAtMs: input.failure.evidence.resetAtMs ?? null,
            providerCode: input.failure.evidence.providerCode ?? null,
        });
        if (temporaryRetry.status === 'recorded') {
            return { effect: 'temporary_retry', decision, temporaryRetry };
        }
        return {
            effect: 'temporary_retry_unavailable',
            decision,
            temporaryRetry,
        };
    }
    return { effect: 'none', decision };
}
