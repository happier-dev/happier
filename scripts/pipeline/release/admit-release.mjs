#!/usr/bin/env node
// @ts-check

import { pathToFileURL } from 'node:url';

/** @param {unknown} value */
const enabled = (value) => value === true || value === 'true';

/**
 * @param {{ checksProfile: string; environment: string; publishServerRuntimeNeeded: boolean;
 * publishCliBinariesNeeded: boolean; publishStack: boolean; sourceChecksWaived: boolean;
 * risks: { mysqlContract: boolean; platformServices: boolean; trustRoots: boolean };
 * gates: { mysql: string; platform: string; trustRoots: string } }} input
 */
export function admitRelease(input) {
  if (input.environment === 'production' && input.checksProfile !== 'full') {
    throw new Error('production releases require checks_profile=full');
  }
  if (!input.sourceChecksWaived && input.publishServerRuntimeNeeded && input.risks.mysqlContract && input.gates.mysql !== 'success') {
    throw new Error('server runtime publication requires a successful MySQL gate');
  }
  if (!input.sourceChecksWaived && input.risks.platformServices && (input.publishServerRuntimeNeeded || input.publishCliBinariesNeeded || input.publishStack) && input.gates.platform !== 'success') {
    throw new Error('server, CLI, or stack publication requires successful platform gates');
  }
  if (input.risks.trustRoots && input.gates.trustRoots !== 'success') {
    throw new Error('trust-root changes require successful installer and updater trust validation');
  }
  return { admitted: true };
}

/** @param {Record<string, string | undefined>} env */
export function admitReleaseFromEnvironment(env) {
  return admitRelease({
    checksProfile: String(env.CHECKS_PROFILE ?? ''),
    environment: String(env.DEPLOY_ENVIRONMENT ?? ''),
    publishServerRuntimeNeeded: enabled(env.PUBLISH_SERVER_RUNTIME_NEEDED),
    publishCliBinariesNeeded: enabled(env.PUBLISH_CLI_BINARIES_NEEDED),
    publishStack: enabled(env.PUBLISH_STACK),
    sourceChecksWaived: enabled(env.WAIVE_SOURCE_CHECKS),
    risks: {
      mysqlContract: enabled(env.RISK_MYSQL_CONTRACT),
      platformServices: enabled(env.RISK_PLATFORM_SERVICES),
      trustRoots: enabled(env.RISK_TRUST_ROOTS),
    },
    gates: {
      mysql: String(env.MYSQL_GATE_RESULT ?? ''),
      platform: String(env.PLATFORM_GATE_RESULT ?? ''),
      trustRoots: String(env.TRUST_ROOT_GATE_RESULT ?? ''),
    },
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { admitReleaseFromEnvironment(process.env); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
