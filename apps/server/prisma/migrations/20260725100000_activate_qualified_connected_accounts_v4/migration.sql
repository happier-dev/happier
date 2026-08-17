-- Prepare the existing Connected Services rows for canonical qualified identity.
-- Every qualified column is nullable in this expand step. The activation migration
-- backfills them, proves collision freedom through the unique indexes below, and
-- only then makes the canonical identity columns required.

ALTER TABLE "ServiceAccountToken"
    ADD COLUMN "service_plugin_id" TEXT,
    ADD COLUMN "service_local_id" TEXT,
    ADD COLUMN "qualified_service_digest" TEXT,
    ADD COLUMN "connected_account_id" TEXT,
    ADD COLUMN "qualified_identity_digest" TEXT,
    ADD COLUMN "authentication_mode_id" TEXT,
    ADD COLUMN "configuration_revision" TEXT,
    ADD COLUMN "configuration_content" BYTEA;

ALTER TABLE "ServiceAccountToken"
    ADD CONSTRAINT "sat_configuration_sidecar_pair_check"
    CHECK (("configuration_revision" IS NULL) = ("configuration_content" IS NULL));

CREATE UNIQUE INDEX "sat_qualified_identity_key"
ON "ServiceAccountToken"("accountId", "qualified_identity_digest");

ALTER TABLE "ConnectedServiceAuthGroup"
    ADD COLUMN "service_plugin_id" TEXT,
    ADD COLUMN "service_local_id" TEXT,
    ADD COLUMN "qualified_service_digest" TEXT,
    ADD COLUMN "qualified_group_digest" TEXT,
    ADD COLUMN "active_connected_account_id" TEXT;

CREATE UNIQUE INDEX "csag_qualified_group_key"
ON "ConnectedServiceAuthGroup"("accountId", "qualified_group_digest");

ALTER TABLE "ConnectedServiceAuthGroupMember"
    ADD COLUMN "credential_id" TEXT,
    ADD COLUMN "qualified_service_digest" TEXT,
    ADD COLUMN "qualified_group_digest" TEXT,
    ADD COLUMN "qualified_identity_digest" TEXT;

CREATE UNIQUE INDEX "csagm_group_credential_key"
ON "ConnectedServiceAuthGroupMember"("groupDbId", "credential_id");

ALTER TABLE "ConnectedServiceUsageSource"
    ADD COLUMN "service_plugin_id" TEXT,
    ADD COLUMN "service_local_id" TEXT,
    ADD COLUMN "qualified_service_digest" TEXT,
    ADD COLUMN "connected_account_id" TEXT,
    ADD COLUMN "qualified_identity_digest" TEXT,
    ADD COLUMN "credential_id" TEXT;

-- The qualified projection was never a runtime owner. Its unique legacy and
-- qualified keys are retained through prepare as collision evidence only; no
-- credential, configuration, group, or usage writer reads it.


-- Activate exact qualified identity across credential, group, member, and usage
-- rows. PostgreSQL's built-in sha256 hashes the exact JSON.stringify byte form
-- used by the server identity codec. The frozen map combines five 0.2.1 services,
-- prospective Remote GitHub, and evolved-Dev Bitbucket compatibility.

