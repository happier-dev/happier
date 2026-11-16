import { resolveVitestWorkers } from '../../scripts/testing/vitestWorkers';
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { resolveVitestFeatureTestExcludeGlobs } from "../../scripts/testing/featureTestGating";
import { serverWorkspacePackageSourcesPlugin } from './vitestWorkspacePackageResolution';
import { createTestHomeEnvironment } from '../../scripts/testing/testHomeEnvironment.mjs';
import { workspacePackageSourcesPlugin as cliWorkspacePackageSourcesPlugin } from '../cli/scripts/vitestWorkspacePackageResolution';
import { createWorkspaceHostSourceAlias } from '../../scripts/testing/vitestWorkspacePackageResolution';

const __dirname = dirname(fileURLToPath(import.meta.url));
const providerExcludeGlob = process.env.HAPPIER_DB_PROVIDER === 'mysql' ? '**/*.postgres.*' : '**/*.mysql.*';

export default defineConfig({
    test: {
        ...resolveVitestWorkers(),
        globals: true,
        environment: "node",
        setupFiles: [resolve(__dirname, '../../packages/tests/scripts/dbContractDatabase.mjs'), resolve(__dirname, '../../scripts/testing/vitestHomeSetup.mjs'), "./sources/configureZodLocale.ts"],
        sequence: { setupFiles: 'list' },
        include: [
            "sources/**/*.dbcontract.spec.ts",
            "scripts/**/*.dbcontract.spec.ts",
            "sources/app/api/routes/session/sessionRoutes.sessionTurns.recent.integration.spec.ts",
            "sources/app/deployments/environmentSecretGrantRepository.db.contract.test.ts",
            "sources/app/deployments/deploymentPromotion.sqlite.integration.spec.ts",
            "sources/app/deployments/environmentSecretLaunchAdmission.sqlite.integration.spec.ts",
            "sources/app/teams/credentials/resourceActivity.sqlite.integration.spec.ts",
            "sources/app/session/access/sessionAccessMembershipImpact.sqlite.integration.spec.ts",
            "sources/app/auth/providers/accountIdentityChange.sqlite.integration.spec.ts",
            resolve(__dirname, '../../packages/tests/suites/db-contract/**/*.dbcontract.spec.{ts,mjs}'),
            ...(process.env.HAPPIER_DB_PROVIDER === 'postgres' ? [
                'sources/app/automations/automationActionAdmission.composed.integration.spec.ts',
                'sources/app/automations/automationScheduleOccurrenceProjection.integration.spec.ts',
                'sources/app/automations/automationClaimService.integration.spec.ts',
                'sources/app/automations/automationScheduleTriggerFiring.feat.automations.integration.spec.ts',
                'sources/app/automations/automationReplyHandoffWorker.integration.spec.ts',
            ] : []),
        ],
        exclude: [
            ...resolveVitestFeatureTestExcludeGlobs(),
            providerExcludeGlob,
            resolve(__dirname, '../../packages/tests/suites/db-contract', providerExcludeGlob),
        ],
        isolate: true,
        testTimeout: 60_000,
        hookTimeout: 60_000,
        env: {
            ...createTestHomeEnvironment().env,
            HAPPIER_FEATURE_POLICY_ENV: "",
        },
    },
    // Cross-owner DB contracts exercise the real CLI consumer against server
    // routes. Resolve each importer's own alias without scanning Expo projects.
    resolve: { alias: [createWorkspaceHostSourceAlias(resolve(__dirname, '../..'), resolve(__dirname, './sources'))] },
    plugins: [serverWorkspacePackageSourcesPlugin, cliWorkspacePackageSourcesPlugin, tsconfigPaths({ projects: [
        resolve(__dirname, "./tsconfig.vitest.json"), resolve(__dirname, "../cli/tsconfig.json"),
    ] })],
});
