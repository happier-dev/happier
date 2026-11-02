ALTER TABLE "Automation" ADD COLUMN "deploymentPreviewRole" TEXT
    CONSTRAINT "Automation_deploymentPreviewRole_check"
    CHECK ("deploymentPreviewRole" IS NULL OR "deploymentPreviewRole" IN ('preview_admission', 'preview_cleanup'));

ALTER TABLE "DeploymentEnvironment" ADD COLUMN "previewTemplateEnvironmentId" TEXT
    CONSTRAINT "DeploymentEnvironment_previewTemplateEnvironmentId_fkey"
    REFERENCES "DeploymentEnvironment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "DeploymentEnvironment" ADD COLUMN "previewRepositoryId" TEXT
    CONSTRAINT "DeploymentEnvironment_previewRepositoryId_fkey"
    REFERENCES "ProjectSource"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "DeploymentEnvironment" ADD COLUMN "previewPullRequestId" TEXT;
ALTER TABLE "DeploymentEnvironment" ADD COLUMN "previewTargetLinkId" TEXT
    CONSTRAINT "DeploymentEnvironment_previewTargetLinkId_fkey"
    REFERENCES "DeploymentTargetLink"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
    CONSTRAINT "DeploymentEnvironment_preview_relation_check" CHECK (
        ("purpose" = 'standard' AND "previewTemplateEnvironmentId" IS NULL AND "previewRepositoryId" IS NULL
            AND "previewPullRequestId" IS NULL AND "previewTargetLinkId" IS NULL)
        OR ("purpose" = 'preview' AND "previewTemplateEnvironmentId" IS NOT NULL AND "previewRepositoryId" IS NOT NULL
            AND "previewPullRequestId" IS NOT NULL AND "previewTargetLinkId" IS NOT NULL)
    );
CREATE UNIQUE INDEX "DeploymentEnvironment_preview_live_key" ON "DeploymentEnvironment"
    ("previewTemplateEnvironmentId", "previewRepositoryId", "previewPullRequestId", "previewTargetLinkId")
    WHERE "purpose" = 'preview' AND "deletedAt" IS NULL;
