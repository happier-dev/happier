// @ts-check

/**
 * This module centralizes the release orchestrator decision logic so it can be reused
 * by local operators and GitHub workflows without duplicating conditional expressions.
 */

/**
 * @typedef {'dev'|'preview'|'production'} DeployEnvironment
 * @typedef {'ui'|'server'|'website'|'docs'|'cli'|'stack'|'server_runner'} DeployTarget
 * @typedef {'none'|'patch'|'minor'|'major'} Bump
 * @typedef {'none'|'ota'|'native'|'native_submit'} UiExpoAction
 * @typedef {'none'|'build_only'|'build_and_publish'} DesktopMode
 *
 * @typedef {{
 *   changed_ui: boolean;
 *   changed_cli: boolean;
 *   changed_server: boolean;
 *   changed_website: boolean;
 *   changed_docs: boolean;
 *   changed_shared: boolean;
 *   changed_stack: boolean;
 *   changed_cli_stack_shared?: boolean;
 * }} ChangedComponents
 *
 * @typedef {{
 *   bump_app: Bump;
 *   bump_cli: Bump;
 *   bump_stack: Bump;
 *   bump_server: Bump;
 *   bump_website: Bump;
 *   should_bump: boolean;
 *   publish_cli: boolean;
 *   publish_stack: boolean;
 *   publish_server: boolean;
 * }} BumpPlan
 *
 * @typedef {{
 *   deploy_ui: { needed: boolean };
 *   deploy_server: { needed: boolean };
 *   deploy_website: { needed: boolean };
 *   deploy_docs: { needed: boolean };
 * }} DeployPlan
 *
 * @typedef {{
 *   runBumpVersionsDev: boolean;
 *   runPromoteMain: boolean;
 *   runSyncDevFromMain: boolean;
 *   runDeployUi: boolean;
 *   runDeployServer: boolean;
 *   runDeployWebsite: boolean;
 *   runDeployDocs: boolean;
 *   runPublishServerRuntime: boolean;
 *   runPublishUiWeb: boolean;
 *   runPublishDocker: boolean;
 *   runPublishNpm: boolean;
 *   runPublishCliBinaries: boolean;
 *   runPublishHstackBinaries: boolean;
 *   dockerBuildRelay: boolean;
 *   dockerBuildDevBox: boolean;
 * }} ReleaseExecutionPlan
 */

/**
 * @param {DeployTarget[]} deployTargets
 * @param {DeployTarget} target
 */
function hasTarget(deployTargets, target) {
  return deployTargets.includes(target);
}

/**
 * Compute which jobs should run, mirroring `.github/workflows/release.yml` job `if:` conditions.
 *
 * Notes:
 * - This function is intentionally side-effect free; it only decides what to run.
 * - Hosted deploy branch promotion is only for preview/production; the public dev lane is publish-only.
 *
 * @param {{
 *   environment: DeployEnvironment;
 *   dryRun: boolean;
 *   forceDeploy: boolean;
 *   deployTargets: DeployTarget[];
 *   uiExpoAction: UiExpoAction;
 *   desktopMode: DesktopMode;
 *   changed: ChangedComponents;
 *   bumpPlan: BumpPlan;
 *   deployPlan?: DeployPlan | null;
 * }} input
 * @returns {ReleaseExecutionPlan}
 */
export function computeReleaseExecutionPlan(input) {
  const env = input.environment;
  const dryRun = input.dryRun;
  const forceDeploy = input.forceDeploy;
  const targets = input.deployTargets;
  const changed = input.changed;
  const bumpPlan = input.bumpPlan;
  const deployPlan = input.deployPlan ?? null;

  const hasUi = hasTarget(targets, 'ui');
  const hasServer = hasTarget(targets, 'server');
  const hasWebsite = hasTarget(targets, 'website');
  const hasDocs = hasTarget(targets, 'docs');
  const hasCli = hasTarget(targets, 'cli');
  const hasStack = hasTarget(targets, 'stack');
  const hasServerRunner = hasTarget(targets, 'server_runner');
  const supportsHostedDeploys = env === 'preview' || env === 'production';

  const runBumpVersionsDev = !dryRun && bumpPlan.should_bump === true;
  const runPromoteMain = !dryRun && env === 'production';
  const runSyncDevFromMain = !dryRun && env === 'production';

  // Deploy plan is computed only for enabled deploy branches.
  const deployUiNeeded = Boolean(deployPlan?.deploy_ui?.needed);
  const deployServerNeeded = Boolean(deployPlan?.deploy_server?.needed);
  const deployWebsiteNeeded = Boolean(deployPlan?.deploy_website?.needed);
  const deployDocsNeeded = Boolean(deployPlan?.deploy_docs?.needed);

  const uiExpoAction = input.uiExpoAction;
  const desktopMode = input.desktopMode;

  // Hosted UI/webhook deploys are disabled for the public dev lane; UI work there is publish/mobile/desktop only.
  const wantsUiWork =
    hasUi &&
    !dryRun &&
    (env === 'production'
      ? (deployUiNeeded || bumpPlan.bump_app !== 'none' || forceDeploy)
      : uiExpoAction !== 'none' || desktopMode !== 'none');

  const runDeployUi = supportsHostedDeploys && wantsUiWork;
  const runDeployServer = supportsHostedDeploys && hasServer && !dryRun && (deployServerNeeded || bumpPlan.bump_server !== 'none' || forceDeploy);
  const runDeployWebsite = supportsHostedDeploys && hasWebsite && !dryRun && (deployWebsiteNeeded || bumpPlan.bump_website !== 'none' || forceDeploy);
  const runDeployDocs = supportsHostedDeploys && hasDocs && !dryRun && (deployDocsNeeded || forceDeploy);

  const runPublishServerRuntime = !dryRun && hasServerRunner;
  const runPublishUiWeb = !dryRun && hasUi;

  const runPublishDocker =
    !dryRun &&
    (forceDeploy ||
      changed.changed_ui ||
      changed.changed_server ||
      changed.changed_cli ||
      changed.changed_stack ||
      changed.changed_cli_stack_shared ||
      changed.changed_shared);

  const dockerBuildRelay = forceDeploy || changed.changed_ui || changed.changed_server || changed.changed_shared;
  const dockerBuildDevBox =
    forceDeploy || changed.changed_cli || changed.changed_stack || changed.changed_cli_stack_shared || changed.changed_shared;

  // `release.yml` routes npm publishing through `release-npm.yml` when any publish_* is true.
  const runPublishNpm = !dryRun && (bumpPlan.publish_cli || bumpPlan.publish_stack || bumpPlan.publish_server);

  // Local parity: publishing CLI/stack via the release orchestrator also publishes their rolling GitHub releases.
  const runPublishCliBinaries = !dryRun && hasCli;
  const runPublishHstackBinaries = !dryRun && hasStack;

  return {
    runBumpVersionsDev,
    runPromoteMain,
    runSyncDevFromMain,
    runDeployUi,
    runDeployServer,
    runDeployWebsite,
    runDeployDocs,
    runPublishServerRuntime,
    runPublishUiWeb,
    runPublishDocker,
    runPublishNpm,
    runPublishCliBinaries,
    runPublishHstackBinaries,
    dockerBuildRelay,
    dockerBuildDevBox,
  };
}
