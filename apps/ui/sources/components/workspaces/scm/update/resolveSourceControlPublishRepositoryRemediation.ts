import type {
    ScmFollowupAction,
    ScmHostingRepositoryDescribePublishTargetsResponse,
    ScmHostingRepositoryPublishResponse,
} from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { validateScmFollowupOpenUrl } from './validateScmFollowupOpenUrl';

type PublishTargetsSuccess = Extract<ScmHostingRepositoryDescribePublishTargetsResponse, { success: true }>;
type PublishTargetsFailure = Extract<ScmHostingRepositoryDescribePublishTargetsResponse, { success: false }>;
type PublishTarget = PublishTargetsSuccess['targets'][number];
type PublishFailure = Extract<ScmHostingRepositoryPublishResponse, { success: false }>;
type AuthSummary = NonNullable<PublishTargetsSuccess['auth'] | PublishTarget['auth']>;
type RemediationRecord = Record<string, unknown>;

export type SourceControlPublishAuthState =
    | 'connected-account-ready'
    | 'provider-cli-ready'
    | null;

export type SourceControlPublishRemediationAction =
    | Readonly<{ kind: 'connect-github'; disabled: boolean }>
    | Readonly<{ kind: 'install-gh'; disabled: boolean }>
    | Readonly<{ kind: 'use-managed-gh'; disabled: boolean }>
    | Readonly<{ kind: 'authenticate-gh'; disabled: boolean }>
    | Readonly<{ kind: 'open-browser'; followup: Extract<ScmFollowupAction, { kind: 'openUrl' }>; disabled: boolean }>;

export type SourceControlPublishRepositoryRemediationViewModel = Readonly<{
    authState: SourceControlPublishAuthState;
    action: SourceControlPublishRemediationAction | null;
    commitRequired: boolean;
    remoteConflict: boolean;
}>;

export function resolveSourceControlPublishRepositoryRemediation(input: Readonly<{
    targetsResponse: ScmHostingRepositoryDescribePublishTargetsResponse | null;
    selectedTarget: PublishTarget | null;
    publishFailure: PublishFailure | null;
    disabled?: boolean;
}>): SourceControlPublishRepositoryRemediationViewModel {
    const disabled = input.disabled === true;
    const failure = input.publishFailure ?? (input.targetsResponse?.success === false ? input.targetsResponse : null);
    const auth = input.selectedTarget?.auth ?? (input.targetsResponse?.success === true ? input.targetsResponse.auth : null);
    return {
        authState: resolveAuthState(auth),
        action: resolveAction({
            auth,
            failure,
            disabled,
        }),
        commitRequired: isCommitRequired(input.publishFailure),
        remoteConflict: isRemoteConflict(input.publishFailure),
    };
}

function resolveAuthState(auth: AuthSummary | null | undefined): SourceControlPublishAuthState {
    if (auth?.state !== 'authenticated') return null;
    if (auth.profileKind === 'connected_account') return 'connected-account-ready';
    if (auth.profileKind === 'provider_cli') return 'provider-cli-ready';
    return null;
}

function resolveAction(input: Readonly<{
    auth: AuthSummary | null | undefined;
    failure: PublishFailure | PublishTargetsFailure | null;
    disabled: boolean;
}>): SourceControlPublishRemediationAction | null {
    const remediation = readRemediation(input.failure) ?? readRemediation(input.auth);
    const browserFollowup = readValidatedOpenUrlFollowup(remediation);
    const authState = normalizeRemediationToken(readString(input.auth, 'state'));
    const remediationKind = normalizeRemediationToken(readString(remediation, 'kind'));
    const remediationAction = normalizeRemediationToken(readString(remediation, 'action'));

    if (!input.failure && authState === 'authenticated') {
        return null;
    }
    if (
        remediationKind === 'connect_github'
        || remediationAction === 'connect_github'
        || (input.auth?.profileKind === 'connected_account' && authState === 'authentication_required')
    ) {
        return { kind: 'connect-github', disabled: input.disabled };
    }
    if (remediationKind === 'install_gh' || remediationAction === 'install_gh') {
        return { kind: 'install-gh', disabled: input.disabled };
    }
    if (remediationKind === 'use_managed_gh' || remediationAction === 'use_managed_gh') {
        return { kind: 'use-managed-gh', disabled: input.disabled };
    }
    if (
        remediationKind === 'authenticate_gh'
        || remediationAction === 'authenticate_gh'
        || (
            input.auth?.profileKind === 'provider_cli'
            && authState === 'authentication_required'
            && (remediationKind === 'auth_required' || remediationKind === 'authentication_required')
        )
    ) {
        return { kind: 'authenticate-gh', disabled: input.disabled };
    }
    if (browserFollowup) {
        return { kind: 'open-browser', followup: browserFollowup, disabled: input.disabled };
    }
    return null;
}

function isCommitRequired(failure: PublishFailure | null): boolean {
    if (!failure) return false;
    return failure.errorCode === SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED
        || readString(readRemediation(failure), 'kind') === 'commit_required';
}

function isRemoteConflict(failure: PublishFailure | null): boolean {
    if (!failure) return false;
    return failure.errorCode === SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS
        || readString(readRemediation(failure), 'kind') === 'set_url_required';
}

function readRemediation(value: object | null | undefined): RemediationRecord | null {
    if (!value || !('remediation' in value)) return null;
    const candidate = value.remediation;
    return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        ? candidate as RemediationRecord
        : null;
}

function readValidatedOpenUrlFollowup(remediation: RemediationRecord | null): Extract<ScmFollowupAction, { kind: 'openUrl' }> | null {
    const followup = readFollowup(remediation, 'followup') ?? readFollowup(remediation, 'nextAction');
    if (!followup) return null;
    return validateScmFollowupOpenUrl(followup).ok ? followup : null;
}

function readFollowup(remediation: RemediationRecord | null, field: string): Extract<ScmFollowupAction, { kind: 'openUrl' }> | null {
    const candidate = remediation?.[field];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const record = candidate as Record<string, unknown>;
    if (record.kind !== 'openUrl') return null;
    if (record.purpose !== 'pullRequest' && record.purpose !== 'compose') return null;
    if (typeof record.url !== 'string' || typeof record.allowedBaseUrl !== 'string') return null;
    const urlSafety = readOpenUrlSafety(record.urlSafety);
    if (!urlSafety) return null;
    return {
        kind: 'openUrl',
        purpose: record.purpose,
        url: record.url,
        allowedBaseUrl: record.allowedBaseUrl,
        urlSafety,
    };
}

function readOpenUrlSafety(value: unknown): Extract<ScmFollowupAction, { kind: 'openUrl' }>['urlSafety'] | null {
    if (value === undefined) return { allowedSchemes: ['https:'] };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.allowedSchemes === undefined) return { allowedSchemes: ['https:'] };
    if (!Array.isArray(record.allowedSchemes) || !record.allowedSchemes.every((scheme) => typeof scheme === 'string')) {
        return null;
    }
    return { allowedSchemes: record.allowedSchemes };
}

function readString(value: object | null | undefined, field: string): string | null {
    if (!value || !(field in value)) return null;
    const candidate = (value as Record<string, unknown>)[field];
    return typeof candidate === 'string' ? candidate : null;
}

function normalizeRemediationToken(value: string | null): string | null {
    return value ? value.trim().replaceAll('-', '_').toLowerCase() : null;
}
