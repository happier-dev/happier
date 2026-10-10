/**
 * Happier-maintained provider facts used by bundled first-party plugins.
 *
 * This path publishes data and policy projections only. Generic Connected
 * Account author capability remains owned by `../../connected-accounts`.
 */
export {
    ANTIGRAVITY_OAUTH_PROFILE,
    CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1,
    CLAUDE_SUBSCRIPTION_OAUTH_PROFILE,
    CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1,
    CODEX_NATIVE_HOME,
    CODEX_CONNECTED_SERVICE_HOME_DIRECTORY_NAME,
    OPENAI_CODEX_OAUTH_PROFILE,
} from '../../connectedAccounts.js';
export type {
    ClaudeSubscriptionMaterializationContractV1,
    ClaudeSubscriptionSetupTokenEnvironmentRequestV1,
} from '../../connectedAccounts.js';
export {
    PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1,
    classifyProviderLimitEvidence,
} from '../../cloud/providerLimitEvidence.js';
export type {
    ProviderLimitCategory,
    ProviderLimitEvidenceClassification,
    ProviderLimitEvidenceConfidence,
    ProviderLimitEvidenceContext,
    ProviderLimitEvidenceProvenance,
} from '../../cloud/providerLimitEvidence.js';
