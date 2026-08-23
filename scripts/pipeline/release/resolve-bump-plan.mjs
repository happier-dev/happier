// @ts-check

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { releaseTargets } from './component-registry.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function parseCsvList(value) {
  return String(value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parseBoolString(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${name} must be 'true' or 'false' (got: ${value})`);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {boolean | undefined}
 */
function parseOptionalBoolString(value, name) {
  if (value === undefined) return undefined;
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  return parseBoolString(raw, name);
}

/**
 * @param {string} outputPath
 * @param {Record<string, string>} values
 */
function writeGithubOutput(outputPath, values) {
  if (!outputPath) return;
  const lines = Object.entries(values).map(([k, v]) => `${k}=${String(v ?? '')}`);
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function readJsonVersionFromDisk(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return String(parsed?.version ?? '').trim();
}

/**
 * @param {string} gitPath
 * @returns {string}
 */
function readJsonVersionFromGit(gitPath) {
  const raw = execFileSync('git', ['show', `origin/main:${gitPath}`], {
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  const parsed = JSON.parse(String(raw ?? ''));
  return String(parsed?.version ?? '').trim();
}

/**
 * @param {string} override
 * @param {string} preset
 */
function resolveOverride(override, preset) {
  return override === 'preset' ? preset : override;
}

/**
 * @param {boolean} changed
 * @param {string} bump
 */
function shouldBumpComponent(changed, bump) {
  if (!changed) return 'none';
  return bump;
}

function main() {
  const { values } = parseArgs({
    options: {
      environment: { type: 'string' },
      'bump-preset': { type: 'string' },
      'bump-app-override': { type: 'string', default: 'preset' },
      'bump-cli-override': { type: 'string', default: 'preset' },
      'bump-stack-override': { type: 'string', default: 'preset' },
      'bump-plugin-sdk-override': { type: 'string', default: 'preset' },
      'bump-sdk-override': { type: 'string', default: 'preset' },
      'deploy-targets': { type: 'string', default: '' },
      'changed-ui': { type: 'string' },
      'changed-cli': { type: 'string' },
      'changed-stack': { type: 'string' },
      'changed-server': { type: 'string' },
      'changed-website': { type: 'string' },
      'changed-cli-stack-shared': { type: 'string' },
      'changed-shared': { type: 'string' },
      'changed-plugin-sdk': { type: 'string', default: 'false' },
      'changed-sdk': { type: 'string', default: 'false' },
      'versioned-app-changed': { type: 'string' },
      'versioned-cli-changed': { type: 'string' },
      'versioned-stack-changed': { type: 'string' },
      'versioned-server-changed': { type: 'string' },
      'versioned-plugin-sdk-changed': { type: 'string' },
      'versioned-sdk-changed': { type: 'string' },
      'github-output': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });

  const environment = String(values.environment ?? '').trim();
  if (!environment) fail('--environment is required');
  if (environment !== 'dev' && environment !== 'preview' && environment !== 'production') {
    fail(`--environment must be 'dev', 'preview', or 'production' (got: ${environment})`);
  }

  const bumpPreset = String(values['bump-preset'] ?? '').trim();
  if (!bumpPreset) fail('--bump-preset is required');
  if (!['none', 'patch', 'minor', 'major'].includes(bumpPreset)) {
    fail(`--bump-preset must be one of: none, patch, minor, major (got: ${bumpPreset})`);
  }

  const bumpAppOverride = String(values['bump-app-override'] ?? '').trim() || 'preset';
  const bumpCliOverride = String(values['bump-cli-override'] ?? '').trim() || 'preset';
  const bumpStackOverride = String(values['bump-stack-override'] ?? '').trim() || 'preset';
  const bumpPluginSdkOverride = String(values['bump-plugin-sdk-override'] ?? '').trim() || 'preset';
  const bumpSdkOverride = String(values['bump-sdk-override'] ?? '').trim() || 'preset';

  for (const [name, v] of [
    ['--bump-app-override', bumpAppOverride],
    ['--bump-cli-override', bumpCliOverride],
    ['--bump-stack-override', bumpStackOverride],
    ['--bump-plugin-sdk-override', bumpPluginSdkOverride],
    ['--bump-sdk-override', bumpSdkOverride],
  ]) {
    if (!['preset', 'none', 'patch', 'minor', 'major'].includes(v)) {
      fail(`${name} must be one of: preset, none, patch, minor, major (got: ${v})`);
    }
  }

  const deployTargets = parseCsvList(String(values['deploy-targets'] ?? ''));
  for (const t of deployTargets) {
    if (!releaseTargets.includes(t)) {
      fail(`--deploy-targets contains unsupported entry '${t}'`);
    }
  }

  const changedUi = parseBoolString(values['changed-ui'], '--changed-ui');
  const changedCliRaw = parseBoolString(values['changed-cli'], '--changed-cli');
  const changedStackRaw = parseBoolString(values['changed-stack'], '--changed-stack');
  const changedServerRaw = parseBoolString(values['changed-server'], '--changed-server');
  const changedWebsite = parseBoolString(values['changed-website'], '--changed-website');
  const changedCliStackShared = parseOptionalBoolString(values['changed-cli-stack-shared'], '--changed-cli-stack-shared') ?? false;
  const changedShared = parseBoolString(values['changed-shared'], '--changed-shared');
  const changedPluginSdkRaw = parseBoolString(values['changed-plugin-sdk'], '--changed-plugin-sdk');
  const changedSdkRaw = parseBoolString(values['changed-sdk'], '--changed-sdk');
  const versionedAppChanged = parseOptionalBoolString(values['versioned-app-changed'], '--versioned-app-changed');
  const versionedCliChanged = parseOptionalBoolString(values['versioned-cli-changed'], '--versioned-cli-changed');
  const versionedStackChanged = parseOptionalBoolString(values['versioned-stack-changed'], '--versioned-stack-changed');
  const versionedServerChanged = parseOptionalBoolString(values['versioned-server-changed'], '--versioned-server-changed');
  const versionedPluginSdkChanged = parseOptionalBoolString(values['versioned-plugin-sdk-changed'], '--versioned-plugin-sdk-changed');
  const versionedSdkChanged = parseOptionalBoolString(values['versioned-sdk-changed'], '--versioned-sdk-changed');

  const publishCli = deployTargets.includes('cli');
  const publishStack = deployTargets.includes('stack');
  const publishServer = deployTargets.includes('server_runner');
  const publishPluginSdk = deployTargets.includes('plugin_sdk');
  const publishSdk = deployTargets.includes('sdk');
  const targetsServerRelease = deployTargets.includes('server') || publishServer;

  const changedApp = versionedAppChanged ?? (changedUi || changedShared);
  const changedCli = versionedCliChanged ?? (changedCliRaw || changedShared || changedCliStackShared);
  const changedStack = versionedStackChanged ?? (changedStackRaw || changedShared || changedCliStackShared);
  const changedServer = targetsServerRelease ? (versionedServerChanged ?? (changedServerRaw || changedShared)) : false;
  const changedPluginSdk = versionedPluginSdkChanged ?? (changedPluginSdkRaw || changedShared);
  const changedSdk = versionedSdkChanged ?? changedSdkRaw;

  const bumpApp = shouldBumpComponent(changedApp, resolveOverride(bumpAppOverride, bumpPreset));
  const bumpCli = shouldBumpComponent(changedCli, resolveOverride(bumpCliOverride, bumpPreset));
  const bumpStack = shouldBumpComponent(changedStack, resolveOverride(bumpStackOverride, bumpPreset));
  const bumpServer = shouldBumpComponent(changedServer, bumpPreset);
  const bumpWebsite = shouldBumpComponent(changedWebsite, bumpPreset);
  const bumpPluginSdk = shouldBumpComponent(changedPluginSdk, resolveOverride(bumpPluginSdkOverride, bumpPreset));
  const bumpSdk = shouldBumpComponent(changedSdk, resolveOverride(bumpSdkOverride, bumpPreset));

  // Production safety: refuse publishing without a version change.
  if (environment === 'production') {
    if (publishCli && bumpCli === 'none') {
      const devVersion = readJsonVersionFromDisk('apps/cli/package.json');
      const mainVersion = readJsonVersionFromGit('apps/cli/package.json');
      if (!devVersion || !mainVersion) {
        fail('Unable to resolve cli versions for production validation.');
      }
      if (devVersion === mainVersion) {
        fail(
          `Refusing production deploy_targets includes cli without a version change (dev and main both at ${devVersion}). Materialize and commit CHANGELOG and version changes in the approved candidate, then rerun final exact-SHA promotion with bump=none.`,
        );
      }
    }

    if (publishStack && bumpStack === 'none') {
      const devVersion = readJsonVersionFromDisk('apps/stack/package.json');
      const mainVersion = readJsonVersionFromGit('apps/stack/package.json');
      if (!devVersion || !mainVersion) {
        fail('Unable to resolve stack versions for production validation.');
      }
      if (devVersion === mainVersion) {
        fail(
          `Refusing production deploy_targets includes stack without a version change (dev and main both at ${devVersion}). Materialize and commit CHANGELOG and version changes in the approved candidate, then rerun final exact-SHA promotion with bump=none.`,
        );
      }
    }

    if (publishServer && bumpServer === 'none') {
      const runnerDevPath = 'packages/relay-server/package.json';
      if (!fs.existsSync(runnerDevPath)) {
        fail(`Unable to resolve server runner package.json (expected ${runnerDevPath}).`);
      }
      const devVersion = readJsonVersionFromDisk(runnerDevPath);

      let mainVersion = '';
      try {
        mainVersion = readJsonVersionFromGit(runnerDevPath);
      } catch {
        mainVersion = '';
      }

      if (mainVersion && devVersion && devVersion === mainVersion) {
        fail(
          `Refusing production deploy_targets includes server without a version change (dev and main both at ${devVersion}). Materialize and commit CHANGELOG and version changes in the approved candidate, then rerun final exact-SHA promotion with bump=none.`,
        );
      }
    }

    if (publishPluginSdk && bumpPluginSdk === 'none') {
      const paths = ['packages/plugin-sdk/package.json', 'packages/plugin-ui/package.json'];
      const devVersions = paths.map(readJsonVersionFromDisk);
      const mainVersions = paths.map((filePath) => readJsonVersionFromGit(filePath));
      if (!devVersions.every(Boolean) || !mainVersions.every(Boolean)) {
        fail('Unable to resolve plugin SDK pair versions for production validation.');
      }
      if (devVersions[0] !== devVersions[1] || mainVersions[0] !== mainVersions[1]) {
        fail('plugin-sdk and plugin-ui versions must match for production validation.');
      }
      if (devVersions[0] === mainVersions[0]) {
        fail(
          `Refusing production deploy_targets includes plugin_sdk without a version change (dev and main both at ${devVersions[0]}). Materialize and commit CHANGELOG and version changes in the approved candidate, then rerun final exact-SHA promotion with bump=none.`,
        );
      }
    }

    if (publishSdk && bumpSdk === 'none') {
      const sdkPath = 'packages/sdk/package.json';
      if (!fs.existsSync(sdkPath)) fail(`Unable to resolve SDK package.json (expected ${sdkPath}).`);
      const devVersion = readJsonVersionFromDisk(sdkPath);
      const mainVersion = readJsonVersionFromGit(sdkPath);
      if (!devVersion || !mainVersion) fail('Unable to resolve SDK versions for production validation.');
      if (devVersion === mainVersion) {
        fail(
          `Refusing production deploy_targets includes sdk without a version change (dev and main both at ${devVersion}). Materialize and commit CHANGELOG and version changes in the approved candidate, then rerun final exact-SHA promotion with bump=none.`,
        );
      }
    }
  }

  const shouldBump = [bumpApp, bumpCli, bumpStack, bumpServer, bumpWebsite, bumpPluginSdk, bumpSdk].some((v) => v !== 'none');

  const result = {
    publish_cli: publishCli,
    publish_stack: publishStack,
    publish_server: publishServer,
    publish_plugin_sdk: publishPluginSdk,
    publish_sdk: publishSdk,
    bump_app: bumpApp,
    bump_cli: bumpCli,
    bump_stack: bumpStack,
    bump_server: bumpServer,
    bump_website: bumpWebsite,
    bump_plugin_sdk: bumpPluginSdk,
    bump_sdk: bumpSdk,
    should_bump: shouldBump,
  };

  writeGithubOutput(String(values['github-output'] ?? '').trim(), {
    publish_cli: publishCli ? 'true' : 'false',
    publish_stack: publishStack ? 'true' : 'false',
    publish_server: publishServer ? 'true' : 'false',
    publish_plugin_sdk: publishPluginSdk ? 'true' : 'false',
    publish_sdk: publishSdk ? 'true' : 'false',
    bump_app: bumpApp,
    bump_cli: bumpCli,
    bump_stack: bumpStack,
    bump_server: bumpServer,
    bump_website: bumpWebsite,
    bump_plugin_sdk: bumpPluginSdk,
    bump_sdk: bumpSdk,
    should_bump: shouldBump ? 'true' : 'false',
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main();
