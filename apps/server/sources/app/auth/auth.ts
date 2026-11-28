import * as privacyKit from "privacy-kit";
import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from 'node:util';
import { AccountEncryptionMigrateExternalAuthBindingDigestV1Schema } from '@happier-dev/protocol/account/encryptionMigrate';
import { AUTH_TOKEN_AUTHENTICATION_EVIDENCE_MAX_ITEMS, AuthTokenProvenanceSchema, AuthTokenProvenanceV2Schema, readAuthTokenProvenance, AuthTokenAuthenticationEvidenceSnapshotV1Schema, type AuthTokenAuthority, type AuthTokenKind, type AuthTokenProvenanceAny, type AuthTokenAuthenticationEvidenceV1 } from '@happier-dev/protocol/auth/authToken';
import { PasswordCredentialMutationDigestV1Schema } from '@happier-dev/protocol/auth/passwordMutationChallenge';
import { parseAccountApiTokenBearerV1, AccountApiTokenCreateEncryptionV1Schema, AccountApiTokenEncryptionAccessV1Schema, type AccountApiTokenCreateEncryptionV1, type AccountApiTokenEncryptionAccessV1, type AccountApiTokenEncryptionAccessResponseV1, type ParsedAccountApiTokenBearerV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { projectPrivateLabelForRecipientV1, serializePrivateLabelStoredV1, type PrivateLabelReadV1, type PrivateLabelStoredV1 } from '@happier-dev/protocol';
import { ApiTokenGrantV1Schema, StoredApiTokenGrantV1Schema, API_TOKEN_FULL_GRANT_V1, API_TOKEN_ENVIRONMENT_ACTION_IDS_V1, evaluateApiTokenGrantV1, isApiTokenGrantWithinV1, type ApiTokenGrantDenialReasonV1, type ApiTokenGrantV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { projectDeploymentNativeAdmissionV1,
    isDeploymentDomainNativeAdmissionV1, isDeploymentDomainDnsNativeAdmissionV1, isDeploymentEnvironmentUpdateNativeAdmissionV1, isDeploymentBackupConfigureNativeAdmissionV1, isDeploymentTelemetryNativeAdmissionV1,
    createDeploymentCandidatePublicationV1, projectExternalActionDeploymentMetadataEnvironmentIdV1,
    projectExternalActionDeploymentMetadataReceiptIdV1, projectExternalActionDeploymentStopReceiptV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { isDeploymentDomainChildActionIdV1, isDeploymentChildRootActionIdV1, isDeploymentBackupActionIdV1 } from '@happier-dev/protocol';
import { isDeploymentBackupReadActionIdV1, isDeploymentApprovalMetadataPreparationActionIdV1, isDeploymentControllerSetActionIdV1,
    DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1, DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1,
    DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1, DEPLOYMENT_RECEIPT_OBSERVE_ACTION_ID_V1,
    isDeploymentReceiptObservationActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { EmbedConfigV1Schema, StoredEmbedConfigV1Schema, type EmbedConfigV1 } from '@happier-dev/protocol/embed';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { type AccountStatusV1 } from '@happier-dev/protocol/home/governance';
import { ExternalActionExecutionAuthorizationBindingV1Schema, ExternalActionExecutionAuthorizationV1Schema, type ExternalActionExecutionAuthorizationBindingV1, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { formatQualifiedPluginActionId, parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { selectDeploymentReviewedChildPlanV1 } from '@happier-dev/protocol/actions/specs/deploymentPreparationScope';
import {
    VerifiedEphemeralSessionRunnerPrincipalSchema,
    type VerifiedEphemeralSessionRunnerPrincipal,
} from "@happier-dev/protocol/ephemeralRunner/principal";
import { db, getActivePrismaRuntime, isPrismaErrorCode } from "@/storage/db";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { assertAccountActive } from "./accountStatus";
import { admitExternalActionBrowserSessionInTx } from './externalActionBrowserAdmission';
import { isActiveHomeAccountStatus } from '@happier-dev/protocol/home/governance';
import { inTx, type Tx } from "@/storage/inTx";
import { MACHINE_PRESET_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { isMachinePresetFiniteOperationActionIdV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionIdsV1';
import { log, warn } from "@/utils/logging/log";
import { LRUTtlMap } from "@/utils/collections/lru";
import { createSha256SecretDigest, sha256SecretDigestMatches } from "./secretDigest";
import {
    isOAuthStateUnavailableError,
    OAuthStateUnavailableError,
} from "./oauthStateErrors";
import {
    parseAuthenticationEvidenceSnapshot,
    resolveCurrentAuthenticationEvidenceInTx,
} from "./authenticationEvidence";
import { verifyCurrentMaterializedRunnerPrincipal } from "@/app/ephemeralRunner/materializedRunnerPrincipalCurrentness";
import { effectiveCredentialAuthority } from "./effectiveCredentialAuthority";
import { hasCurrentSessionScopedMachineAccessInTx, hasCurrentSessionActionRpcSourceBinding } from "@/app/api/socket/sessionScopedBinding";
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { DECISION_ACTION_IDS } from '@happier-dev/protocol/actions/decisionAuthority';
import type { AccountApiTokenDeploymentInputV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { resolveApiTokenDeploymentGrantV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { projectExternalActionProjectSessionDefaultsAdmissionV1, projectExternalActionProjectSourceCheckoutIdV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { readExternalActionBindingAuthority } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { hasAdmittedExternalActionHandoffScope, readAdmittedExternalActionHandoffMachineInTx } from './externalActionHandoffAdmission';
import { projectWorkspaceSyncAdmissionInputV1, type WorkspaceSyncAdmissionInputV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { readWorkspaceSyncAdmissionInTx } from './workspaceSyncAdmission';
import type { WorkflowExternalActionAdmission } from './externalActionExecutionAuthorization';
// After the Protocol barrels: this diagnostic module must not initialize Protocol schemas first.
import { withActionFailureDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import { core } from 'zod/mini';
import { admitAccountPrivateLabelWriteInTx, projectAccountPrivateLabelForRecipientV1 } from '@/app/encryption/accountPrivateLabelContent';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { readCurrentDeploymentAppTerminalCredentialInTx, type CurrentTerminalCredential } from '@/app/deployments/deploymentAppEnrollment';

interface TokenGeneratorLike {
    new: (payload: Readonly<{
        user?: string;
        extras?: Readonly<Record<string, unknown>>;
    }>) => Promise<string>;
    publicKey: Uint8Array | number[];
}

interface TokenVerifierLike {
    verify: (token: string) => Promise<any>;
}

// Persistent tokens have no expiry. Retain this read-only compatibility window until an
// explicit token epoch or forced re-auth retires tokens issued by privacy-kit 0.0.25 on Bun.
const LEGACY_BUN_SEED_CANDIDATE_COUNT = 64;

interface AuthTokens {
    generator: TokenGeneratorLike;
    verifier: TokenVerifierLike;
}

interface OAuthStateTokens {
    oauthStateVerifier: TokenVerifierLike;
    oauthStateGenerator: TokenGeneratorLike;
}

type OAuthStatePurpose = "account_encryption_first_key" | "account_password_enrollment" | "account_directory"
    | "team_admission" | "github_app_installation_verification" | "github_app_manifest_setup" | "supporter_github" | "supporter_discord";

type OAuthStatePayload = Readonly<{
    flow: "connect" | "auth";
    provider: string;
    sid?: string | null;
    userId?: string | null;
    publicKey?: string | null;
    proofHash?: string | null;
    purpose?: OAuthStatePurpose | null;
    requestDigest?: string | null;
    endpointUrl?: string | null;
    endpointServerIdentityId?: string | null;
    canonicalServerUrl?: string | null;
}>;

type DecodedAuthToken = Readonly<{
    userId: string;
    extras?: unknown;
    tokenEpoch: number;
    provenance: AuthTokenProvenanceAny;
    legacy: boolean;
}>;

export type { AuthTokenAuthority, AuthTokenKind, AuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';

/** Backward-compatible server spelling retained for existing request callers. */
export type AuthAuthority = AuthTokenAuthority;

/** An explicit, complete mint decision; no endpoint, extras, or token shape
 * may infer it. The canonical kind/authority mapping is owned by the protocol
 * provenance schema. */
export type CreateTokenOptions = Readonly<{
    kind: AuthTokenKind;
    authority: AuthTokenAuthority;
    authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
}>;

/**
 * Server-verified PAT facts that may be projected only for the lifetime of
 * the request that authenticated the bearer. The plaintext PAT never leaves
 * the authorization header boundary.
 */
export type VerifiedApiTokenPrincipal = Readonly<{
    accountId: string;
    principalId: string;
    credentialId: string;
    authority: "account_automation";
    expiresAt: Date | null;
    grant: ApiTokenGrantV1;
    parentTokenId: string | null;
    embedConfig: EmbedConfigV1 | null;
    authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
}>;

export type ExternalActionExecutionAuthorizationMintInput =
    | Omit<Extract<ExternalActionExecutionAuthorizationBindingV1, { authentication: unknown }>, 'custodianAccountId' | 'installationId' | 'managedAccountExecutor' | 'deploymentObservationReceiptId'>
    | Omit<Extract<ExternalActionExecutionAuthorizationBindingV1, { credentialId: string }>, 'custodianAccountId' | 'installationId' | 'managedAccountExecutor' | 'deploymentObservationReceiptId'>;

export type VerifiedAuthToken = Readonly<{
    userId: string;
    /** Current signed terminal selector; live sockets subscribe to its Machine owner's withdrawal. */
    terminalCredential?: CurrentTerminalCredential;
    /** Verified signed credential revocation selector; PATs have their own row lifecycle. */
    tokenEpoch?: number;
    extras?: unknown;
    /** Canonical server-verified credential kind from the signed marker. */
    authTokenKind: AuthTokenKind;
    /** Effective authority after current Account terminal policy. */
    authority: AuthTokenAuthority;
    /** Signed provenance floor, kept separate from effective invocation authority. */
    authTokenMintedAuthority?: AuthTokenAuthority;
    /** Current credentials may carry bounded server-produced authentication facts. */
    authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
    /** True only when the credential was accepted through the named
     * pre-marker ordinary-Home reader. Central admission consumes this fact
     * to deny a legacy credential on Directory-opt-in routes; a current
     * signed or database-minted credential is never legacy. */
    legacy: boolean;
    apiTokenPrincipal?: VerifiedApiTokenPrincipal;
    ephemeralSessionRunnerPrincipal?: VerifiedEphemeralSessionRunnerPrincipal;
}>;

export type AuthTokenVerificationDisposition =
    | Readonly<{ status: "verified"; credential: VerifiedAuthToken }>
    | Readonly<{ status: "invalid" }>
    | Readonly<{
        status: "rejected_restricted";
        authTokenKind: "ephemeral_session_runner";
    }>;

const REJECTED_EPHEMERAL_SESSION_RUNNER_CREDENTIAL = {
    status: "rejected_restricted",
    authTokenKind: "ephemeral_session_runner",
} as const;

type AuthTokenInternalVerification =
    | VerifiedAuthToken
    | typeof REJECTED_EPHEMERAL_SESSION_RUNNER_CREDENTIAL
    | null;

function isRejectedRestrictedCredential(
    value: AuthTokenInternalVerification,
): value is typeof REJECTED_EPHEMERAL_SESSION_RUNNER_CREDENTIAL {
    return value !== null
        && "status" in value
        && value.status === "rejected_restricted";
}

async function verifyCurrentEphemeralSessionRunnerPrincipal(
    accountId: string,
    extras: unknown,
): Promise<VerifiedEphemeralSessionRunnerPrincipal | null> {
    if (typeof extras !== "object" || extras === null || Array.isArray(extras)) return null;
    const parsed = VerifiedEphemeralSessionRunnerPrincipalSchema.safeParse(
        (extras as Readonly<Record<string, unknown>>).ephemeralSessionRunnerPrincipal,
    );
    if (!parsed.success || parsed.data.accountId !== accountId) return null;
    return await verifyCurrentMaterializedRunnerPrincipal(parsed.data);
}

export type CreatedApiToken = Readonly<{
    tokenId: string;
    /** Plaintext is returned only from this mint result and is never persisted. */
    token: string;
    label: PrivateLabelReadV1;
    displayPrefix: string;
    createdAt: Date;
    expiresAt: Date | null;
    hasEncryptionAccess: boolean;
    hasUnattendedTeamAccess: boolean;
    grant: ApiTokenGrantV1;
    parentTokenId: string | null;
    activeChildCount: number;
    embedConfig: EmbedConfigV1 | null;
}>;

export type ApiTokenSummary = Readonly<{
    tokenId: string;
    label: PrivateLabelReadV1;
    displayPrefix: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
    hasEncryptionAccess: boolean;
    hasUnattendedTeamAccess: boolean;
    grant: ApiTokenGrantV1;
    parentTokenId: string | null;
    activeChildCount: number;
    embedConfig: EmbedConfigV1 | null;
}>;

export class ApiTokenOperationError extends Error {
    constructor(readonly code: "account-disabled" | "invalid_token" | "api_token_id_conflict" | "api_token_encryption_not_ready" | "api_token_encryption_stale" | "api_token_encryption_unavailable" | "api_token_label_invalid" | "api_token_label_mode_mismatch" | "api_token_label_recipient_envelope_rejected" | "credential_authentication_evidence_limit" | "credential_authentication_evidence_unavailable" | "api_token_child_forbidden" | "api_token_child_invalid" | "credential_scope_denied" | "source_access_denied" | "source_changed" | "target_unavailable" | "invalid_envelope",
        readonly grantReason?: ApiTokenGrantDenialReasonV1,
        readonly details?: import('@happier-dev/protocol/actions/actionExecutionResult').ActionExecuteFailure['details'],
        readonly failureCause?: import('@happier-dev/protocol/actions/actionExecutionResult').ActionExecuteFailure['failureCause']) {
        super(code);
        this.name = "ApiTokenOperationError";
    }
}

type ExecutionAuthorizationMintRefusal = Readonly<{
    grantReason?: ApiTokenGrantDenialReasonV1;
    details?: ApiTokenOperationError['details'];
    failureCause?: ApiTokenOperationError['failureCause'];
    cause?: unknown;
}>;

/**
 * One refusing branch of the execution-authorization mint. The public code, details and envelope are
 * unchanged; the branch phase rides the hidden diagnostic and one server warn with closed facts only
 * (catalog Action id, code, grant reason, cause class/code, schema issue paths), never tokens or input values.
 */
function refuseExecutionAuthorizationMint(phase: string, actionId: string,
    code: ApiTokenOperationError['code'] = 'credential_scope_denied', refusal: ExecutionAuthorizationMintRefusal = {},
): ApiTokenOperationError {
    const error = new ApiTokenOperationError(code, refusal.grantReason, refusal.details, refusal.failureCause);
    const cause = refusal.cause;
    const causeCode = cause instanceof Error && typeof (cause as { code?: unknown }).code === 'string'
        ? (cause as { code: string }).code : undefined;
    const issues = cause instanceof core.$ZodError
        ? cause.issues.map(issue => ({ path: issue.path.map(String).join('.'), code: issue.code })) : undefined;
    return withActionFailureDiagnostic(error, { phase, causeKind: 'access_denied' }, () => warn({
        module: 'external-action-execution-authorization-mint', phase, actionId, code,
        ...(refusal.grantReason ? { grantReason: refusal.grantReason } : {}),
        ...(cause instanceof Error ? { causeClass: cause.name } : {}), ...(causeCode ? { causeCode } : {}),
        ...(issues ? { issues } : {}),
    }, 'External Action execution authorization refused'));
}

function matchesApiTokenEncryptionBinding(
    account: Parameters<typeof deriveAccountEncryptionCurrentnessFromRow>[0],
    access: AccountApiTokenEncryptionAccessV1,
    serverIdentityId: string,
): boolean {
    const result = deriveAccountEncryptionCurrentnessFromRow(account);
    return result.status === "ready"
        && result.currentness.encryptionMode === "e2ee"
        && result.currentness.contentPublicKey !== null
        && privacyKit.encodeBase64(result.currentness.contentPublicKey) === access.contentPublicKey
        && access.serverIdentityId === serverIdentityId;
}

/**
 * PAT-only verification seam for server-owned introspection consumers. It
 * intentionally cannot verify a signed session token.
 */
export type VerifyPatResult =
    | Readonly<{
        ok: true;
        accountId: string;
        principalId: string;
        credentialId: string;
        expiresAt: Date | null;
        authority: "account_automation";
        grant: ApiTokenGrantV1;
        parentTokenId: string | null;
        embedConfig: EmbedConfigV1 | null;
        authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
    }>
    | Readonly<{
        ok: false;
        reason: "invalid_token";
    }>;

type VerifiedApiToken = Readonly<{
    accountId: string;
    credentialId: string;
    expiresAt: Date | null;
    grant: ApiTokenGrantV1;
    parentTokenId: string | null;
    embedConfig: EmbedConfigV1 | null;
    authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
}>;

type CurrentApiTokenRow = Readonly<{
    id: string;
    accountId: string;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    authenticationEvidence: unknown;
    accessGrant: unknown;
    embedConfig: unknown;
    parentTokenId: string | null;
    parent: Readonly<{ accountId: string; parentTokenId: string | null; expiresAt: Date | null; embedConfig: unknown }> | null;
    Account: Readonly<{ status: AccountStatusV1 }>;
}>;

const API_TOKEN_CURRENT_FIELDS = {
    id: true, accountId: true, expiresAt: true, lastUsedAt: true,
    authenticationEvidence: true, accessGrant: true, embedConfig: true, parentTokenId: true,
    parent: { select: { accountId: true, parentTokenId: true, expiresAt: true, embedConfig: true } },
    Account: { select: { status: true } },
} as const;

function readApiTokenGrant(value: unknown): ApiTokenGrantV1 {
    const parsed = StoredApiTokenGrantV1Schema.safeParse(value);
    if (!parsed.success) throw new ApiTokenOperationError("invalid_token");
    return parsed.data;
}

function readApiTokenEmbedConfig(value: unknown): EmbedConfigV1 | null {
    return value == null ? null : StoredEmbedConfigV1Schema.parse(value);
}

function requireApiTokenLabelMode(account: Readonly<{ encryptionMode: unknown }>) {
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(account);
    if (mode.status !== "ready") throw new ApiTokenOperationError("api_token_encryption_unavailable");
    return mode.mode;
}

function requireAdmittedApiTokenLabel(
    admitted: Awaited<ReturnType<typeof admitAccountPrivateLabelWriteInTx>>,
): PrivateLabelStoredV1 {
    if (admitted.kind === "available") {
        return admitted.stored;
    }
    if (admitted.kind === "mode_mismatch") throw new ApiTokenOperationError("api_token_label_mode_mismatch");
    if (admitted.kind === "recipient_envelope_rejected") {
        throw new ApiTokenOperationError("api_token_label_recipient_envelope_rejected");
    }
    throw new ApiTokenOperationError("api_token_label_invalid");
}

function projectApiTokenLabelForAccount(params: Readonly<{
    serialized: string;
    mode: "plain" | "e2ee";
    accountId: string;
}>): PrivateLabelReadV1 {
    const projected = projectAccountPrivateLabelForRecipientV1({
        serialized: params.serialized,
        mode: params.mode,
        recipientAccountId: params.accountId,
    });
    if (projected.kind === "available") return projected.label;
    if (projected.kind === "mode_mismatch") throw new ApiTokenOperationError("api_token_label_mode_mismatch");
    throw new ApiTokenOperationError("api_token_label_invalid");
}

type CreateApiTokenParams = Readonly<{
    accountId: string; tokenId: string; label: PrivateLabelStoredV1; expiresAt?: Date | null;
    encryption?: AccountApiTokenCreateEncryptionV1;
    authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
    grant?: ApiTokenGrantV1; embedConfig?: EmbedConfigV1;
    deployment?: AccountApiTokenDeploymentInputV1;
}>;

export type ApiTokenRevocation = Readonly<{ revoked: boolean; revokedTokenIds: readonly string[] }>;
export type ApiTokenRevokeAllResult = Readonly<{ revokedCount: number; revokedTokenIds: readonly string[] }>;
export type ExternalActionGrantEvaluationContext = Readonly<{ input?: unknown;
    /** Internal placement decision; no public request/binding field is trusted. */
    managedCreationRecovery?: true;
    managedMachineAdmission?: import('@happier-dev/protocol/machines/machineAccessV1').SocketRpcMachineAdmissionContextV1
        & import('./externalActionExecutionAuthorization').ExternalActionExecutionMachineAdmissionFacts;
    browserSessionId?: string;
    usageCollectorParent?: ExternalActionExecutionAuthorizationBindingV1;
    callerAuthority?: import('@happier-dev/protocol/actions/externalActionBindingAuthority').ExternalActionBindingAuthorityV1;
    workflowAdmission?: WorkflowExternalActionAdmission;
    managedCreationAdmission?: import('./externalActionManagedAdmission').ManagedCreationChildAdmission;
    deploymentLinkEnvironmentId?: string;
    deploymentLinkReplacement?: import('@happier-dev/protocol/actions/externalActionApi').DeploymentLinkReplacementV1;
    workspaceSyncAdmission?: WorkspaceSyncAdmissionInputV1;
    deploymentNativeAdmission?: ReturnType<typeof projectDeploymentNativeAdmissionV1>;
    deploymentReview?: import('@happier-dev/protocol/actions/externalActionApi').ExternalActionExecutionAuthorizationRequestV1['deploymentReview'];
    sessionSpawnInputKind?: 'public_api' | 'canonical_admission';
    resolveCurrentSessionMachine?: (input: Readonly<{ accountId: string; sessionId: string }>) => Promise<string | null>;
}>;

/** The API adapter maps this canonical creation rejection to `invalid_request`. */
export class InvalidApiTokenExpiryError extends Error {
    constructor() {
        super("API token expiry must be in the future");
    }
}

const API_TOKEN_SECRET_BYTES = 32;
const API_TOKEN_DISPLAY_ID_LENGTH = 8;
// API-token verification may be high frequency. Five minutes bounds each valid
// token to one durable activity write per interval while retaining useful UI
// observability; revocation is still a row deletion checked on every request.
const API_TOKEN_LAST_USED_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

function isApiTokenCandidate(token: string): boolean {
    return token.startsWith("hap_");
}

function createApiTokenSecretDigest(secret: string): Buffer {
    return createSha256SecretDigest(secret);
}

function apiTokenSecretDigestMatches(storedDigest: string, suppliedSecret: string): boolean {
    return sha256SecretDigestMatches(storedDigest, suppliedSecret);
}

function createApiTokenDisplayPrefix(tokenId: string): string {
    return `hap_v1_${tokenId.slice(0, API_TOKEN_DISPLAY_ID_LENGTH)}`;
}

function createApiTokenBearer(tokenId: string, secret: string): string {
    return `hap_v1_${tokenId}_${secret}`;
}

class AuthModule {
    private tokenCache: LRUTtlMap<string, DecodedAuthToken> | null = null;
    private tokens: AuthTokens | null = null;
    private externalActionExecutionAuthorizationTokens: AuthTokens | null = null;
    private oauthStateTokens: OAuthStateTokens | null = null;
    private oauthStateTokensInitPromise: Promise<OAuthStateTokens> | null = null;

    private resolveAuthTokenCacheTtlMsFromEnv(env: NodeJS.ProcessEnv): number {
        const raw = (env.AUTH_TOKEN_CACHE_TTL_SECONDS ?? "").toString().trim();
        const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
        const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 600;
        const clampedSeconds = Math.max(1, Math.min(86_400, seconds));
        return clampedSeconds * 1000;
    }

    private resolveAuthTokenCacheMaxEntriesFromEnv(env: NodeJS.ProcessEnv): number {
        const raw = (env.AUTH_TOKEN_CACHE_MAX_ENTRIES ?? "").toString().trim();
        const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
        const maxEntries = Number.isFinite(parsed) && parsed >= 0 ? parsed : 4096;
        return Math.max(0, Math.min(200_000, maxEntries));
    }
    
    private resolveOauthStateTtlMsFromEnv(env: NodeJS.ProcessEnv): number {
        const raw = (env.OAUTH_STATE_TTL_SECONDS ?? "").toString().trim();
        const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
        const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 600;
        const clampedSeconds = Math.max(60, Math.min(3600, seconds));
        return clampedSeconds * 1000;
    }

    private requireMasterSecret(env: NodeJS.ProcessEnv): string {
        const masterSecret = (env.HANDY_MASTER_SECRET ?? "").toString().trim();
        if (!masterSecret) {
            throw new Error("HANDY_MASTER_SECRET is required");
        }
        return masterSecret;
    }

    private deriveLegacyBunSeedCandidate(masterSecret: string, attempt: number): string {
        if (attempt === 0) {
            return masterSecret;
        }
        return createHash("sha256")
            .update(`happier-auth-seed-v1:${attempt}:${masterSecret}`)
            .digest("base64url");
    }

    private async createPersistentAuthTokens(masterSecret: string): Promise<AuthTokens> {
        const generator = await privacyKit.createPersistentTokenGenerator({
            service: "handy",
            seed: masterSecret,
        });
        const primaryVerifier = await privacyKit.createPersistentTokenVerifier({
            service: "handy",
            publicKey: Uint8Array.from(generator.publicKey),
        });

        let legacyVerifierPromise: Promise<TokenVerifierLike | null> | null = null;
        const getLegacyVerifier = (): Promise<TokenVerifierLike | null> => {
            // Resolve historical keys only after a primary miss; concurrent requests
            // share the same derivation work for this auth owner's lifetime.
            legacyVerifierPromise ??= (async () => {
                const legacySeedCandidates = Array.from(
                    { length: LEGACY_BUN_SEED_CANDIDATE_COUNT },
                    (_, attempt) => this.deriveLegacyBunSeedCandidate(masterSecret, attempt),
                );
                const legacyKey =
                    await privacyKit.resolveLegacyBunStandardBase64PersistentTokenPublicKey({
                        service: "handy",
                        seedCandidates: legacySeedCandidates,
                    });

                if (!legacyKey || legacyKey.candidateIndex === 0) {
                    return null;
                }

                const legacyVerifier = await privacyKit.createPersistentTokenVerifier({
                    service: "handy",
                    publicKey: legacyKey.publicKey,
                });
                log(
                    { module: "auth", level: "warn" },
                    `Historical Bun auth-token verification enabled (attempt=${legacyKey.candidateIndex})`,
                );

                return legacyVerifier;
            })();
            return legacyVerifierPromise;
        };

        return {
            generator,
            verifier: {
                verify: async (token: string) => {
                    const verified = await primaryVerifier.verify(token);
                    if (verified !== null) return verified;
                    const legacyVerifier = await getLegacyVerifier();
                    return legacyVerifier ? legacyVerifier.verify(token) : null;
                },
            },
        };
    }

    private async createPersistentExternalActionExecutionAuthorizationTokens(
        masterSecret: string,
    ): Promise<AuthTokens> {
        const service = "happier-external-action-execution-authorization-v1";
        const generator = await privacyKit.createPersistentTokenGenerator({ service, seed: masterSecret });
        const verifier = await privacyKit.createPersistentTokenVerifier({
            service,
            publicKey: Uint8Array.from(generator.publicKey),
        });
        return { generator, verifier };
    }

    private async getOauthStateTokens(): Promise<OAuthStateTokens> {
        if (this.oauthStateTokens) {
            return this.oauthStateTokens;
        }
        if (this.oauthStateTokensInitPromise) {
            return await this.oauthStateTokensInitPromise;
        }
        const masterSecret = this.requireMasterSecret(process.env);
        const oauthStateTtlMs = this.resolveOauthStateTtlMsFromEnv(process.env);
        this.oauthStateTokensInitPromise = (async () => {
            try {
                const oauthStateGenerator = await privacyKit.createEphemeralTokenGenerator({
                    service: "happier-oauth-state",
                    seed: masterSecret,
                    ttl: oauthStateTtlMs,
                });
                const oauthStateVerifier = await privacyKit.createEphemeralTokenVerifier({
                    service: "happier-oauth-state",
                    publicKey: Uint8Array.from(oauthStateGenerator.publicKey),
                });
                return { oauthStateGenerator, oauthStateVerifier };
            } catch (error) {
                const errorName =
                    error && typeof error === "object" && "name" in error
                        ? String(error.name)
                        : "unknown";
                log(
                    { module: "auth", level: "warn" },
                    `OAuth state backend unavailable (ephemeral token init failed; error=${errorName})`
                );
                throw new OAuthStateUnavailableError();
            }
        })();

        try {
            this.oauthStateTokens = await this.oauthStateTokensInitPromise;
            return this.oauthStateTokens;
        } finally {
            this.oauthStateTokensInitPromise = null;
        }
    }

    async init(): Promise<void> {
        if (this.tokens) {
            return; // Already initialized
        }
        
        log({ module: 'auth' }, 'Initializing auth module...');
        
        const masterSecret = this.requireMasterSecret(process.env);

        const [tokens, externalActionExecutionAuthorizationTokens] = await Promise.all([
            this.createPersistentAuthTokens(masterSecret),
            this.createPersistentExternalActionExecutionAuthorizationTokens(masterSecret),
        ]);
        this.tokens = tokens;
        this.externalActionExecutionAuthorizationTokens = externalActionExecutionAuthorizationTokens;

        const tokenCacheMaxEntries = this.resolveAuthTokenCacheMaxEntriesFromEnv(process.env);
        if (tokenCacheMaxEntries > 0) {
            const tokenCacheTtlMs = this.resolveAuthTokenCacheTtlMsFromEnv(process.env);
            this.tokenCache = new LRUTtlMap({
                maxSize: tokenCacheMaxEntries,
                ttlMs: tokenCacheTtlMs,
            });
        } else {
            this.tokenCache = null;
        }
        
        log({ module: 'auth' }, 'Auth module initialized');
    }
    
    async createToken(
        userId: string,
        extras: unknown | undefined,
        options: CreateTokenOptions,
    ): Promise<string> {
        const account = await db.account.findUnique({
            where: { id: userId },
            select: { tokenEpoch: true, status: true },
        });
        if (!account) {
            throw new Error("Cannot create auth token for an unknown account");
        }

        assertAccountActive(account.status);
        return this.createTokenWithEpoch(userId, account.tokenEpoch, extras, options);
    }

    async mintExternalActionExecutionAuthorization(
        input: ExternalActionExecutionAuthorizationMintInput,
        context: ExternalActionGrantEvaluationContext = {},
    ): Promise<ExternalActionExecutionAuthorizationV1> {
        const refuse = (phase: string, code?: ApiTokenOperationError['code'], refusal?: ExecutionAuthorizationMintRefusal) =>
            refuseExecutionAuthorizationMint(`external_action.mint.${phase}`, input.actionId, code, refusal);
        if (!this.externalActionExecutionAuthorizationTokens) {
            throw new Error("Auth module not initialized");
        }
        const admitted = context.managedMachineAdmission;
        // The requester read selects an installed carrier once, including the key returned to its caller.
        const machine = input.requesterOperationRead && admitted?.requesterOperationReadPublicKey
            ? { accountId: admitted.custodianAccountId, installationId: admitted.installationId }
            : await db.machine.findUnique({ where: { id: input.machineId }, select: { accountId: true, installationId: true } });
        if (!machine?.installationId) throw refuse('machine_installation', 'target_unavailable');
        const accountMode = await db.account.findUnique({ where: { id: input.accountId }, select: { encryptionMode: true } });
        if (!accountMode) {
            throw refuse('account', 'invalid_token');
        }
        const bindingIdentity = { custodianAccountId: machine.accountId, installationId: machine.installationId,
            accountEncryptionMode: accountMode.encryptionMode };
        const requesterBinding = input.requesterOperationRead
            ? ExternalActionExecutionAuthorizationBindingV1Schema.safeParse({ ...input, ...bindingIdentity }) : undefined;
        if (requesterBinding?.success === false) throw refuse('binding_shape', 'invalid_envelope', { cause: requesterBinding.error });
        const inputRecord = typeof context.input === "object" && context.input !== null && !Array.isArray(context.input)
            ? context.input as Readonly<Record<string, unknown>> : null;
        const presetOperation = isMachinePresetFiniteOperationActionIdV1(input.actionId);
        if (input.presetPreparationAdmission !== undefined && !presetOperation) {
            throw refuse('preset_admission_supplied');
        }
        const presetPreparationAdmission = input.presetPreparationAdmission;
        const presetApiPrincipal = presetOperation && !('authentication' in input)
            ? await this.verifyCurrentApiTokenPrincipal(input) : null;
        if (presetOperation) {
            // The envelope projector owns the exact public/private input projection.
            // Mint binds its typed result to the installed execution target and preset authority.
            if (!presetPreparationAdmission || presetPreparationAdmission.homeId !== input.serverIdentityId
                || (input.actionId === MACHINE_PRESET_PREPARE_ACTION_ID_V1
                    ? !('machineId' in presetPreparationAdmission) || presetPreparationAdmission.machineId !== input.machineId
                    : 'machineId' in presetPreparationAdmission)
                || input.target.kind !== 'machine' || input.target.machineId !== input.machineId) {
                throw refuse('preset_admission_binding');
            }
            const { admitMachinePresetFiniteOperationInTx } = await import('@/app/machines/managed/machinePresetService');
            const { ManagedMachineError } = await import('@/app/machines/managed/managedRows');
            if (input.actionId !== MACHINE_PRESET_PREPARE_ACTION_ID_V1 && machine.accountId !== input.accountId) {
                throw refuse('preset_image_custodian', 'credential_scope_denied', { failureCause: {
                    phase: 'machines.presets.archive', errorClass: 'Error', errorCode: 'credential_scope_denied',
                    nativeErrorReason: 'prepared_image_custodian_required', httpStatus: null,
                } });
            }
            try {
                await inTx(tx => admitMachinePresetFiniteOperationInTx(tx, { accountId: input.accountId, input: presetPreparationAdmission,
                    actionId: input.actionId === MACHINE_PRESET_PREPARE_ACTION_ID_V1 ? 'prepare' : 'archive',
                    authentication: { authenticationAuthority: 'authentication' in input && input.authentication.kind === 'account'
                        ? 'present_user' : 'account_automation', authenticationEvidence:
                        'authentication' in input ? input.authentication.evidence : presetApiPrincipal?.authenticationEvidence } }));
            } catch (error) {
                if (error instanceof ManagedMachineError) throw refuse('preset_admission', undefined, { cause: error });
                throw error;
            }
        }
        const automationId = input.actionId === 'workflow.trigger.run_now' && typeof inputRecord?.automationId === 'string'
            ? inputRecord.automationId : undefined;
        const nativeAdmission = context.deploymentNativeAdmission ?? projectDeploymentNativeAdmissionV1(input.actionId, context.input);
        if (input.deploymentCandidatePublication !== undefined) throw refuse('deployment_candidate_publication_supplied');
        const domainRoot = isDeploymentDomainChildActionIdV1(input.actionId);
        const ingressUpdateRoot = input.actionId === 'deployments.environments.update'
            && isDeploymentEnvironmentUpdateNativeAdmissionV1(nativeAdmission);
        const configureRoot = input.actionId === DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1;
        if (configureRoot && !isDeploymentBackupConfigureNativeAdmissionV1(nativeAdmission)) throw refuse('backup_configure_admission');
        const telemetryRoot = input.actionId === DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1;
        if (telemetryRoot && !isDeploymentTelemetryNativeAdmissionV1(nativeAdmission)) throw refuse('telemetry_admission');
        const nativeMemberRoot = input.actionId === 'deployments.restart' || input.actionId === 'deployments.backups.restore'
            || isDeploymentBackupActionIdV1(input.actionId);
        // Domain API roots need the canonical sealed requester projection first.
        if (domainRoot && !('authentication' in input)) throw refuse('domain_requester_authentication');
        if (domainRoot && (!(isDeploymentDomainNativeAdmissionV1(nativeAdmission) || isDeploymentDomainDnsNativeAdmissionV1(nativeAdmission))
            || nativeAdmission.actionId !== input.actionId)) {
            throw refuse('domain_native_admission');
        }
        const admittedPrincipal = context.workflowAdmission?.principal;
        const admittedApiPrincipal = admittedPrincipal && 'grant' in admittedPrincipal ? admittedPrincipal : null;
        const approvalMetadataRoot = isDeploymentApprovalMetadataPreparationActionIdV1(input.actionId);
        const moveDefinitionRoot = input.actionId === DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1;
        const mintApiTokenPrincipal = (nativeAdmission || input.actionId === 'deployments.targets.link' || approvalMetadataRoot || moveDefinitionRoot) && !('authentication' in input)
            ? admittedApiPrincipal ?? await this.verifyCurrentApiTokenPrincipal(input) : null;
        if ((nativeAdmission || input.actionId === 'deployments.targets.link' || approvalMetadataRoot || moveDefinitionRoot) && !('authentication' in input)
            && !mintApiTokenPrincipal) throw refuse('api_principal', 'invalid_token');
        let nativeSource: Readonly<{ id: string; revision: number }> | undefined;
        if (nativeAdmission) {
            const { admitDeploymentNativeRootEnvironmentInTx } = await import('@/app/deployments/deploymentRootEnvironmentAdmission');
            const environment = await admitDeploymentNativeRootEnvironmentInTx(db, { ...input, installationId: machine.installationId }, nativeAdmission, 'authentication' in input
                ? input.authentication.evidence : mintApiTokenPrincipal?.authenticationEvidence);
            if (!environment.ok) {
                throw refuse(environment.phase ? `native_root_environment.${environment.phase}` : 'native_root_environment', environment.code, { details: environment.placement?.details,
                    failureCause: environment.placement?.failureCause });
            }
            nativeSource = environment.source;
        }
        const reviewedCandidate = context.deploymentReview;
        let reviewedPublication;
        if (reviewedCandidate) {
            if (!('authentication' in input) || input.authentication.kind !== 'account'
                || input.sessionActionOrigin || input.workflowActionOrigin || !nativeAdmission || !nativeSource) {
                throw refuse('deployment_review_context');
            }
            const original = await this.verifyExternalActionExecutionAuthorization(reviewedCandidate.originalAuthorizationToken);
            const { admitReviewedDeploymentCandidateInTx } = await import('@/app/deployments/deploymentPreparationAuthorization');
            const admittedCandidate = await inTx(tx => admitReviewedDeploymentCandidateInTx(tx, {
                request: input, installationId: machine.installationId!, original, candidate: reviewedCandidate.candidate,
                environmentId: nativeAdmission.environmentId, source: nativeSource,
            }));
            if (!admittedCandidate) throw refuse('deployment_review_candidate');
            if (admittedCandidate === 'stale') throw refuse('deployment_review_stale', 'credential_scope_denied', {
                details: { deploymentReview: 'stale' },
            });
            reviewedPublication = admittedCandidate;
        }
        let metadataEnvironmentId: string | undefined;
        let deploymentObservationReceiptId: string | undefined;
        let deploymentStopReceipt: ExternalActionExecutionAuthorizationBindingV1['deploymentStopReceipt'];
        try {
            deploymentStopReceipt = projectExternalActionDeploymentStopReceiptV1(input.actionId, inputRecord);
            metadataEnvironmentId = projectExternalActionDeploymentMetadataEnvironmentIdV1(input.actionId, inputRecord);
            // A receipt read by its own id binds that receipt's real Environment. The
            // storage read still authorizes the actor in that Environment; nothing widens.
            const receiptId = projectExternalActionDeploymentMetadataReceiptIdV1(input.actionId, inputRecord);
            if (input.actionId === DEPLOYMENT_RECEIPT_OBSERVE_ACTION_ID_V1) {
                deploymentObservationReceiptId = receiptId;
            } else if (receiptId !== undefined) {
                const receipt = await db.deployment.findUnique({ where: { id: receiptId }, select: { environmentId: true } });
                if (!receipt) throw refuse('metadata_receipt');
                metadataEnvironmentId = receipt.environmentId;
            }
        } catch (error) {
            if (error instanceof ApiTokenOperationError) throw error;
            throw refuse('metadata_projection', undefined, { cause: error });
        }
        if (metadataEnvironmentId !== undefined && nativeAdmission && metadataEnvironmentId !== nativeAdmission.environmentId) {
            throw refuse('metadata_environment_mismatch');
        }
        // Observation reads are admitted only for a requester who can read the Environment.
        const observationRoot = isDeploymentReceiptObservationActionIdV1(input.actionId);
        if (approvalMetadataRoot && !nativeAdmission || moveDefinitionRoot || observationRoot) {
            if (!metadataEnvironmentId) throw refuse('metadata_environment_missing');
            const { loadDeploymentEnvironmentInTx } = await import('../deployments/deploymentEnvironmentService');
            const { canDeployDeploymentEnvironment } = await import('../deployments/deploymentAdmission');
            const environment = await loadDeploymentEnvironmentInTx(db, input.accountId, input.serverIdentityId, metadataEnvironmentId, {
                authenticationAuthority: 'account_automation', authenticationEvidence: 'authentication' in input
                    ? input.authentication.evidence : mintApiTokenPrincipal?.authenticationEvidence,
            });
            if (!environment.ok || !observationRoot && !(isDeploymentControllerSetActionIdV1(input.actionId) || moveDefinitionRoot
                ? environment.admission.canManage && !environment.row.deletedAt
                : canDeployDeploymentEnvironment(environment.admission, environment.row))) {
                throw refuse('metadata_environment_admission');
            }
            if (deploymentStopReceipt && (environment.row.controllerMachineId !== input.machineId
                || !await db.deployment.findFirst({ where: { id: deploymentStopReceipt.deploymentId,
                    environmentId: metadataEnvironmentId, acceptedControllerMachineId: input.machineId,
                    acceptedControllerInstallationId: machine.installationId }, select: { id: true } }))) {
                throw refuse('stop_receipt_controller', 'machine_unavailable');
            }
        }
        const environmentId = metadataEnvironmentId
            ?? (input.actionId === 'deployments.deploy' || input.actionId === 'action.operations.get'
                || domainRoot || nativeMemberRoot || ingressUpdateRoot || configureRoot || telemetryRoot
                || 'authentication' in input && (input.actionId === 'deployments.rollback' || input.actionId === 'deployments.promote'
                    || input.actionId === 'deployments.teardown')
                ? nativeAdmission?.environmentId : undefined);
        if (input.environmentId !== undefined && input.environmentId !== environmentId) {
            throw refuse('environment_mismatch');
        }
        let managedAdmission = input.managedAdmission;
        if (managedAdmission?.actionId === MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1) {
            const { readServerGuestCliIdentity } = await import('@/app/runtime/serverRelease');
            managedAdmission = { ...managedAdmission,
                input: { ...managedAdmission.input, guestCli: readServerGuestCliIdentity() } };
        }
        if (managedAdmission && 'authority' in managedAdmission && managedAdmission.authority !== undefined) {
            throw refuse('managed_admission_authority_supplied');
        }
        // This is a Home decision, never an invocation author's approval bypass.
        if (input.managedAcquireDelegation !== undefined) throw refuse('managed_acquire_delegation_supplied');
        const managedAcquireDelegation = context.managedMachineAdmission?.managedAcquireDelegation;
        const sessionPresetAcquisition = context.managedMachineAdmission?.sessionPresetAcquisition;
        if (!sameStrictJsonValue(input.sessionPresetAcquisition, sessionPresetAcquisition)
            || sessionPresetAcquisition && (input.actionId !== 'session.spawn_new'
                || sessionPresetAcquisition.selection.homeId !== input.serverIdentityId
                || sessionPresetAcquisition.controller.machineId !== input.machineId
                || sessionPresetAcquisition.controller.installationId !== machine.installationId)) {
            throw refuse('session_preset_acquisition');
        }
        let managedAccountExecutor: ExternalActionExecutionAuthorizationBindingV1['managedAccountExecutor'];
        if (input.actionId === 'machines.managed.power.set' || input.actionId === 'machines.managed.delete') {
            const { ExternalActionManagedControlAdmissionV1Schema } = await import('@happier-dev/protocol/actions/externalActionApi');
            const { qualifyExternalActionManagedAccountExecutorInTx } = await import('./externalActionManagedAdmission');
            const { ManagedMachineError, sameManagedInput } = await import('@/app/machines/managed/managedRows');
            try {
                const projection = context.input === undefined ? managedAdmission
                    : ExternalActionManagedControlAdmissionV1Schema.parse({ actionId: input.actionId, input: context.input });
                if (projection !== undefined) {
                    const control = ExternalActionManagedControlAdmissionV1Schema.parse(projection);
                    if (managedAdmission && !sameManagedInput(managedAdmission, control)) throw refuse('managed_control_input');
                    managedAdmission = control;
                    if ('when' in control.input && control.input.when === 'after-idle') {
                        managedAccountExecutor = await qualifyExternalActionManagedAccountExecutorInTx(db, input, control);
                    }
                }
            } catch (error) {
                if (error instanceof ManagedMachineError) throw refuse('managed_control', undefined, { cause: error });
                throw error;
            }
        }
        if (context.managedCreationRecovery) {
            if (!managedAdmission || managedAdmission.actionId !== 'machines.managed.cancel'
                && managedAdmission.actionId !== 'machines.managed.delete') throw refuse('managed_creation_recovery');
            managedAdmission = { ...managedAdmission, authority: 'creator_recovery' };
        }
        // A caller cannot grant itself child dispatch, even on an otherwise valid root.
        if (input.deploymentChildRoot !== undefined) throw refuse('deployment_child_root_supplied');
        const deploymentChildRoot = isDeploymentChildRootActionIdV1(input.actionId, input.deploymentPreparationAdmission);
        // Home alone chooses the reviewed children this root is approved with, once, here.
        if (input.deploymentReviewedChildPlan !== undefined) throw refuse('deployment_reviewed_child_plan_supplied');
        const deploymentReviewedChildPlan = selectDeploymentReviewedChildPlanV1(input);
        // V2 encrypted `session.spawn_new` envelopes carry only the stripped
        // `sessionSpawnAdmission` projection as `context.input` (`canonical_admission`),
        // not the full plaintext input; retain the envelope-bound defaults/checkout
        // projections already parsed from the sealed V2 envelope.
        const strippedCanonicalSpawnInput = input.actionId === 'session.spawn_new'
            && context.sessionSpawnInputKind === 'canonical_admission';
        const projectSessionDefaultsAdmission = context.input === undefined || strippedCanonicalSpawnInput
            ? input.projectSessionDefaultsAdmission
            : projectExternalActionProjectSessionDefaultsAdmissionV1(input.actionId, context.input);
        if (input.projectSessionDefaultsAdmission !== undefined
            && !sameStrictJsonValue(input.projectSessionDefaultsAdmission, projectSessionDefaultsAdmission)) {
            throw refuse('project_session_defaults');
        }
        const projectSourceCheckoutId = context.input === undefined || strippedCanonicalSpawnInput
            ? input.projectSourceCheckoutId
            : projectExternalActionProjectSourceCheckoutIdV1(input.actionId, context.input);
        if (input.projectSourceCheckoutId !== undefined && projectSourceCheckoutId !== input.projectSourceCheckoutId) {
            throw refuse('project_source_checkout');
        }
        const parsedBinding = requesterBinding ?? ExternalActionExecutionAuthorizationBindingV1Schema.safeParse({
            ...input, ...bindingIdentity,
            ...(presetPreparationAdmission ? { presetPreparationAdmission } : {}),
            ...(projectSessionDefaultsAdmission ? { projectSessionDefaultsAdmission } : {}),
            ...(projectSourceCheckoutId === undefined ? {} : { projectSourceCheckoutId }),
            ...(deploymentChildRoot ? { deploymentChildRoot: true } : {}),
            ...(deploymentReviewedChildPlan ? { deploymentReviewedChildPlan } : {}),
            ...(managedAdmission ? { managedAdmission } : {}),
            ...(managedAcquireDelegation ? { managedAcquireDelegation } : {}),
            ...(managedAccountExecutor ? { managedAccountExecutor } : {}),
            ...(automationId ? { automationId } : {}),
            ...(environmentId ? { environmentId } : {}),
            ...(deploymentObservationReceiptId ? { deploymentObservationReceiptId } : {}),
            ...(deploymentStopReceipt ? { deploymentStopReceipt } : {}),
            ...((nativeAdmission && 'kind' in nativeAdmission && nativeAdmission.kind === 'promote' || ingressUpdateRoot || configureRoot || telemetryRoot || domainRoot && (isDeploymentDomainNativeAdmissionV1(nativeAdmission) || isDeploymentDomainDnsNativeAdmissionV1(nativeAdmission))
                || nativeMemberRoot && nativeAdmission && 'kind' in nativeAdmission
                    && (nativeAdmission.kind === 'restart' || nativeAdmission.kind === 'restore' || nativeAdmission.kind === 'backup'))
                ? { deploymentNativeAdmission: nativeAdmission } : {}),
            ...(reviewedPublication ? { deploymentCandidatePublication: reviewedPublication }
                : nativeAdmission && nativeSource && !domainRoot && !nativeMemberRoot && !ingressUpdateRoot && !configureRoot && !telemetryRoot ? { deploymentCandidatePublication: createDeploymentCandidatePublicationV1({
                ...input, environmentId: nativeAdmission.environmentId, source: nativeSource,
            }) } : {}),
        });
        if (!parsedBinding.success) throw refuse('binding_shape', undefined, { cause: parsedBinding.error });
        let supplied = parsedBinding.data;
        // Link's private input names the Environment; only Home derives its owner.
        if (input.deploymentLinkAdmission) throw refuse('deployment_link_admission_supplied');
        if (input.deploymentDatabaseAccess !== undefined) throw refuse('deployment_database_access_supplied');
        if (input.deploymentTelemetryRead !== undefined) throw refuse('deployment_telemetry_read_supplied');
        let linkEnvironmentId: string | undefined;
        let linkReplacement: import('@happier-dev/protocol/actions/externalActionApi').DeploymentLinkReplacementV1 | undefined;
        if (supplied.actionId === 'deployments.targets.link') {
            const { projectExternalActionDeploymentLinkEnvironmentIdV1, projectExternalActionDeploymentLinkReplacementV1 } = await import('@happier-dev/protocol/actions/externalActionApi');
            linkEnvironmentId = context.input === undefined ? context.deploymentLinkEnvironmentId
                : projectExternalActionDeploymentLinkEnvironmentIdV1(supplied.actionId, context.input);
            if (!linkEnvironmentId || context.deploymentLinkEnvironmentId !== undefined
                && context.deploymentLinkEnvironmentId !== linkEnvironmentId) throw refuse('deployment_link_environment');
            linkReplacement = context.input === undefined ? context.deploymentLinkReplacement
                : projectExternalActionDeploymentLinkReplacementV1(supplied.actionId, context.input);
            if (context.input !== undefined && context.deploymentLinkReplacement !== undefined
                && !sameStrictJsonValue(context.deploymentLinkReplacement, linkReplacement)) throw refuse('deployment_link_replacement');
        }
        // Link, preparation, registry and read admission have one owner, which a
        // person-presented relay of this root runs again.
        const { admitDeploymentRootBindingInTx } = await import('@/app/deployments/deploymentRootEnvironmentAdmission');
        const bindingAdmission = await admitDeploymentRootBindingInTx(db, supplied, {
            ...(linkEnvironmentId ? { linkEnvironmentId } : {}),
            workflowAdmitted: context.workflowAdmission !== undefined,
            authenticationEvidence: 'authentication' in supplied ? supplied.authentication.evidence : undefined,
            linkAuthenticationEvidence: 'authentication' in supplied
                ? supplied.authentication.evidence : mintApiTokenPrincipal?.authenticationEvidence,
            callerAuthority: context.callerAuthority,
        });
        if (!bindingAdmission.ok) throw refuse(bindingAdmission.phase ? `root_binding.${bindingAdmission.phase}` : 'root_binding', bindingAdmission.code, { details: bindingAdmission.placement?.details,
            failureCause: bindingAdmission.placement?.failureCause });
        if (bindingAdmission.deploymentLinkAdmission || bindingAdmission.deploymentDatabaseAccess || bindingAdmission.deploymentTelemetryRead) {
            supplied = ExternalActionExecutionAuthorizationBindingV1Schema.parse({ ...supplied,
                ...(bindingAdmission.deploymentLinkAdmission ? { deploymentLinkAdmission: { ...bindingAdmission.deploymentLinkAdmission,
                    ...(linkReplacement ? { replacement: linkReplacement } : {}) } } : {}),
                ...(bindingAdmission.deploymentDatabaseAccess ? { deploymentDatabaseAccess: bindingAdmission.deploymentDatabaseAccess } : {}),
                ...(bindingAdmission.deploymentTelemetryRead ? { deploymentTelemetryRead: bindingAdmission.deploymentTelemetryRead } : {}) });
        }
        const workspaceSyncRequest = context.workspaceSyncAdmission ?? projectWorkspaceSyncAdmissionInputV1(input.actionId, context.input);
        // Callers cannot supply Home-produced facts, including when no source was selected.
        if (input.workspaceSyncAdmission) throw refuse('workspace_sync_admission_supplied');
        const bindWorkspaceSyncSource = async (callerAuthority: import('@happier-dev/protocol/actions/metadata').ActionRequiredAuthority) => {
            if (!workspaceSyncRequest) return;
            const workspaceSyncAdmission = await readWorkspaceSyncAdmissionInTx(db, {
                binding: supplied, request: workspaceSyncRequest, callerAuthority });
            if (!workspaceSyncAdmission) throw refuse('workspace_sync_admission');
            supplied = ExternalActionExecutionAuthorizationBindingV1Schema.parse({ ...supplied, workspaceSyncAdmission });
        };
        if (supplied.managedContinuation && context.managedCreationAdmission) {
            const { readSelectedManagedCreationChildAdmission } = await import('./externalActionManagedAdmission');
            if (!readSelectedManagedCreationChildAdmission(context.managedCreationAdmission, supplied)) {
                throw refuse('managed_creation_child', 'target_unavailable');
            }
            // The selected root owns identity, grant, ceiling and Session source.
            // A child request cannot replace those facts with its own body fields.
            const principal = context.managedCreationAdmission.principal;
            const admittedBinding = { ...supplied };
            delete admittedBinding.sessionActionOrigin;
            delete admittedBinding.sessionActionSource;
            delete admittedBinding.workflowActionOrigin;
            supplied = ExternalActionExecutionAuthorizationBindingV1Schema.parse({ ...admittedBinding,
                ...('authentication' in principal ? { authentication: principal.authentication }
                    : { principalId: principal.principalId, credentialId: principal.credentialId, grant: principal.grant }),
                ...('sessionActionOrigin' in principal && principal.sessionActionOrigin ? { sessionActionOrigin: principal.sessionActionOrigin } : {}),
                ...(context.managedCreationAdmission.sessionActionSource
                    ? { sessionActionSource: context.managedCreationAdmission.sessionActionSource } : {}),
                ...('workflowActionOrigin' in principal && principal.workflowActionOrigin ? { workflowActionOrigin: principal.workflowActionOrigin } : {}),
            });
            const token = await this.externalActionExecutionAuthorizationTokens.generator.new({ user: supplied.accountId,
                extras: { externalActionExecutionAuthorizationV1: supplied } });
            return ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token, binding: supplied });
        }
        if ('authentication' in supplied) {
            const { isOriginalTerminalExecutionAction, hasCurrentOriginalSessionActionTargetInTx, hasCurrentExternalActionSessionSource,
                verifyCurrentExternalActionPrincipalInTx, readExternalActionBindingAuthority } = await import('./externalActionExecutionAuthorization');
            if (supplied.authentication.kind === 'terminal'
                && !isOriginalTerminalExecutionAction(supplied.actionId, supplied) && !supplied.workflowActionOrigin) {
                throw refuse('terminal_action');
            }
            if (!context.workflowAdmission && !await this.isSignedCredentialCurrent(db, supplied.accountId, supplied.authentication.tokenEpoch)) {
                throw refuse('signed_credential_epoch', 'invalid_token');
            }
            if (!await hasCurrentOriginalSessionActionTargetInTx(db, supplied)) throw refuse('original_session_target', 'target_unavailable');
            if (supplied.handoffAdmission) {
                const { readCurrentExternalActionHandoffBindingInTx } = await import('./externalActionExecutionAuthorization');
                if (!await readCurrentExternalActionHandoffBindingInTx(db, { accountId: supplied.accountId,
                    handoffAdmission: supplied.handoffAdmission })) throw refuse('handoff_binding');
            }
            if (supplied.sessionActionOrigin) {
                const source = supplied.sessionActionSource;
                if (!source || supplied.handoffAdmission && (source.machineId !== supplied.handoffAdmission.sourceMachineId
                    || source.installationId !== supplied.handoffAdmission.sourceInstallationId)) throw refuse('session_action_source');
                const nativeRelease = supplied.actionId === 'machines.managed.credentials.install'
                    && supplied.managedAdmission?.actionId === supplied.actionId
                    && supplied.managedAdmission.input.operation === 'release';
                const current = nativeRelease
                    ? await hasCurrentExternalActionSessionSource(supplied, context.resolveCurrentSessionMachine)
                    : supplied.handoffContinuation
                    ? await hasCurrentSessionScopedMachineAccessInTx({ tx: db, accountId: supplied.accountId,
                        machineId: source.machineId, sessionId: supplied.sessionActionOrigin.caller.sessionId })
                    : await hasCurrentSessionActionRpcSourceBinding({ accountId: supplied.accountId, ...source,
                        sourceSessionId: supplied.sessionActionOrigin.caller.sessionId,
                        resolveCurrentSessionMachine: context.resolveCurrentSessionMachine });
                if (!current) throw refuse('session_action_source_current', 'target_unavailable');
            }
            if (supplied.workflowActionOrigin && !context.workflowAdmission) {
                const { hasCurrentExternalActionWorkflowOriginInTx } = await import('./externalActionExecutionAuthorization');
                if (!await hasCurrentExternalActionWorkflowOriginInTx(db, supplied)) {
                    throw refuse('workflow_origin');
                }
            }
            // HTTP issuance and direct daemon dispatch share this mint. Reuse
            // its current principal reader before issuing any decision root.
            if ((DECISION_ACTION_IDS as readonly string[]).includes(supplied.actionId)
                && !await verifyCurrentExternalActionPrincipalInTx(db, supplied)) {
                throw refuse('decision_principal');
            }
            if (workspaceSyncRequest) {
                const principal = await verifyCurrentExternalActionPrincipalInTx(db, supplied);
                if (!principal) throw refuse('workspace_sync_principal', 'invalid_token');
                await bindWorkspaceSyncSource(principal.authority);
            }
            if (!await admitExternalActionBrowserSessionInTx(db, { binding: supplied, actionInput: context.input,
                browserSessionId: context.browserSessionId, authentication: { env: process.env,
                    authority: readExternalActionBindingAuthority(supplied),
                    authenticationEvidence: supplied.authentication.evidence, tokenEpoch: supplied.authentication.tokenEpoch } })) {
                throw refuse('browser_session', 'target_unavailable');
            }
            const token = await this.externalActionExecutionAuthorizationTokens.generator.new({
                user: supplied.accountId,
                extras: { externalActionExecutionAuthorizationV1: supplied },
            });
            return ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token, binding: supplied });
        }
        // A verified assigned Run spends its signed admission; revocation is
        // considered when admitting the next job, not again for each finite leaf.
        const principal = admittedApiPrincipal ?? mintApiTokenPrincipal ?? presetApiPrincipal ?? await this.verifyCurrentApiTokenPrincipal(supplied);
        if (!principal) throw refuse('api_principal_current', 'invalid_token');
        const qualifiedAction = parseQualifiedPluginActionId(supplied.actionId);
        const invokedAction = supplied.actionId === "action.invoke"
            ? PluginContributionIdentityV1Schema.safeParse(inputRecord?.action) : null;
        const contributedQualifiedId = qualifiedAction ? supplied.actionId
            : invokedAction?.success ? formatQualifiedPluginActionId(invokedAction.data) : undefined;
        if (!isApiTokenGrantWithinV1(supplied.grant, principal.grant)) throw refuse('grant_ceiling');
        if (supplied.automationId !== automationId) throw refuse('automation_id');
        if (supplied.actionId === 'deployments.deploy') {
            // New roots use the current Source/controller admission. Issued
            // native-fact verification retains its separate lifecycle rules.
            if (!environmentId || supplied.target.kind !== 'machine' || supplied.target.machineId !== supplied.machineId) {
                throw refuse('deploy_target');
            }
            const { loadDeploymentEnvironmentInTx } = await import('../deployments/deploymentEnvironmentService');
            const { canDeployDeploymentEnvironment, admitDeploymentMachineInTx } = await import('../deployments/deploymentAdmission');
            const environment = await loadDeploymentEnvironmentInTx(db, supplied.accountId, supplied.serverIdentityId, environmentId, {
                authenticationAuthority: 'account_automation', authenticationEvidence: principal.authenticationEvidence,
            });
            if (!environment.ok || !canDeployDeploymentEnvironment(environment.admission, environment.row)
                || environment.row.controllerMachineId !== supplied.machineId
                || await admitDeploymentMachineInTx(db, environment.admission.owner, supplied.machineId, 'controller', supplied.installationId)) {
                throw refuse('deploy_environment');
            }
        }
        const { readExternalActionCredentialActionId } = await import('./externalActionExecutionAuthorization');
        const usageParent = context.usageCollectorParent;
        if (supplied.usageCollectorParent && (!usageParent || 'authentication' in usageParent
            || supplied.usageCollectorParent.requestId !== usageParent.requestId
            || supplied.usageCollectorParent.requestEnvelopeDigest !== usageParent.requestEnvelopeDigest
            || supplied.credentialId !== usageParent.credentialId || supplied.principalId !== usageParent.principalId
            || !sameStrictJsonValue(supplied.grant, usageParent.grant))) throw refuse('usage_collector_parent');
        const admission = supplied.usageCollectorParent ? { ok: true as const } : evaluateApiTokenGrantV1({ grant: supplied.grant,
            actionId: qualifiedAction ? "action.invoke" : readExternalActionCredentialActionId(supplied), contributedQualifiedId,
            contributedActionAdmission: 'pre_open',
            automationAdmission: 'pre_open',
            ...(context.sessionSpawnInputKind === undefined ? {} : {
                sessionSpawnInputKind: context.sessionSpawnInputKind,
            }),
            target: supplied.target, targetMachineId: supplied.machineId,
            automationId,
            ...(environmentId ? { environmentId, ...(API_TOKEN_ENVIRONMENT_ACTION_IDS_V1.some(id => id === supplied.actionId)
                ? { environmentAdmission: 'pre_open' as const } : {}) } : {}),
            ...(supplied.actionId === "session.spawn_new" && !supplied.handoffContinuation && context.input !== undefined ? { spawnInput: context.input } : {}),
        });
        if (!admission.ok) throw refuse('grant', undefined, { grantReason: admission.reason });
        await bindWorkspaceSyncSource(principal.authority);
        if (!await admitExternalActionBrowserSessionInTx(db, { binding: supplied, actionInput: context.input,
            browserSessionId: context.browserSessionId, authentication: { env: process.env, authority: principal.authority,
                authenticationEvidence: principal.authenticationEvidence, apiTokenGrant: principal.grant } })) {
            throw refuse('api_browser_session', 'target_unavailable');
        }
        const binding = supplied;
        const token = await this.externalActionExecutionAuthorizationTokens.generator.new({
            user: binding.accountId,
            extras: { externalActionExecutionAuthorizationV1: binding },
        });
        return ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token, binding });
    }

    /** Derive only an exact private phase of the original signed bounded handoff. */
    async deriveExternalActionHandoffAuthorization(
        original: ExternalActionExecutionAuthorizationV1,
        phase: Readonly<{ machineId: string; actionId: string; requestEnvelopeDigest: string }>
            & (Readonly<{ kind: 'continuation'; handoffId: string }> | Readonly<{ kind: 'preflight' }>),
    ): Promise<ExternalActionExecutionAuthorizationV1> {
        const refuse = (step: string, code?: ApiTokenOperationError['code']) =>
            refuseExecutionAuthorizationMint(`external_action.handoff.${phase.kind}.${step}`, phase.actionId, code);
        const root = await this.verifyExternalActionExecutionAuthorization(original.token);
        if (!root || !sameStrictJsonValue(root, original.binding) || root.actionId !== 'session.handoff'
            || !root.handoffAdmission || root.handoffContinuation || root.handoffPreflight
            || !hasAdmittedExternalActionHandoffScope(root)
            || (phase.kind === 'preflight' ? phase.actionId !== 'session.handoff'
                : !(phase.actionId.startsWith('session.handoff.') || phase.actionId === 'session.spawn_new'))) {
            throw refuse('root', 'invalid_token');
        }
        const machine = await readAdmittedExternalActionHandoffMachineInTx(db, root, phase.machineId);
        if (!machine) throw refuse('machine', 'target_unavailable');
        const binding = ExternalActionExecutionAuthorizationBindingV1Schema.parse({ ...root,
            machineId: machine.machineId, installationId: machine.installationId, custodianAccountId: machine.custodianAccountId,
            admittedMachineRole: machine.role,
            actionId: phase.actionId, target: { kind: 'machine', machineId: machine.machineId },
            requestEnvelopeDigest: phase.requestEnvelopeDigest,
            ...(phase.kind === 'preflight'
                ? { handoffPreflight: { rootRequestId: root.requestId, rootRequestEnvelopeDigest: root.requestEnvelopeDigest } }
                : { handoffContinuation: { rootRequestId: root.requestId, rootRequestEnvelopeDigest: root.requestEnvelopeDigest,
                    handoffId: phase.handoffId } }) });
        if (!hasAdmittedExternalActionHandoffScope(binding)) throw refuse('scope');
        if (!this.externalActionExecutionAuthorizationTokens) throw new Error('Auth module not initialized');
        const token = await this.externalActionExecutionAuthorizationTokens.generator.new({ user: binding.accountId,
            extras: { externalActionExecutionAuthorizationV1: binding } });
        return ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token, binding });
    }

    async verifyExternalActionExecutionAuthorization(
        token: string,
    ): Promise<ExternalActionExecutionAuthorizationBindingV1 | null> {
        if (!this.externalActionExecutionAuthorizationTokens) {
            throw new Error("Auth module not initialized");
        }
        try {
            const verified = await this.externalActionExecutionAuthorizationTokens.verifier.verify(token);
            if (typeof verified !== "object" || verified === null || Array.isArray(verified)) return null;
            const payload = verified as Readonly<Record<string, unknown>>;
            const userCandidate = payload.user ?? payload.userId;
            const extras = this.asTokenExtras(payload.extras);
            const binding = ExternalActionExecutionAuthorizationBindingV1Schema.safeParse(
                extras?.externalActionExecutionAuthorizationV1,
            );
            if (!binding.success || userCandidate !== binding.data.accountId) return null;
            return binding.data;
        } catch {
            return null;
        }
    }

    /**
     * Server-internal Personal Home readiness proof. The transient token string is
     * never returned: this owner mints and verifies one ordinary present-user
     * token using the loaded Home secret, then exposes only typed facts.
     */
    async attestPresentUserTokenRoundTrip(): Promise<Readonly<{
        authenticated: true;
    }>> {
        const account = await db.account.findFirst({
            where: { status: "active" },
            orderBy: { id: "asc" },
            select: { id: true },
        });
        if (!account) {
            throw new Error("Personal Home readiness requires an active Account");
        }
        const token = await this.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });
        const verified = await this.verifyToken(token);
        if (
            !verified
            || verified.userId !== account.id
            || verified.authTokenKind !== "account"
            || verified.authority !== "present_user"
            || verified.legacy
        ) {
            throw new Error("Personal Home authentication readiness attestation failed");
        }
        return { authenticated: true };
    }

    /** Account-auth completion uses the same serializable transaction for the
     * epoch read and the sealed-result CAS. The raw token remains transaction-local. */
    async createTokenInTx(
        tx: Tx,
        userId: string,
        extras: unknown | undefined,
        options: CreateTokenOptions,
    ): Promise<string> {
        const account = await tx.account.findUnique({
            where: { id: userId },
            select: { tokenEpoch: true, status: true },
        });
        if (!account) {
            throw new Error("Cannot create auth token for an unknown account");
        }

        assertAccountActive(account.status);
        return this.createTokenWithEpoch(userId, account.tokenEpoch, extras, options);
    }

    private async createTokenWithEpoch(
        userId: string,
        tokenEpoch: number,
        extras: unknown,
        options: CreateTokenOptions,
    ): Promise<string> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }

        // Provenance is an explicit mint decision: no endpoint, extras, or
        // token shape may infer or default it. A missing or non-canonical
        // kind/authority pairing fails closed through the protocol owner;
        // API tokens remain exclusively database-minted.
        if (options?.kind === "api_token") {
            throw new Error("API tokens must be minted through createApiToken");
        }
        const provenance = options.authenticationEvidence === undefined
            ? AuthTokenProvenanceSchema.parse({
                v: 1,
                kind: options.kind,
                authority: options.authority,
            })
            : AuthTokenProvenanceV2Schema.parse({
                v: 2,
                kind: options.kind,
                authority: options.authority,
                evidence: options.authenticationEvidence,
            });

        return await this.tokens.generator.new({
            user: userId,
            extras: {
                ...this.asTokenExtras(extras),
                // `provenance` is a JWT top-level claim emitted by the token
                // generator, never caller-controlled nested extras.
                provenance,
                tokenEpoch,
            },
        });
    }

    /**
     * Mints an Account API token. Its plaintext bearer is intentionally
     * returned only here; all subsequent API-token operations use summaries.
     */
    async createApiToken(params: CreateApiTokenParams, nowInput: Date = new Date()): Promise<CreatedApiToken> {
        return this.mintApiToken(params, nowInput);
    }

    async createChildApiToken(params: Readonly<{
        principal: VerifiedApiTokenPrincipal;
        tokenId: string; label: PrivateLabelStoredV1; expiresAt: Date; grant: ApiTokenGrantV1;
        requireCreatedByChildTokenId?: string;
        resolveSessionMachine?: (sessionId: string) => Promise<string | null>;
    }>): Promise<CreatedApiToken> {
        if (params.principal.parentTokenId !== null) throw new ApiTokenOperationError("api_token_child_forbidden");
        return this.mintApiToken({ accountId: params.principal.accountId, tokenId: params.tokenId,
            label: params.label, expiresAt: params.expiresAt, grant: params.grant }, new Date(), {
            parentTokenId: params.principal.credentialId,
            requireCreatedByChildTokenId: params.requireCreatedByChildTokenId,
            resolveSessionMachine: params.resolveSessionMachine,
        });
    }

    private async mintApiToken(params: CreateApiTokenParams, nowInput: Date, child?: Readonly<{
        parentTokenId: string;
        requireCreatedByChildTokenId?: string;
        resolveSessionMachine?: (sessionId: string) => Promise<string | null>;
    }>): Promise<CreatedApiToken> {
        const accountId = params.accountId.trim();
        if (!accountId) {
            throw new Error("Cannot create an API token without an account id");
        }
        if ((params.authenticationEvidence?.length ?? 0) > AUTH_TOKEN_AUTHENTICATION_EVIDENCE_MAX_ITEMS) {
            throw new ApiTokenOperationError("credential_authentication_evidence_limit");
        }

        const now = new Date(nowInput.getTime());
        const expiresAt = params.expiresAt == null
            ? null
            : new Date(params.expiresAt.getTime());
        if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now)) {
            throw new InvalidApiTokenExpiryError();
        }

        const encryption = params.encryption
            ? AccountApiTokenCreateEncryptionV1Schema.parse(params.encryption)
            : null;
        let grant = ApiTokenGrantV1Schema.parse(params.grant ?? API_TOKEN_FULL_GRANT_V1);
        let embedConfig = params.embedConfig === undefined ? null : EmbedConfigV1Schema.parse(params.embedConfig);
        const serverIdentityId = encryption || params.deployment !== undefined ? await getOrCreateServerIdentityId() : null;
        try {
            if (params.deployment && params.deployment.serverId !== serverIdentityId) throw new Error('credential_scope_denied');
            grant = resolveApiTokenDeploymentGrantV1(grant, params.deployment);
        } catch { throw new ApiTokenOperationError('credential_scope_denied'); }
        const tokenId = params.tokenId;
        const secret = randomBytes(API_TOKEN_SECRET_BYTES).toString("base64url");
        const displayPrefix = createApiTokenDisplayPrefix(tokenId);
        const secretDigest = createApiTokenSecretDigest(secret).toString("base64url");
        // Discovery may cross Socket.IO's adapter boundary. Keep it outside the
        // interactive transaction, then revalidate the exact access relationship
        // under the same owner fence as the parent grant and child write.
        const resolvedSessionMachines = new Map<string, string | null>();
        if (child && grant.targets && child.resolveSessionMachine) {
            for (const sessionId of grant.targets.sessions) {
                resolvedSessionMachines.set(sessionId, await child.resolveSessionMachine(sessionId));
            }
        }
        // Root mints are Account-local: the Account fence precedes every admission
        // read, so they use inTx's ReadCommitted default. Child admission additionally
        // composes parent, Session/Machine access, creator-child, and count predicates
        // that are not all protected by that fence or CAS, so it remains Serializable.
        const transactionOptions = child
            ? { isolationLevel: "Serializable" as const }
            : undefined;
        const created = await inTx(async (tx) => {
            // A child is derived content under its root credential: Account
            // authority changes must still exclude it, while ordinary Session
            // metadata publication must not serialize every frame credential mint.
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, accountId, child ? "content" : "exclusive");
            const admission = await tx.account.findUniqueOrThrow({ where: { id: accountId }, select: { status: true, encryptionMode: true } });
            assertAccountActive(admission.status);
            const label = requireAdmittedApiTokenLabel(await admitAccountPrivateLabelWriteInTx(tx, {
                accountId,
                mode: requireApiTokenLabelMode(admission),
                stored: params.label,
            }));
            if (child) {
                const parent = await tx.accountApiToken.findFirst({
                    where: { id: child.parentTokenId, accountId },
                    select: { parentTokenId: true, expiresAt: true, accessGrant: true, embedConfig: true },
                });
                if (!parent || (parent.expiresAt && parent.expiresAt <= now)) throw new ApiTokenOperationError("invalid_token");
                if (parent.parentTokenId !== null) throw new ApiTokenOperationError("api_token_child_forbidden");
                if (!expiresAt || (parent.expiresAt && expiresAt > parent.expiresAt)) throw new ApiTokenOperationError("api_token_child_invalid");
                const parentGrant = readApiTokenGrant(parent.accessGrant);
                let attenuationParent = parentGrant;
                // Pure set attenuation cannot infer Session→Machine membership. Resolve only
                // added Sessions through the same current-publisher owner as live admission.
                if (parentGrant.targets && grant.targets) {
                    const verifiedSessions = [...parentGrant.targets.sessions];
                    for (const sessionId of grant.targets.sessions) {
                        if (verifiedSessions.includes(sessionId)) continue;
                        const machineId = resolvedSessionMachines.get(sessionId);
                        if (!machineId || !parentGrant.targets.machines.includes(machineId)
                            || !await hasCurrentSessionScopedMachineAccessInTx({ tx, accountId, machineId, sessionId })) {
                            throw new ApiTokenOperationError("api_token_child_invalid");
                        }
                        verifiedSessions.push(sessionId);
                    }
                    attenuationParent = { ...parentGrant, targets: { ...parentGrant.targets, sessions: verifiedSessions } };
                }
                if (!isApiTokenGrantWithinV1(grant, attenuationParent)) throw new ApiTokenOperationError("api_token_child_invalid");
                if (child.requireCreatedByChildTokenId !== undefined) {
                    const creator = await tx.accountApiToken.findFirst({ where: {
                        id: child.requireCreatedByChildTokenId, accountId, parentTokenId: child.parentTokenId,
                    }, select: { id: true } });
                    if (!creator || !grant.targets || grant.targets.machines.length || !grant.targets.sessions.length) {
                        throw new ApiTokenOperationError("api_token_child_invalid");
                    }
                    const count = await tx.session.count({ where: { accountId, id: { in: grant.targets.sessions },
                        createdByApiTokenId: creator.id } });
                    if (count !== grant.targets.sessions.length) throw new ApiTokenOperationError("api_token_child_invalid");
                }
                embedConfig = readApiTokenEmbedConfig(parent.embedConfig);
            }
            if (encryption) {
                const account = await tx.account.findUniqueOrThrow({ where: { id: accountId }, select: {
                    publicKey: true, encryptionMode: true, contentPublicKey: true, contentPublicKeySig: true,
                } });
                if (!serverIdentityId || !matchesApiTokenEncryptionBinding(account, encryption.access, serverIdentityId)) {
                    throw new ApiTokenOperationError("api_token_encryption_not_ready");
                }
            }
            const authenticationEvidence = await resolveCurrentAuthenticationEvidenceInTx(tx, {
                env: process.env,
                accountId,
                evidence: params.authenticationEvidence,
            });
            if (params.authenticationEvidence !== undefined && authenticationEvidence.length === 0) {
                throw new ApiTokenOperationError("credential_authentication_evidence_unavailable");
            }
            const authenticationEvidenceSnapshot = authenticationEvidence.length > 0
                ? AuthTokenAuthenticationEvidenceSnapshotV1Schema.parse({ v: 1, evidence: authenticationEvidence })
                : null;
            const row = await tx.accountApiToken.create({
                data: {
                    id: tokenId,
                    accountId,
                    displayPrefix,
                    secretDigest,
                    label: serializePrivateLabelStoredV1(label),
                    createdAt: now,
                    expiresAt,
                    accessGrant: grant,
                    ...(child ? { parentTokenId: child.parentTokenId } : {}),
                    ...(!child && embedConfig ? { embedConfig } : {}),
                    ...(encryption ? { encryptionAccess: encryption.access } : {}),
                    ...(authenticationEvidenceSnapshot ? { authenticationEvidence: authenticationEvidenceSnapshot } : {}),
                },
                select: {
                    id: true,
                    label: true,
                    displayPrefix: true,
                    createdAt: true,
                    expiresAt: true,
                    authenticationEvidence: true,
                },
            });
            return {
                row,
                label: projectPrivateLabelForRecipientV1({ stored: label, recipientAccountId: accountId }),
            };
        }, transactionOptions).catch((error: unknown) => {
            if (isPrismaErrorCode(error, "P2002")) throw new ApiTokenOperationError("api_token_id_conflict");
            throw error;
        });

        return {
            tokenId: created.row.id,
            token: createApiTokenBearer(tokenId, secret),
            label: created.label,
            displayPrefix: created.row.displayPrefix,
            createdAt: created.row.createdAt,
            expiresAt: created.row.expiresAt,
            hasEncryptionAccess: encryption !== null,
            hasUnattendedTeamAccess: parseAuthenticationEvidenceSnapshot(created.row.authenticationEvidence) !== null,
            grant,
            parentTokenId: child?.parentTokenId ?? null,
            activeChildCount: 0,
            embedConfig,
        };
    }

    /** Summaries deliberately omit the bearer secret and its stored digest. */
    async listApiTokens(accountId: string, options: Readonly<{ includeChildren?: boolean; tokenId?: string }> = {}): Promise<readonly ApiTokenSummary[]> {
        const ownerAccountId = accountId.trim();
        const owner = await db.account.findUnique({
            where: { id: ownerAccountId },
            select: { encryptionMode: true },
        });
        if (!owner) return [];
        const rows = await db.accountApiToken.findMany({
            where: { accountId: ownerAccountId, ...(options.includeChildren === true ? {} : { parentTokenId: null }),
                ...(options.tokenId === undefined ? {} : { id: options.tokenId }) },
            orderBy: { createdAt: "desc" },
            select: {
                id: true,
                label: true,
                displayPrefix: true,
                createdAt: true,
                lastUsedAt: true,
                expiresAt: true,
                encryptionAccess: true,
                authenticationEvidence: true,
                accessGrant: true, embedConfig: true, parentTokenId: true,
                _count: { select: { children: { where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } } } },
            },
        });
        const mode = requireApiTokenLabelMode(owner);
        return rows.map((row) => ({
            tokenId: row.id,
            label: projectApiTokenLabelForAccount({
                serialized: row.label,
                mode,
                accountId: ownerAccountId,
            }),
            displayPrefix: createApiTokenDisplayPrefix(row.id),
            createdAt: row.createdAt,
            lastUsedAt: row.lastUsedAt,
            expiresAt: row.expiresAt,
            hasEncryptionAccess: row.encryptionAccess != null,
            hasUnattendedTeamAccess: parseAuthenticationEvidenceSnapshot(row.authenticationEvidence) !== null,
            grant: readApiTokenGrant(row.accessGrant),
            parentTokenId: row.parentTokenId,
            activeChildCount: row._count.children,
            embedConfig: readApiTokenEmbedConfig(row.embedConfig),
        }));
    }

    async updateApiToken(params: Readonly<{
        accountId: string; tokenId: string; label?: PrivateLabelStoredV1; grant?: ApiTokenGrantV1; embedConfig?: EmbedConfigV1 | null;
        authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
        deployment?: AccountApiTokenDeploymentInputV1 | null;
    }>): Promise<Readonly<{ apiToken: ApiTokenSummary; revokedTokenIds: readonly string[]; grantChanged: boolean; embedConfigChanged: boolean;
        authenticationEvidenceChanged: boolean }>> {
        if ((params.authenticationEvidence?.length ?? 0) > AUTH_TOKEN_AUTHENTICATION_EVIDENCE_MAX_ITEMS) {
            throw new ApiTokenOperationError("credential_authentication_evidence_limit");
        }
        const serverIdentityId = params.deployment !== undefined ? await getOrCreateServerIdentityId() : '';
        const result = await inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, params.accountId, "exclusive");
            // A person may renew a child's own evidence without editing its attenuated grant or configuration.
            const evidenceOnly = params.authenticationEvidence !== undefined && params.label === undefined
                && params.grant === undefined && params.embedConfig === undefined && params.deployment === undefined;
            const row = await tx.accountApiToken.findFirst({ where: { id: params.tokenId, accountId: params.accountId,
                ...(evidenceOnly ? {} : { parentTokenId: null }) },
                select: { accessGrant: true, embedConfig: true, authenticationEvidence: true,
                    Account: { select: { encryptionMode: true } } } });
            if (!row) throw new ApiTokenOperationError("invalid_token");
            const mode = requireApiTokenLabelMode(row.Account);
            const label = params.label === undefined ? undefined : requireAdmittedApiTokenLabel(
                await admitAccountPrivateLabelWriteInTx(tx, {
                    accountId: params.accountId,
                    mode,
                    stored: params.label,
                }),
            );
            const authenticationEvidence = params.authenticationEvidence === undefined ? undefined
                : await resolveCurrentAuthenticationEvidenceInTx(tx, {
                    env: process.env, accountId: params.accountId, evidence: params.authenticationEvidence,
                });
            if (authenticationEvidence !== undefined && authenticationEvidence.length === 0) {
                throw new ApiTokenOperationError("credential_authentication_evidence_unavailable");
            }
            const authenticationEvidenceSnapshot = authenticationEvidence === undefined ? undefined
                : AuthTokenAuthenticationEvidenceSnapshotV1Schema.parse({ v: 1, evidence: authenticationEvidence });
            const authenticationEvidenceChanged = authenticationEvidenceSnapshot !== undefined
                && !isDeepStrictEqual(authenticationEvidenceSnapshot, parseAuthenticationEvidenceSnapshot(row.authenticationEvidence));
            let grant = params.grant === undefined ? undefined : ApiTokenGrantV1Schema.parse(params.grant);
            try {
                if (params.deployment !== undefined) {
                    if (params.deployment && params.deployment.serverId !== serverIdentityId) throw new Error('credential_scope_denied');
                    grant = resolveApiTokenDeploymentGrantV1(grant ?? readApiTokenGrant(row.accessGrant), params.deployment);
                }
            } catch { throw new ApiTokenOperationError('credential_scope_denied'); }
            const grantChanged = grant !== undefined && JSON.stringify(grant) !== JSON.stringify(readApiTokenGrant(row.accessGrant));
            const embedConfig = params.embedConfig === undefined ? undefined
                : params.embedConfig === null ? null : EmbedConfigV1Schema.parse(params.embedConfig);
            const embedConfigChanged = embedConfig !== undefined && !isDeepStrictEqual(embedConfig, readApiTokenEmbedConfig(row.embedConfig));
            const children = grantChanged ? await tx.accountApiToken.findMany({ where: { parentTokenId: params.tokenId }, select: { id: true } }) : [];
            if (grantChanged) await tx.accountApiToken.deleteMany({ where: { parentTokenId: params.tokenId } });
            await tx.accountApiToken.update({ where: { id: params.tokenId }, data: {
                ...(authenticationEvidenceSnapshot === undefined ? {} : {
                    authenticationEvidence: authenticationEvidenceSnapshot,
                }),
                ...(label !== undefined ? { label: serializePrivateLabelStoredV1(label) } : {}),
                ...(grant !== undefined ? { accessGrant: grant } : {}),
                ...(embedConfig !== undefined ? { embedConfig: embedConfig === null
                    ? getActivePrismaRuntime().DbNull : embedConfig } : {}),
            } });
            return { grantChanged, embedConfigChanged, authenticationEvidenceChanged, revokedTokenIds: children.map((child) => child.id) };
        });
        const apiToken = (await this.listApiTokens(params.accountId, { includeChildren: params.authenticationEvidence !== undefined,
            tokenId: params.tokenId }))
            .find((token) => token.tokenId === params.tokenId);
        if (!apiToken) throw new ApiTokenOperationError("invalid_token");
        return { ...result, apiToken };
    }

    /** Selects only the credential authenticated by the request; never admits or repairs keys. */
    async getApiTokenEncryptionAccess(principal: VerifiedApiTokenPrincipal): Promise<AccountApiTokenEncryptionAccessResponseV1> {
        const serverIdentityId = await getOrCreateServerIdentityId();
        return await inTx(async (tx) => {
            const row = await tx.accountApiToken.findFirst({
                where: { id: principal.credentialId, accountId: principal.accountId },
                select: { parentTokenId: true, encryptionAccess: true, expiresAt: true, Account: { select: {
                    status: true, publicKey: true, encryptionMode: true, contentPublicKey: true, contentPublicKeySig: true,
                } } },
            });
            if (!row || !isActiveHomeAccountStatus(row.Account.status) || (row.expiresAt && row.expiresAt <= new Date())) throw new ApiTokenOperationError("invalid_token");
            if (row.parentTokenId !== null) throw new ApiTokenOperationError("api_token_encryption_unavailable");
            if (row.encryptionAccess == null) throw new ApiTokenOperationError("api_token_encryption_unavailable");
            const parsed = AccountApiTokenEncryptionAccessV1Schema.safeParse(row.encryptionAccess);
            if (!parsed.success || !matchesApiTokenEncryptionBinding(row.Account, parsed.data, serverIdentityId)) {
                throw new ApiTokenOperationError("api_token_encryption_stale");
            }
            return { v: 1 as const, accountId: principal.accountId, tokenId: principal.credentialId, encryptionAccess: parsed.data };
        });
    }

    /** Revocation is deletion: the next verification cannot find this selector. */
    async revokeApiToken(params: Readonly<{ accountId: string; tokenId: string; parentTokenId?: string }>): Promise<ApiTokenRevocation> {
        return inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, params.accountId, "exclusive");
            const where = { id: params.tokenId, accountId: params.accountId.trim(),
                ...(params.parentTokenId !== undefined ? { parentTokenId: params.parentTokenId } : {}) };
            const row = await tx.accountApiToken.findFirst({ where, select: { id: true, children: { select: { id: true } } } });
            if (!row) return { revoked: false, revokedTokenIds: [] };
            await tx.accountApiToken.deleteMany({ where });
            return { revoked: true, revokedTokenIds: [row.id, ...row.children.map((child) => child.id)] };
        });
    }

    async revokeChildApiToken(principal: VerifiedApiTokenPrincipal, tokenId: string): Promise<ApiTokenRevocation> {
        if (principal.parentTokenId !== null) throw new ApiTokenOperationError("api_token_child_forbidden");
        return this.revokeApiToken({ accountId: principal.accountId, tokenId, parentTokenId: principal.credentialId });
    }

    /** Used by the present-user Action after its caller policy is registered. */
    async revokeAllApiTokens(accountId: string): Promise<ApiTokenRevokeAllResult> {
        return inTx((tx) => this.revokeAllApiTokensInTx(tx, accountId));
    }

    /** Deletes complete PAT rows in the caller's Account transition. */
    async revokeAllApiTokensInTx(tx: Tx, accountId: string): Promise<ApiTokenRevokeAllResult> {
        await acquireAccountSessionOwnerMetadataFenceInTx(tx, accountId, "exclusive");
        const rows = await tx.accountApiToken.findMany({ where: { accountId: accountId.trim() }, select: { id: true } });
        const result = await tx.accountApiToken.deleteMany({
            where: { accountId: accountId.trim() },
        });
        return { revokedCount: result.count, revokedTokenIds: rows.map((row) => row.id) };
    }

    /**
     * Verifies a current signed credential (or a PAT). Signed credentials must
     * carry a supported closed provenance version (evidence-free V1 or
     * evidence-bearing V2); pre-marker credentials are intentionally not
     * accepted on this canonical route-auth path.
     */
    async verifyToken(token: string): Promise<VerifiedAuthToken | null> {
        const result = await this.verifyTokenInternal(token, { allowLegacyHome: false });
        return isRejectedRestrictedCredential(result) ? null : result;
    }

    /**
     * Bounded compatibility reader for pre-marker ordinary Home credentials.
     * This is an explicit migration seam: it never admits PATs, Directory
     * credentials, or malformed/future markers and must not be used by generic
     * route admission.
     */
    async verifyLegacyHomeToken(token: string): Promise<VerifiedAuthToken | null> {
        const verified = await this.verifyTokenInternal(token, { allowLegacyHome: true });
        if (
            isRejectedRestrictedCredential(verified)
            || !verified
            || !verified.legacy
            || (verified.authTokenKind !== "account" && verified.authTokenKind !== "terminal")
        ) {
            return null;
        }
        return verified;
    }

    /** Route/socket compatibility boundary: strict current tokens first, then
     * the explicitly named pre-marker ordinary-Home reader. */
    async verifyTokenForRoute(token: string): Promise<VerifiedAuthToken | null> {
        const disposition = await this.verifyTokenDisposition(token, { allowLegacyHome: true });
        return disposition.status === "verified" ? disposition.credential : null;
    }

    /**
     * Canonical request-boundary disposition. A cryptographically verified
     * restricted Runner credential remains distinguishable after its database
     * currentness is revoked, while malformed and arbitrary bearers stay
     * indistinguishable from other invalid credentials.
     */
    async verifyTokenDisposition(
        token: string,
        options: Readonly<{ allowLegacyHome: boolean }>,
    ): Promise<AuthTokenVerificationDisposition> {
        const strict = await this.verifyTokenInternal(token, { allowLegacyHome: false });
        if (isRejectedRestrictedCredential(strict)) return strict;
        if (strict) return { status: "verified", credential: strict };
        if (!options.allowLegacyHome) return { status: "invalid" };

        const legacy = await this.verifyTokenInternal(token, { allowLegacyHome: true });
        if (isRejectedRestrictedCredential(legacy)) return legacy;
        if (
            legacy
            && legacy.legacy
            && (legacy.authTokenKind === "account" || legacy.authTokenKind === "terminal")
        ) {
            return { status: "verified", credential: legacy };
        }
        return { status: "invalid" };
    }

    private async verifyTokenInternal(
        token: string,
        options: Readonly<{ allowLegacyHome: boolean }>,
    ): Promise<AuthTokenInternalVerification> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }

        // API tokens have a reserved bearer prefix. A malformed token must not
        // fall through to the signed-token verifier or gain a second auth path.
        if (isApiTokenCandidate(token)) {
            if (options.allowLegacyHome) return null;
            const verifiedPat = await this.verifyPat(token);
            if (!verifiedPat.ok) {
                return null;
            }
            return {
                userId: verifiedPat.principalId,
                authTokenKind: "api_token",
                authority: verifiedPat.authority,
                legacy: false,
                apiTokenPrincipal: {
                    accountId: verifiedPat.accountId,
                    principalId: verifiedPat.principalId,
                    credentialId: verifiedPat.credentialId,
                    authority: verifiedPat.authority,
                    expiresAt: verifiedPat.expiresAt,
                    grant: verifiedPat.grant,
                    parentTokenId: verifiedPat.parentTokenId,
                    embedConfig: verifiedPat.embedConfig,
                    ...(verifiedPat.authenticationEvidence ? { authenticationEvidence: verifiedPat.authenticationEvidence } : {}),
                },
                ...(verifiedPat.authenticationEvidence ? { authenticationEvidence: verifiedPat.authenticationEvidence } : {}),
            };
        }

        let decoded: DecodedAuthToken | null | undefined = this.tokenCache?.get(token);
        if (decoded?.legacy && !options.allowLegacyHome) {
            return null;
        }
        if (!decoded) {
            try {
                const verified = await this.tokens.verifier.verify(token);
                decoded = this.decodeAuthToken(verified, options);
            } catch {
                log({ module: "auth", level: "error" }, "Token verification failed");
                return null;
            }
            if (!decoded) {
                return null;
            }
            // The cache retains only data that passed cryptographic verification.
            this.tokenCache?.set(token, decoded);
        }

        // Account and bound App Machine revocation are consumed at this request boundary, including cache hits.
        const currentCredential = await inTx(
            async tx => {
                const current = await this.readCurrentSignedCredentialAccount(tx, decoded.userId, decoded.tokenEpoch);
                if (!current) return null;
                if (decoded.provenance.kind !== 'terminal') return {};
                const terminalCredential = await readCurrentDeploymentAppTerminalCredentialInTx(tx, decoded.extras, decoded.userId);
                return terminalCredential ? { terminalCredential } : null;
            },
            { readOnly: true, singleStatementRead: decoded.provenance.kind !== 'terminal' },
        );
        if (!currentCredential) {
            return decoded.provenance.kind === "ephemeral_session_runner"
                ? REJECTED_EPHEMERAL_SESSION_RUNNER_CREDENTIAL
                : null;
        }

        const ephemeralSessionRunnerPrincipal = decoded.provenance.kind === "ephemeral_session_runner"
            ? await verifyCurrentEphemeralSessionRunnerPrincipal(decoded.userId, decoded.extras)
            : undefined;
        if (decoded.provenance.kind === "ephemeral_session_runner" && !ephemeralSessionRunnerPrincipal) {
            return REJECTED_EPHEMERAL_SESSION_RUNNER_CREDENTIAL;
        }

        return {
            userId: decoded.userId,
            ...currentCredential,
            tokenEpoch: decoded.tokenEpoch,
            extras: decoded.extras,
            authTokenKind: decoded.provenance.kind,
            authTokenMintedAuthority: decoded.provenance.authority,
            authority: effectiveCredentialAuthority({
                credentialKind: decoded.provenance.kind,
                mintedAuthority: decoded.provenance.authority,
            }),
            ...(decoded.provenance.v === 2 ? { authenticationEvidence: decoded.provenance.evidence } : {}),
            ...(ephemeralSessionRunnerPrincipal ? { ephemeralSessionRunnerPrincipal } : {}),
            legacy: decoded.legacy,
        };
    }

    /** Same Account revocation owner for a bearer and its signed broker authority. */
    async isSignedCredentialCurrent(
        reader: Pick<Tx, 'account'>,
        accountId: string,
        tokenEpoch: number | undefined,
    ): Promise<boolean> {
        return await this.readCurrentSignedCredentialAccount(reader, accountId, tokenEpoch) !== null;
    }

    /** Consumes the same credential projection when a caller joins its job read. */
    isSignedCredentialAccountCurrent(
        account: Readonly<{ tokenEpoch: number; status: string }> | null,
        tokenEpoch: number | undefined,
    ): boolean {
        return account !== null && tokenEpoch !== undefined
            && isActiveHomeAccountStatus(account.status) && account.tokenEpoch === tokenEpoch;
    }

    private async readCurrentSignedCredentialAccount(
        reader: Pick<Tx, 'account'>,
        accountId: string,
        tokenEpoch: number | undefined,
    ) {
        if (tokenEpoch === undefined) return null;
        const account = await reader.account.findUnique({
            where: { id: accountId },
            select: { tokenEpoch: true, status: true },
        });
        return this.isSignedCredentialAccountCurrent(account, tokenEpoch) ? account : null;
    }

    /** Verifies the fixed PAT format through its independent credential-row lifecycle. */
    async verifyPat(token: string, signal?: AbortSignal): Promise<VerifyPatResult> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        signal?.throwIfAborted();

        const parsed = parseAccountApiTokenBearerV1(token);
        if (!parsed) {
            return { ok: false, reason: "invalid_token" };
        }

        const verified = await this.verifyParsedApiToken(parsed, signal);
        if (!verified) {
            return { ok: false, reason: "invalid_token" };
        }
        return {
            ok: true,
            accountId: verified.accountId,
            principalId: verified.accountId,
            credentialId: verified.credentialId,
            expiresAt: verified.expiresAt,
            authority: "account_automation",
            grant: verified.grant,
            parentTokenId: verified.parentTokenId,
            embedConfig: verified.embedConfig,
            ...(verified.authenticationEvidence ? { authenticationEvidence: verified.authenticationEvidence } : {}),
        };
    }

    /**
     * The signed external-Action capability selects one already-authenticated
     * PAT by immutable ids. This reader re-checks currentness from the same database row
     * owner as bearer verification without accepting or reconstructing its secret.
     */
    async verifyCurrentApiTokenPrincipal(
        principal: Readonly<{ accountId: string; principalId: string; credentialId: string }>,
        signal?: AbortSignal,
        reader: Pick<Tx, "accountApiToken"> = db,
    ): Promise<VerifiedApiTokenPrincipal | null> {
        signal?.throwIfAborted();
        if (principal.accountId !== principal.principalId) return null;
        const row = await reader.accountApiToken.findFirst({
            where: { id: principal.credentialId, accountId: principal.accountId },
            select: API_TOKEN_CURRENT_FIELDS,
        });
        const verified = await this.verifyCurrentApiTokenRow(row, signal, reader);
        return verified
            ? {
                accountId: verified.accountId,
                principalId: verified.accountId,
                credentialId: verified.credentialId,
                authority: "account_automation",
                expiresAt: verified.expiresAt,
                grant: verified.grant,
                parentTokenId: verified.parentTokenId,
                embedConfig: verified.embedConfig,
                ...(verified.authenticationEvidence
                    ? { authenticationEvidence: verified.authenticationEvidence }
                    : {}),
            }
            : null;
    }

    async signOutEverywhere(userId: string): Promise<number> {
        return inTx((tx) => this.signOutEverywhereInTx(tx, userId));
    }

    async signOutEverywhereInTx(tx: Tx, userId: string): Promise<number> {
        await acquireAccountSessionOwnerMetadataFenceInTx(tx, userId, "exclusive");
        // This owner invalidates signed sessions only. API tokens are explicit
        // long-lived automation credentials and retain their separate
        // revoke-one/revoke-all lifecycle.
        const account = await tx.account.update({
            where: { id: userId },
            data: { tokenEpoch: { increment: 1 } },
            select: { tokenEpoch: true },
        });
        return account.tokenEpoch;
    }

    /** Lifecycle retirement composes both credential owners without opening a nested transaction. */
    async revokeAllAccountCredentialsInTx(tx: Tx, accountId: string): Promise<void> {
        await this.signOutEverywhereInTx(tx, accountId);
        await this.revokeAllApiTokensInTx(tx, accountId);
    }

    private async verifyParsedApiToken(
        parsed: ParsedAccountApiTokenBearerV1,
        signal?: AbortSignal,
    ): Promise<VerifiedApiToken | null> {
        signal?.throwIfAborted();
        const row = await db.accountApiToken.findUnique({
            where: { id: parsed.tokenId },
            select: {
                ...API_TOKEN_CURRENT_FIELDS,
                secretDigest: true,
            },
        });
        signal?.throwIfAborted();
        if (!row || !apiTokenSecretDigestMatches(row.secretDigest, parsed.secret)) {
            return null;
        }

        return this.verifyCurrentApiTokenRow(row, signal);
    }

    private async verifyCurrentApiTokenRow(
        row: CurrentApiTokenRow | null,
        signal?: AbortSignal,
        reader: Pick<Tx, "accountApiToken"> = db,
    ): Promise<VerifiedApiToken | null> {
        signal?.throwIfAborted();
        if (!row || !isActiveHomeAccountStatus(row.Account.status)) return null;
        const now = new Date();
        if (row.expiresAt && row.expiresAt <= now) {
            return null;
        }
        if (row.parentTokenId !== null && (row.expiresAt === null || !row.parent || row.parent.accountId !== row.accountId
            || row.parent.parentTokenId !== null || (row.parent.expiresAt && row.parent.expiresAt <= now))) return null;
        let grant: ApiTokenGrantV1;
        let embedConfig: EmbedConfigV1 | null;
        try {
            grant = readApiTokenGrant(row.accessGrant);
            embedConfig = readApiTokenEmbedConfig(row.parentTokenId === null ? row.embedConfig : row.parent?.embedConfig);
        } catch { return null; }

        await this.recordApiTokenLastUse({
            tokenId: row.id,
            lastUsedAt: row.lastUsedAt,
            now,
            reader,
        });
        signal?.throwIfAborted();
        const authenticationEvidence = parseAuthenticationEvidenceSnapshot(row.authenticationEvidence)?.evidence;
        return {
            accountId: row.accountId,
            credentialId: row.id,
            expiresAt: row.expiresAt,
            grant,
            parentTokenId: row.parentTokenId,
            embedConfig,
            ...(authenticationEvidence ? { authenticationEvidence } : {}),
        };
    }

    private async recordApiTokenLastUse(params: Readonly<{
        tokenId: string;
        lastUsedAt: Date | null;
        now: Date;
        reader: Pick<Tx, "accountApiToken">;
    }>): Promise<void> {
        const threshold = new Date(params.now.getTime() - API_TOKEN_LAST_USED_UPDATE_INTERVAL_MS);
        if (params.lastUsedAt && params.lastUsedAt > threshold) {
            return;
        }

        try {
            await params.reader.accountApiToken.updateMany({
                where: {
                    id: params.tokenId,
                    OR: [
                        { lastUsedAt: null },
                        { lastUsedAt: { lte: threshold } },
                    ],
                },
                data: { lastUsedAt: params.now },
            });
        } catch {
            // Activity metadata must not become an availability dependency for
            // an otherwise valid API token, and this path never logs a bearer.
            log({ module: "auth", level: "warn" }, "API token last-used update failed");
        }
    }

    private decodeAuthToken(
        verified: unknown,
        options: Readonly<{ allowLegacyHome: boolean }>,
    ): DecodedAuthToken | null {
        if (typeof verified !== "object" || verified === null || Array.isArray(verified)) {
            return null;
        }

        const payload = verified as Readonly<Record<string, unknown>>;
        const userCandidate = payload.user ?? payload.userId;
        const userId = typeof userCandidate === "string" ? userCandidate.trim() : "";
        if (!userId) {
            return null;
        }

        const tokenExtras = this.asTokenExtras(payload.extras) ?? {};

        const decodedProvenance = readAuthTokenProvenance(payload, options);
        if (!decodedProvenance) return null;
        const { provenance, legacy } = decodedProvenance;

        const rawTokenEpoch = payload.tokenEpoch ?? tokenExtras.tokenEpoch;
        if (rawTokenEpoch === undefined && !legacy) {
            return null;
        }
        const tokenEpoch = rawTokenEpoch === undefined ? 0 : rawTokenEpoch;
        if (
            typeof tokenEpoch !== "number"
            || !Number.isSafeInteger(tokenEpoch)
            || tokenEpoch < 0
        ) {
            return null;
        }

        return {
            userId,
            extras: this.withoutProvenance(
                this.withoutTokenEpoch(tokenExtras),
                legacy,
            ),
            tokenEpoch,
            provenance,
            legacy,
        };
    }

    private asTokenExtras(value: unknown): Readonly<Record<string, unknown>> | null {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return null;
        }
        return value as Readonly<Record<string, unknown>>;
    }

    private withoutTokenEpoch(extras: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
        const { tokenEpoch: _tokenEpoch, ...publicExtras } = extras;
        return publicExtras;
    }

    private withoutProvenance(
        extras: Readonly<Record<string, unknown>>,
        legacy: boolean,
    ): Readonly<Record<string, unknown>> {
        if (legacy) return extras;
        const { provenance: _provenance, ...publicExtras } = extras;
        return publicExtras;
    }
    
    getCacheStats(): { size: number; oldestEntry: number | null } {
        if (!this.tokenCache || this.tokenCache.size === 0) {
            return { size: 0, oldestEntry: null };
        }

        return {
            size: this.tokenCache.size,
            oldestEntry: this.tokenCache.peekOldestAccessedAt()
        };
    }
    
    async createOauthStateToken(payload: OAuthStatePayload): Promise<string> {
        if (!this.tokens) {
            throw new Error("Auth module not initialized");
        }
        const oauthStateTokens = await this.getOauthStateTokens();

        const provider = payload.provider?.toString().trim().toLowerCase() ?? "";
        if (!provider) {
            throw new Error("Invalid OAuth provider");
        }

        const flow = payload.flow;
        if (flow !== "auth" && flow !== "connect") {
            throw new Error(`Invalid OAuth flow: ${String(flow)}`);
        }
        const sid = payload.sid?.toString().trim() || null;
        const userId = payload.userId?.toString().trim() || null;
        const publicKey = payload.publicKey?.toString().trim() || null;
        const proofHash = payload.proofHash?.toString().trim() || null;
        const purposeRaw = payload.purpose ?? null;
        if (
            purposeRaw !== null
            && purposeRaw !== "account_encryption_first_key"
            && purposeRaw !== "account_password_enrollment"
            && purposeRaw !== "account_directory"
            && purposeRaw !== "team_admission"
            && purposeRaw !== "github_app_installation_verification"
            && purposeRaw !== "github_app_manifest_setup"
            && purposeRaw !== "supporter_github"
            && purposeRaw !== "supporter_discord"
        ) {
            // The purpose union is closed and server-controlled. An unknown
            // purpose must never silently downgrade to an ordinary full-auth
            // state.
            throw new Error("Invalid OAuth purpose");
        }
        const purpose = purposeRaw;
        const endpointUrl = payload.endpointUrl?.toString().trim() || null;
        const endpointServerIdentityId =
            payload.endpointServerIdentityId?.toString().trim() || null;
        const canonicalServerUrl =
            payload.canonicalServerUrl?.toString().trim() || null;
        const requestDigestCandidate =
            (purpose === "account_password_enrollment"
                ? PasswordCredentialMutationDigestV1Schema
                : AccountEncryptionMigrateExternalAuthBindingDigestV1Schema)
                .safeParse(
                    payload.requestDigest
                        ?.toString()
                        .trim(),
                );
        const requestDigest =
            requestDigestCandidate.success
                ? requestDigestCandidate.data
                : null;
        if (
            (purpose === "account_encryption_first_key" || purpose === "account_password_enrollment")
            && (
                flow !== "auth"
                || !userId
                || !proofHash
                || !requestDigest
                || publicKey !== null
                || endpointUrl !== null
                || endpointServerIdentityId !== null
                || canonicalServerUrl !== null
            )
        ) {
            throw new Error("Invalid OAuth first-key step-up binding");
        }
        if (
            purpose === "account_directory"
            && (
                flow !== "auth"
                || userId !== null
                || !endpointUrl
                || !endpointServerIdentityId
                || !canonicalServerUrl
                || requestDigest !== null
                || ((publicKey === null) === (proofHash === null))
            )
        ) {
            throw new Error("Invalid OAuth account-directory binding");
        }
        if (
            purpose === "team_admission"
            && (
                flow !== "auth"
                || userId !== null
                || requestDigest !== null
                || endpointUrl !== null
                || endpointServerIdentityId !== null
                || canonicalServerUrl !== null
                || ((publicKey === null) === (proofHash === null))
            )
        ) {
            throw new Error("Invalid OAuth Team-admission binding");
        }
        if (
            (purpose === "github_app_installation_verification" || purpose === "github_app_manifest_setup")
            && (
                flow !== "connect"
                || !userId
                || publicKey !== null
                || proofHash !== null
                || requestDigest !== null
                || endpointUrl !== null
                || endpointServerIdentityId !== null
                || canonicalServerUrl !== null
            )
        ) {
            throw new Error("Invalid GitHub App setup binding");
        }
        if ((purpose === "supporter_github" || purpose === "supporter_discord") && (
            flow !== "connect" || provider !== (purpose === "supporter_github" ? "github" : "discord") || !sid || userId !== null
            || publicKey !== null || proofHash !== null || requestDigest !== null
            || endpointUrl !== null || endpointServerIdentityId !== null || canonicalServerUrl !== null
        )) throw new Error("Invalid supporter link binding");
        if (
            purpose === null
            && (endpointUrl !== null || endpointServerIdentityId !== null || canonicalServerUrl !== null)
        ) {
            // Endpoint binding fields only travel with the directory purpose.
            throw new Error("Invalid OAuth endpoint binding");
        }

        return await oauthStateTokens.oauthStateGenerator.new({
            user: "oauth-state",
            extras: {
                provider,
                flow,
                sid,
                userId,
                publicKey,
                proofHash,
                purpose,
                requestDigest,
                endpointUrl,
                endpointServerIdentityId,
                canonicalServerUrl,
            },
        });
    }

    async verifyOauthStateToken(token: string): Promise<{
        flow: "connect" | "auth";
        provider: string;
        sid: string | null;
        userId: string | null;
        publicKey: string | null;
        proofHash: string | null;
        purpose?: OAuthStatePurpose;
        requestDigest?: string;
        endpointUrl?: string;
        endpointServerIdentityId?: string;
        canonicalServerUrl?: string;
    } | null> {
        if (!this.tokens) {
            throw new Error("Auth module not initialized");
        }

        try {
            const oauthStateTokens = await this.getOauthStateTokens();
            const verified: any = await oauthStateTokens.oauthStateVerifier.verify(token);
            if (!verified) {
                return null;
            }

            if (verified.user !== "oauth-state") return null;
            const extras = verified.extras ?? {};
            const provider = typeof extras.provider === "string" ? extras.provider.trim().toLowerCase() : "";
            const flow = extras.flow === "auth" ? "auth" : extras.flow === "connect" ? "connect" : null;
            if (!provider || !flow) return null;
            const purposeRaw =
                typeof extras.purpose === "string" && extras.purpose.trim()
                    ? extras.purpose
                    : null;
            if (
                purposeRaw !== null
                && purposeRaw !== "account_encryption_first_key"
                && purposeRaw !== "account_password_enrollment"
                && purposeRaw !== "account_directory"
                && purposeRaw !== "team_admission"
                && purposeRaw !== "github_app_installation_verification"
                && purposeRaw !== "github_app_manifest_setup"
                && purposeRaw !== "supporter_github"
                && purposeRaw !== "supporter_discord"
            ) {
                // Unknown/future purpose markers fail closed instead of
                // degrading the continuation into an ordinary full-auth state.
                return null;
            }
            const purpose = purposeRaw;
            const endpointUrl =
                typeof extras.endpointUrl === "string" && extras.endpointUrl.trim()
                    ? extras.endpointUrl.trim()
                    : null;
            const endpointServerIdentityId =
                typeof extras.endpointServerIdentityId === "string" && extras.endpointServerIdentityId.trim()
                    ? extras.endpointServerIdentityId.trim()
                    : null;
            const canonicalServerUrl =
                typeof extras.canonicalServerUrl === "string" && extras.canonicalServerUrl.trim()
                    ? extras.canonicalServerUrl.trim()
                    : null;
            const userId =
                typeof extras.userId === "string" && extras.userId.trim()
                    ? extras.userId.trim()
                    : null;
            const publicKey =
                typeof extras.publicKey === "string" && extras.publicKey.trim()
                    ? extras.publicKey.trim()
                    : null;
            const proofHash =
                typeof extras.proofHash === "string" && extras.proofHash.trim()
                    ? extras.proofHash.trim()
                    : null;
            const requestDigestCandidate =
                (purpose === "account_password_enrollment"
                    ? PasswordCredentialMutationDigestV1Schema
                    : AccountEncryptionMigrateExternalAuthBindingDigestV1Schema)
                    .safeParse(
                        typeof extras.requestDigest
                            === "string"
                            ? extras.requestDigest.trim()
                            : null,
                    );
            const requestDigest =
                requestDigestCandidate.success
                    ? requestDigestCandidate.data
                    : null;
            if (
                (purpose === "account_encryption_first_key" || purpose === "account_password_enrollment")
                && (
                    flow !== "auth"
                    || !userId
                    || !proofHash
                    || !requestDigest
                    || publicKey !== null
                    || endpointUrl !== null
                    || endpointServerIdentityId !== null
                    || canonicalServerUrl !== null
                )
            ) {
                return null;
            }
            if (
                purpose === "account_directory"
                && (
                    flow !== "auth"
                    || userId !== null
                    || !endpointUrl
                    || !endpointServerIdentityId
                    || !canonicalServerUrl
                    || requestDigest !== null
                    || ((publicKey === null) === (proofHash === null))
                )
            ) {
                return null;
            }
            if (
                purpose === "team_admission"
                && (
                    flow !== "auth"
                    || userId !== null
                    || requestDigest !== null
                    || endpointUrl !== null
                    || endpointServerIdentityId !== null
                    || canonicalServerUrl !== null
                    || ((publicKey === null) === (proofHash === null))
                )
            ) {
                return null;
            }
            if (
                (purpose === "github_app_installation_verification" || purpose === "github_app_manifest_setup")
                && (
                    flow !== "connect"
                    || !userId
                    || publicKey !== null
                    || proofHash !== null
                    || requestDigest !== null
                    || endpointUrl !== null
                    || endpointServerIdentityId !== null
                    || canonicalServerUrl !== null
                )
            ) {
                return null;
            }
            const sid = typeof extras.sid === "string" && extras.sid.trim() ? extras.sid.trim() : null;
            if ((purpose === "supporter_github" || purpose === "supporter_discord") && (
                flow !== "connect" || provider !== (purpose === "supporter_github" ? "github" : "discord") || !sid || userId !== null
                || publicKey !== null || proofHash !== null || requestDigest !== null
                || endpointUrl !== null || endpointServerIdentityId !== null || canonicalServerUrl !== null
            )) return null;
            if (
                purpose === null
                && (endpointUrl !== null || endpointServerIdentityId !== null || canonicalServerUrl !== null)
            ) {
                // Endpoint binding fields only travel with the directory purpose.
                return null;
            }

            return {
                flow,
                provider,
                sid,
                userId,
                publicKey,
                proofHash,
                ...(purpose ? { purpose } : {}),
                ...(purpose && requestDigest ? { requestDigest } : {}),
                ...(purpose === "account_directory" && endpointUrl
                    ? { endpointUrl }
                    : {}),
                ...(purpose === "account_directory" && endpointServerIdentityId
                    ? { endpointServerIdentityId }
                    : {}),
                ...(purpose === "account_directory" && canonicalServerUrl
                    ? { canonicalServerUrl }
                    : {}),
            };
        } catch (error) {
            if (isOAuthStateUnavailableError(error)) {
                return null;
            }
            // Avoid logging the raw token or verifier error payloads (which can include sensitive details).
            log({ module: "auth", level: "error" }, "OAuth state token verification failed");
            return null;
        }
    }

    // Cleanup old entries (optional - can be called periodically)
    cleanup(): void {
        this.tokenCache?.pruneExpired();

        const stats = this.getCacheStats();
        log({ module: 'auth' }, `Token cache size: ${stats.size} entries`);
    }
}

// Global instance
export const auth = new AuthModule();