CREATE TEMPORARY TABLE "_QualifiedLegacyServiceMap" (
    "serviceId" TEXT PRIMARY KEY, "pluginId" TEXT NOT NULL, "localId" TEXT NOT NULL,
    "serviceDigest" TEXT NOT NULL, "defaultModeId" TEXT NOT NULL,
    "oauthModeId" TEXT, "tokenModeId" TEXT
) ON COMMIT DROP;
INSERT INTO "_QualifiedLegacyServiceMap" VALUES
    ('openai-codex', 'happier.agent.codex', 'openai-codex', 'a8d53eff624b4a3b71570b0367fc4738a8ea4dc5f3018bbc501f281dad087bea', 'oauth', 'oauth', NULL),
    ('openai', 'happier.voice.openai', 'openai', 'ec3a0fd63cbee7f50c3e2977fc882d6183379e6392b5d51b3efa390cc53f7c9b', 'api-key', NULL, 'api-key'),
    ('anthropic', 'happier.agent.claude', 'anthropic', '749d2df955d1d61572285abffa1d2324101c1433c355946eba65bb121a63987a', 'api-key', NULL, 'api-key'),
    ('claude-subscription', 'happier.agent.claude', 'claude-subscription', '40a8a0ad2615b95f046a13632ac3d0aae5da32ef634dd11053ecad6e1884675e', 'setup-token', 'oauth', 'setup-token'),
    ('gemini', 'happier.agent.gemini', 'gemini-account', '38b3ec1a4e87b7ce2a5bd41838eb0e5155170df35d937709d8db4836442f9e23', 'api-key', 'legacy-oauth-unsupported', 'api-key'),
    ('github', 'happier.scm.forge.github', 'github-account', 'bafdd80f57f752d0867fef33b99a3750286f07a2c2dc4896c3b7f7bb7c707ebd', 'fine-grained-pat', NULL, 'fine-grained-pat'),
    ('bitbucket', 'happier.scm.forge.bitbucket', 'bitbucket-account', '4b276e5f5b66a036ede597b0926d7f7991772bfe891698b76fd7be0e52fa2616', 'manual', NULL, 'manual');

