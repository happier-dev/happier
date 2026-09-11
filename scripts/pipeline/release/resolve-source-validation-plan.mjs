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
 * @param {{ deployTargets: string[]; forceDeploy: boolean;
 * changed: { ui: boolean; cli: boolean; cliStackShared: boolean; server: boolean; shared: boolean; stack: boolean };
 * resume: { cli: boolean; stack: boolean; server: boolean };
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
    || input.forceDeploy
    || targets.has('cli')
    || input.changed.cli
    || input.changed.cliStackShared
    || input.changed.shared;
  const stackNeeded = input.resume.stack
    || targets.has('stack')
    || input.changed.stack
    || input.changed.cliStackShared;

  return {
    runMysql: input.risks.mysqlContract && serverRuntimeNeeded,
    runPlatform: input.risks.platformServices && (serverRuntimeNeeded || cliBinariesNeeded || stackNeeded),
    runTrustRoots: input.risks.trustRoots,
  };
}

/** @param {Record<string, string | undefined>} env */
export function resolveSourceValidationPlanFromEnvironment(env) {
  return resolveSourceValidationPlan({
    deployTargets: parseTargets(env.DEPLOY_TARGETS),
    forceDeploy: enabled(env.FORCE_DEPLOY),
    changed: {
      ui: enabled(env.CHANGED_UI),
      cli: enabled(env.CHANGED_CLI),
      cliStackShared: enabled(env.CHANGED_CLI_STACK_SHARED),
      server: enabled(env.CHANGED_SERVER),
      shared: enabled(env.CHANGED_SHARED),
      stack: enabled(env.CHANGED_STACK),
    },
    resume: {
      cli: enabled(env.RESUME_CLI_REQUESTED),
      stack: enabled(env.RESUME_STACK_REQUESTED),
      server: enabled(env.RESUME_SERVER_REQUESTED),
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
    const output = {
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
