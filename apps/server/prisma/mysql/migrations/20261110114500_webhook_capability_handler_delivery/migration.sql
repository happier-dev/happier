-- preserve existing rows while admitting the canonical webhook verifier kinds.

ALTER TABLE `PluginWebhookRoute`
    DROP CHECK `PluginWebhookRoute_verifier_kind_check`,
    ADD CONSTRAINT `PluginWebhookRoute_verifier_kind_check`
        CHECK (`verifierKind` IN ('github_hmac_sha256_v1', 'sentry_hmac_sha256_v1', 'capabilityUrl_v1'));

ALTER TABLE `PluginWebhookDelivery`
    DROP CHECK `PluginWebhookDelivery_verifier_kind_check`,
    ADD CONSTRAINT `PluginWebhookDelivery_verifier_kind_check`
        CHECK (`verifierKind` IN ('github_hmac_sha256_v1', 'sentry_hmac_sha256_v1', 'capabilityUrl_v1'));

ALTER TABLE `PluginWebhookEndpointOperation`
    DROP CHECK `PluginWebhookEndpointOperation_operation_kind_check`,
    DROP CHECK `PluginWebhookEndpointOperation_result_kind_check`,
    DROP CHECK `PluginWebhookEndpointOperation_result_correspondence_check`,
    ADD CONSTRAINT `PluginWebhookEndpointOperation_operation_kind_check`
        CHECK (`operationKind` IN ('revoke', 'retarget', 'rotateUrl')),
    ADD CONSTRAINT `PluginWebhookEndpointOperation_result_kind_check`
        CHECK (`resultKind` IN ('revoked', 'alreadyRevoked', 'retargeted', 'alreadyRetargeted', 'rotated')),
    ADD CONSTRAINT `PluginWebhookEndpointOperation_result_correspondence_check`
        CHECK (
            (
                `operationKind` = 'revoke'
                AND `requestTargetMachineId` IS NULL
                AND `requestTargetMaterializationId` IS NULL
                AND `requestTargetPluginId` IS NULL
                AND `resultKind` IN ('revoked', 'alreadyRevoked')
                AND `resultPreviousTargetMachineId` IS NULL
                AND `resultPreviousTargetMaterializationId` IS NULL
                AND `resultPreviousTargetPluginId` IS NULL
                AND `resultTargetMachineId` IS NULL
                AND `resultTargetMaterializationId` IS NULL
                AND `resultTargetPluginId` IS NULL
            )
            OR
            (
                `operationKind` = 'retarget'
                AND `requestTargetMachineId` IS NOT NULL
                AND `requestTargetMaterializationId` IS NOT NULL
                AND `requestTargetPluginId` IS NOT NULL
                AND `resultKind` IN ('retargeted', 'alreadyRetargeted')
                AND `resultPreviousTargetMachineId` IS NOT NULL
                AND `resultPreviousTargetMaterializationId` IS NOT NULL
                AND `resultPreviousTargetPluginId` IS NOT NULL
                AND `resultTargetMachineId` IS NOT NULL
                AND `resultTargetMaterializationId` IS NOT NULL
                AND `resultTargetPluginId` IS NOT NULL
            )
            OR
            (
                `operationKind` = 'rotateUrl'
                AND `requestTargetMachineId` IS NULL
                AND `requestTargetMaterializationId` IS NULL
                AND `requestTargetPluginId` IS NULL
                AND `resultKind` = 'rotated'
                AND `resultPreviousTargetMachineId` IS NULL
                AND `resultPreviousTargetMaterializationId` IS NULL
                AND `resultPreviousTargetPluginId` IS NULL
                AND `resultTargetMachineId` IS NULL
                AND `resultTargetMaterializationId` IS NULL
                AND `resultTargetPluginId` IS NULL
            )
        );
