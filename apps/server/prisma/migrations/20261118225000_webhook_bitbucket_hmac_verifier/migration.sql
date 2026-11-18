-- preserve existing rows while admitting the canonical webhook verifier kinds.

ALTER TABLE "PluginWebhookRoute"
    DROP CONSTRAINT "PluginWebhookRoute_verifier_kind_check",
    ADD CONSTRAINT "PluginWebhookRoute_verifier_kind_check"
        CHECK ("verifierKind" IN ('github_hmac_sha256_v1', 'sentry_hmac_sha256_v1', 'capabilityUrl_v1', 'gitlab_token_v1', 'bitbucket_hmac_sha256_v1'));

ALTER TABLE "PluginWebhookDelivery"
    DROP CONSTRAINT "PluginWebhookDelivery_verifier_kind_check",
    ADD CONSTRAINT "PluginWebhookDelivery_verifier_kind_check"
        CHECK ("verifierKind" IN ('github_hmac_sha256_v1', 'sentry_hmac_sha256_v1', 'capabilityUrl_v1', 'gitlab_token_v1', 'bitbucket_hmac_sha256_v1'));
