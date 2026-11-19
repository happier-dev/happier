/** Shared Session guidance for source preparation and building a suggested app. */
export const DEPLOYMENT_VALIDATION_RULES_V1 = [
    'Inspect the project\'s own scripts and run the applicable build and test scripts through projects.script.run. Commit the reviewable source changes before preview validation.',
    'Validate the exact PR head only after separate review: normal deployments.deploy into a non-production Environment/preview, or build/start/healthcheck in an admitted Dev Container child. Use normal isolation and exec paths. Do not call private Compose preflight or access host Docker.',
    'Record actual head SHA, validation method, operation/receipt and observed build/health result in the PR. Unavailable target, Docker or credentials means Validation unavailable; failed health is failed; a moved head invalidates earlier evidence. PR creation alone is Configuration proposed, never prepared, deployable, migrated or Live.',
    'For preview validation, deploy the exact reviewed revision to the selected non-production Environment with deployments.deploy. Follow deployments.receipts.get to completion, then read deployments.health.current for that Environment and target link. Return the preview URL and observed health for the person to review; an accepted deploy is not healthy evidence.',
    'Do not provision, bind secrets, merge, or deploy Production. After reviewed merge, refresh the exact Source revision and return to ordinary Publish/deploy review. Session and Forge own progress and PR state; no waiting-until-merge operation is needed.',
].join('\n\n');

/**
 * How the build Session makes its preview Environment (AUTO-LIVE p4: the agent read "preview" as purpose preview, which
 * belongs to a pull-request child of a template Environment, and sent no Project or definition). The example is the
 * Action's own input shape; a test parses it through the Action schema so this guidance cannot drift from it.
 */
const DEPLOY_BUILD_PREVIEW_CREATE_EXAMPLE_V1 = {
    serverId: 'SERVER_ID', requestKey: 'NEW_REQUEST_KEY', projectSourceId: 'PROJECT_SOURCE_ID', name: 'App preview',
    protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'MACHINE_ID',
    definition: { from: 'repository', ref: 'PUSHED_BRANCH',
        compose: { path: 'compose.yaml', profiles: [], services: ['web'], primaryService: 'web' } },
    firstTargetLink: { machines: [{ machineId: 'MACHINE_ID', installationId: 'MACHINE_INSTALLATION_ID' }] },
} as const;
/** Every build target: the preview Environment's kind. */
export const DEPLOY_BUILD_PREVIEW_RULES_V1 = 'Create the preview Environment with deployments.environments.create using protection nonProduction and purpose standard; purpose preview is only for a pull-request child of an existing template Environment. Take projectSourceId from projects.sources.list and use the branch you pushed. Read the Action\'s current schema before calling it.';
/** Own server only: it deploys the repository's Compose file from a Machine. */
export const DEPLOY_BUILD_PREVIEW_OWN_SERVER_RULES_V1 = [
    'Own server deploys the repository\'s Compose file: when the repository has none, add a compose.yaml whose web service serves the app with a healthcheck, then commit and push it before the preview. Take the Machine id and installationId from machines.list. The input has this shape:',
    '```json\n' + JSON.stringify(DEPLOY_BUILD_PREVIEW_CREATE_EXAMPLE_V1) + '\n```',
].join('\n\n');