CREATE TEMPORARY TABLE "_QualifiedActivationGuard" (
    "violationRows" INTEGER NOT NULL CHECK ("violationRows" = 0)
) ON COMMIT DROP;
INSERT INTO "_QualifiedActivationGuard"
SELECT COUNT(*) FROM (
    SELECT credential."id"
    FROM "ServiceAccountToken" credential
    LEFT JOIN "_QualifiedLegacyServiceMap" mapping ON mapping."serviceId" = credential."vendor"
    WHERE mapping."serviceId" IS NULL OR credential."profileId" IS NULL
       OR (credential."metadata"->>'kind' IS NOT NULL AND credential."metadata"->>'kind' NOT IN ('oauth','token'))
       OR (credential."metadata"->>'kind' = 'oauth' AND mapping."oauthModeId" IS NULL)
       OR (credential."metadata"->>'kind' = 'token' AND mapping."tokenModeId" IS NULL)
       OR (credential."service_plugin_id" IS NOT NULL AND credential."service_plugin_id" <> mapping."pluginId")
       OR (credential."service_local_id" IS NOT NULL AND credential."service_local_id" <> mapping."localId")
       OR (credential."qualified_service_digest" IS NOT NULL AND credential."qualified_service_digest" <> mapping."serviceDigest")
       OR (credential."connected_account_id" IS NOT NULL AND credential."connected_account_id" <> credential."profileId")
       OR (
            credential."qualified_identity_digest" IS NOT NULL
            AND credential."qualified_identity_digest" <> encode(sha256(convert_to(
                '["account",' || to_json(mapping."pluginId")::text || ',' ||
                to_json(mapping."localId")::text || ',' || to_json(credential."profileId")::text || ']',
                'UTF8'
            )), 'hex')
       )
       OR (
            credential."authentication_mode_id" IS NOT NULL
            AND credential."authentication_mode_id" <> CASE credential."metadata"->>'kind'
                WHEN 'oauth' THEN mapping."oauthModeId"
                WHEN 'token' THEN mapping."tokenModeId"
                ELSE mapping."defaultModeId"
            END
       )
    UNION ALL
    SELECT auth_group."id"
    FROM "ConnectedServiceAuthGroup" auth_group
    LEFT JOIN "_QualifiedLegacyServiceMap" mapping ON mapping."serviceId" = auth_group."vendor"
    WHERE mapping."serviceId" IS NULL OR auth_group."groupId" IS NULL
       OR (auth_group."service_plugin_id" IS NOT NULL AND auth_group."service_plugin_id" <> mapping."pluginId")
       OR (auth_group."service_local_id" IS NOT NULL AND auth_group."service_local_id" <> mapping."localId")
       OR (auth_group."qualified_service_digest" IS NOT NULL AND auth_group."qualified_service_digest" <> mapping."serviceDigest")
       OR (
            auth_group."qualified_group_digest" IS NOT NULL
            AND auth_group."qualified_group_digest" <> encode(sha256(convert_to(
                '["group",' || to_json(mapping."pluginId")::text || ',' ||
                to_json(mapping."localId")::text || ',' || to_json(auth_group."groupId")::text || ']',
                'UTF8'
            )), 'hex')
       )
       OR (
            auth_group."active_connected_account_id" IS NOT NULL
            AND auth_group."active_connected_account_id" IS DISTINCT FROM auth_group."activeProfileId"
       )
       OR (
            auth_group."activeProfileId" IS NOT NULL
            AND NOT EXISTS (
                SELECT 1
                FROM "ConnectedServiceAuthGroupMember" active_member
                WHERE active_member."groupDbId" = auth_group."id"
                  AND active_member."accountId" = auth_group."accountId"
                  AND active_member."vendor" = auth_group."vendor"
                  AND active_member."groupId" = auth_group."groupId"
                  AND active_member."profileId" = auth_group."activeProfileId"
            )
       )
    UNION ALL
    SELECT member."id"
    FROM "ConnectedServiceAuthGroupMember" member
    LEFT JOIN "ConnectedServiceAuthGroup" auth_group
      ON auth_group."id" = member."groupDbId" AND auth_group."accountId" = member."accountId"
     AND auth_group."vendor" = member."vendor" AND auth_group."groupId" = member."groupId"
    LEFT JOIN "ServiceAccountToken" credential
      ON credential."accountId" = member."accountId" AND credential."vendor" = member."vendor"
     AND credential."profileId" = member."profileId"
    LEFT JOIN "_QualifiedLegacyServiceMap" mapping ON mapping."serviceId" = credential."vendor"
    WHERE auth_group."id" IS NULL OR credential."id" IS NULL
       OR (member."credential_id" IS NOT NULL AND member."credential_id" <> credential."id")
       OR (member."qualified_service_digest" IS NOT NULL AND member."qualified_service_digest" IS DISTINCT FROM mapping."serviceDigest")
       OR (
            member."qualified_group_digest" IS NOT NULL
            AND member."qualified_group_digest" IS DISTINCT FROM encode(sha256(convert_to(
                '["group",' || to_json(mapping."pluginId")::text || ',' ||
                to_json(mapping."localId")::text || ',' || to_json(auth_group."groupId")::text || ']',
                'UTF8'
            )), 'hex')
       )
       OR (
            member."qualified_identity_digest" IS NOT NULL
            AND member."qualified_identity_digest" IS DISTINCT FROM encode(sha256(convert_to(
                '["account",' || to_json(mapping."pluginId")::text || ',' ||
                to_json(mapping."localId")::text || ',' || to_json(credential."profileId")::text || ']',
                'UTF8'
            )), 'hex')
       )
    UNION ALL
    SELECT source."id"
    FROM "ConnectedServiceUsageSource" source
    LEFT JOIN "ServiceAccountToken" credential
      ON credential."accountId" = source."accountId" AND credential."vendor" = source."serviceId"
     AND credential."profileId" = source."profileId"
    LEFT JOIN "_QualifiedLegacyServiceMap" mapping ON mapping."serviceId" = credential."vendor"
    WHERE credential."id" IS NULL
       OR (source."service_plugin_id" IS NOT NULL AND source."service_plugin_id" IS DISTINCT FROM mapping."pluginId")
       OR (source."service_local_id" IS NOT NULL AND source."service_local_id" IS DISTINCT FROM mapping."localId")
       OR (source."qualified_service_digest" IS NOT NULL AND source."qualified_service_digest" IS DISTINCT FROM mapping."serviceDigest")
       OR (source."connected_account_id" IS NOT NULL AND source."connected_account_id" IS DISTINCT FROM credential."profileId")
       OR (
            source."qualified_identity_digest" IS NOT NULL
            AND source."qualified_identity_digest" IS DISTINCT FROM encode(sha256(convert_to(
                '["account",' || to_json(mapping."pluginId")::text || ',' ||
                to_json(mapping."localId")::text || ',' || to_json(credential."profileId")::text || ']',
                'UTF8'
            )), 'hex')
       )
       OR (source."credential_id" IS NOT NULL AND source."credential_id" <> credential."id")
    UNION ALL
    SELECT MIN(credential."id")
    FROM "ServiceAccountToken" credential
    JOIN "_QualifiedLegacyServiceMap" mapping ON mapping."serviceId" = credential."vendor"
    GROUP BY credential."accountId", encode(sha256(convert_to(
        '["account",' || to_json(mapping."pluginId")::text || ',' ||
        to_json(mapping."localId")::text || ',' || to_json(credential."profileId")::text || ']',
        'UTF8'
    )), 'hex')
    HAVING COUNT(*) > 1
    UNION ALL
    SELECT MIN(auth_group."id")
    FROM "ConnectedServiceAuthGroup" auth_group
    JOIN "_QualifiedLegacyServiceMap" mapping ON mapping."serviceId" = auth_group."vendor"
    GROUP BY auth_group."accountId", encode(sha256(convert_to(
        '["group",' || to_json(mapping."pluginId")::text || ',' ||
        to_json(mapping."localId")::text || ',' || to_json(auth_group."groupId")::text || ']',
        'UTF8'
    )), 'hex')
    HAVING COUNT(*) > 1
) violations;

