#!/usr/bin/env node
// @ts-check

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { releaseTargets } from './component-registry.mjs';

/** @param {unknown} value */
const enabled = (value) => value === true || value === 'true';

/** @param {unknown} value */
function parseTargets(value) {
  const targets = String(value ?? '').split(',').map((target) => target.trim()).filter(Boolean);
  for (const target of targets) {
    if (!releaseTargets.includes(target)) throw new Error(`unsupported release target '${target}'`);
  }
  return targets;
}

/**
 * @param {{ serverRuntimeNeeded: boolean; cliBinariesNeeded: boolean;
 * stackNeeded: boolean; runnerNeeded: boolean;
 * risks: { mysqlContract: boolean; platformServices: boolean; trustRoots: boolean } }} input
 */
export function resolveRequiredSourceValidationGates(input) {
  return {
    runMysql: input.risks.mysqlContract && input.serverRuntimeNeeded,
    runPlatform: input.risks.platformServices && (input.serverRuntimeNeeded || input.cliBinariesNeeded || input.stackNeeded || input.runnerNeeded),
    runTrustRoots: input.risks.trustRoots,
  };
}

/**
 * @param {{ deployTargets: string[]; forceDeploy: boolean;
 * candidate: { cli: boolean };
 * changed: { ui: boolean; cli: boolean; cliStackShared: boolean; server: boolean; shared: boolean; stack: boolean; runner: boolean };
 * resume: { cli: boolean; stack: boolean; server: boolean; runner: boolean };
 * risks: { mysqlContract: boolean; platformServices: boolean; trustRoots: boolean } }} input
 */
export function resolveSourceValidationPlan(input) {
  const targets = new Set(input.deployTargets);
  const serverRuntimeNeeded = input.resume.server
    || input.forceDeploy
    || targets.has('server_runner')
    || input.changed.ui
    || input.changed.server
    || input.changed.shared;
  const cliBinariesNeeded = input.resume.cli
    || input.candidate.cli
    || input.forceDeploy
    || targets.has('cli')
    || input.changed.cli
    || input.changed.cliStackShared
    || input.changed.shared;
  const stackNeeded = input.resume.stack
    || targets.has('stack')
    || input.changed.stack
    || input.changed.cliStackShared;
  const runnerNeeded = input.resume.runner || input.changed.runner;

  return resolveRequiredSourceValidationGates({
    serverRuntimeNeeded, cliBinariesNeeded, stackNeeded, runnerNeeded, risks: input.risks,
  });
}

/** @param {Record<string, string | undefined>} env */
export function resolveSourceValidationPlanFromEnvironment(env) {
  return resolveSourceValidationPlan({
    deployTargets: parseTargets(env.DEPLOY_TARGETS),
    forceDeploy: enabled(env.FORCE_DEPLOY),
    candidate: {
      cli: enabled(env.CANDIDATE_CLI_REQUESTED),
    },
    changed: {
      ui: enabled(env.CHANGED_UI),
      cli: enabled(env.CHANGED_CLI),
      cliStackShared: enabled(env.CHANGED_CLI_STACK_SHARED),
      server: enabled(env.CHANGED_SERVER),
      shared: enabled(env.CHANGED_SHARED),
      stack: enabled(env.CHANGED_STACK),
      runner: enabled(env.CHANGED_RUNNER),
    },
    resume: {
      cli: enabled(env.RESUME_CLI_REQUESTED),
      stack: enabled(env.RESUME_STACK_REQUESTED),
      server: enabled(env.RESUME_SERVER_REQUESTED),
      runner: enabled(env.RESUME_RUNNER_REQUESTED),
    },
    risks: {
      mysqlContract: enabled(env.RISK_MYSQL_CONTRACT),
      platformServices: enabled(env.RISK_PLATFORM_SERVICES),
      trustRoots: enabled(env.RISK_TRUST_ROOTS),
    },
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const result = resolveSourceValidationPlanFromEnvironment(process.env);
    const output = process.argv.includes('--pre-release-checks') ? resolvePreReleaseCheckPlan({
      eventName: process.env.EVENT_NAME ?? '',
      changedPaths: JSON.parse(process.env.CHANGED_PATHS_JSON || '[]'),
    }) : {
      run_mysql: String(result.runMysql),
      run_platform: String(result.runPlatform),
      run_trust_roots: String(result.runTrustRoots),
    };
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `${Object.entries(output).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, 'utf8');
    } else {
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

/** Source CI owns selection; release callers keep their explicit selectors.
 * @param {{eventName: string; changedPaths: string[]}} input
 */
export function resolvePreReleaseCheckPlan({ eventName, changedPaths }) {
  const common = eventName === 'schedule' || changedPaths.some((path) =>
    /^(?:package\.json|(?:pnpm-lock|pnpm-workspace)\.yaml|yarn\.lock|\.node-version|\.github\/workflows\/tests\.yml)$/.test(path)
    || /^(?:\.github\/actions\/|scripts\/ci\/|scripts\/workspaces\/)/.test(path)
    || path === 'scripts/pipeline/release/resolve-source-validation-plan.mjs');
  return {
    run_self_host_schtasks: common || changedPaths.some((path) =>
      /^(?:apps\/stack\/|scripts\/install\/|packages\/cli-common\/(?:native\/windows\/|src\/(?:service|process)\/))/.test(path)),
    run_packaged_cli: common || changedPaths.some((path) =>
      /^(?:apps\/cli\/|packages\/|scripts\/pipeline\/release\/|scripts\/install\/)/.test(path)),
    run_mobile_native: common || changedPaths.some((path) =>
      /^(?:apps\/ui\/|packages\/|scripts\/pipeline\/expo\/|scripts\/mobile\/)/.test(path)),
  };
}
