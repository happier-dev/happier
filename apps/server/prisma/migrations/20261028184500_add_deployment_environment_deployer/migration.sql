-- Chosen deployers retain references only; current Source/Team admission supplies authority.
CREATE TABLE "DeploymentEnvironmentDeployer" (
    "environmentId" TEXT NOT NULL,
    "principalKind" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeploymentEnvironmentDeployer_values_check" CHECK ("principalKind" IN ('account', 'teamGroup')),
    PRIMARY KEY ("environmentId", "principalKind", "principalId"),
    CONSTRAINT "DeploymentEnvironmentDeployer_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "DeploymentEnvironment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeploymentEnvironmentDeployer_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