UPDATE "ServiceAccountToken" credential SET
    "service_plugin_id" = mapping."pluginId",
    "service_local_id" = mapping."localId",
    "qualified_service_digest" = mapping."serviceDigest",
    "connected_account_id" = credential."profileId",
    "qualified_identity_digest" = encode(sha256(convert_to(
        '["account",' || to_json(mapping."pluginId")::text || ',' ||
        to_json(mapping."localId")::text || ',' || to_json(credential."profileId")::text || ']',
        'UTF8'
    )), 'hex'),
    "authentication_mode_id" = CASE credential."metadata"->>'kind'
        WHEN 'oauth' THEN mapping."oauthModeId"
        WHEN 'token' THEN mapping."tokenModeId"
        ELSE mapping."defaultModeId"
    END
FROM "_QualifiedLegacyServiceMap" mapping
WHERE mapping."serviceId" = credential."vendor";

UPDATE "ConnectedServiceAuthGroup" auth_group SET
    "service_plugin_id" = mapping."pluginId",
    "service_local_id" = mapping."localId",
    "qualified_service_digest" = mapping."serviceDigest",
    "qualified_group_digest" = encode(sha256(convert_to(
        '["group",' || to_json(mapping."pluginId")::text || ',' ||
        to_json(mapping."localId")::text || ',' || to_json(auth_group."groupId")::text || ']',
        'UTF8'
    )), 'hex'),
    "active_connected_account_id" = auth_group."activeProfileId"
FROM "_QualifiedLegacyServiceMap" mapping
WHERE mapping."serviceId" = auth_group."vendor";

UPDATE "ConnectedServiceAuthGroupMember" member SET
    "credential_id" = credential."id",
    "qualified_service_digest" = credential."qualified_service_digest",
    "qualified_group_digest" = auth_group."qualified_group_digest",
    "qualified_identity_digest" = credential."qualified_identity_digest"
FROM "ConnectedServiceAuthGroup" auth_group, "ServiceAccountToken" credential
WHERE auth_group."id" = member."groupDbId"
  AND credential."accountId" = member."accountId"
  AND credential."vendor" = member."vendor"
  AND credential."profileId" = member."profileId";

UPDATE "ConnectedServiceUsageSource" source SET
    "service_plugin_id" = credential."service_plugin_id",
    "service_local_id" = credential."service_local_id",
    "qualified_service_digest" = credential."qualified_service_digest",
    "connected_account_id" = credential."connected_account_id",
    "qualified_identity_digest" = credential."qualified_identity_digest",
    "credential_id" = credential."id"
FROM "ServiceAccountToken" credential
WHERE credential."accountId" = source."accountId"
  AND credential."vendor" = source."serviceId"
  AND credential."profileId" = source."profileId";

ALTER TABLE "ServiceAccountToken"
  ALTER COLUMN "vendor" DROP NOT NULL,
  ALTER COLUMN "profileId" DROP DEFAULT,
  ALTER COLUMN "profileId" DROP NOT NULL,
  ALTER COLUMN "service_plugin_id" SET NOT NULL,
  ALTER COLUMN "service_local_id" SET NOT NULL,
  ALTER COLUMN "qualified_service_digest" SET NOT NULL,
  ALTER COLUMN "connected_account_id" SET NOT NULL,
  ALTER COLUMN "qualified_identity_digest" SET NOT NULL,
  ALTER COLUMN "authentication_mode_id" SET NOT NULL;
CREATE UNIQUE INDEX "sat_qualified_credential_fkey" ON "ServiceAccountToken"("accountId","qualified_service_digest","qualified_identity_digest","id");

ALTER TABLE "ConnectedServiceAuthGroup"
  ALTER COLUMN "vendor" DROP NOT NULL,
  ALTER COLUMN "service_plugin_id" SET NOT NULL,
  ALTER COLUMN "service_local_id" SET NOT NULL,
  ALTER COLUMN "qualified_service_digest" SET NOT NULL,
  ALTER COLUMN "qualified_group_digest" SET NOT NULL;
CREATE UNIQUE INDEX "csag_qualified_group_fkey" ON "ConnectedServiceAuthGroup"("accountId","qualified_service_digest","qualified_group_digest","id");

ALTER TABLE "ConnectedServiceAuthGroupMember"
  DROP CONSTRAINT "ConnectedServiceAuthGroupMember_groupDbId_fkey",
  DROP CONSTRAINT "ConnectedServiceAuthGroupMember_accountId_vendor_profileId_fkey",
  ALTER COLUMN "vendor" DROP NOT NULL,
  ALTER COLUMN "groupId" DROP NOT NULL,
  ALTER COLUMN "profileId" DROP NOT NULL,
  ALTER COLUMN "credential_id" SET NOT NULL,
  ALTER COLUMN "qualified_service_digest" SET NOT NULL,
  ALTER COLUMN "qualified_group_digest" SET NOT NULL,
  ALTER COLUMN "qualified_identity_digest" SET NOT NULL,
  ADD CONSTRAINT "csagm_group_fkey" FOREIGN KEY ("accountId","qualified_service_digest","qualified_group_digest","groupDbId")
    REFERENCES "ConnectedServiceAuthGroup"("accountId","qualified_service_digest","qualified_group_digest","id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "csagm_credential_fkey" FOREIGN KEY ("accountId","qualified_service_digest","qualified_identity_digest","credential_id")
    REFERENCES "ServiceAccountToken"("accountId","qualified_service_digest","qualified_identity_digest","id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX "ConnectedServiceAuthGroupMember_accountId_vendor_profileId_idx";
CREATE INDEX "ConnectedServiceAuthGroupMember_credential_id_idx"
  ON "ConnectedServiceAuthGroupMember"("credential_id");

ALTER TABLE "ConnectedServiceUsageSource"
  ALTER COLUMN "serviceId" DROP NOT NULL,
  ALTER COLUMN "profileId" DROP NOT NULL,
  ALTER COLUMN "service_plugin_id" SET NOT NULL,
  ALTER COLUMN "service_local_id" SET NOT NULL,
  ALTER COLUMN "qualified_service_digest" SET NOT NULL,
  ALTER COLUMN "connected_account_id" SET NOT NULL,
  ALTER COLUMN "qualified_identity_digest" SET NOT NULL,
  ALTER COLUMN "credential_id" SET NOT NULL,
  ADD CONSTRAINT "csus_credential_fkey" FOREIGN KEY ("accountId","qualified_service_digest","qualified_identity_digest","credential_id")
    REFERENCES "ServiceAccountToken"("accountId","qualified_service_digest","qualified_identity_digest","id") ON DELETE CASCADE ON UPDATE CASCADE;
