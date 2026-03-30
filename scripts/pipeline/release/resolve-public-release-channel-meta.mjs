// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  formatPublicReleaseChannel,
  formatPublicReleaseChannelChoices,
  getPublicReleaseRingEntry,
  normalizePublicReleaseChannel,
  resolveEmbeddedPolicyForChannel,
  resolveExpoAppEnvironmentForChannel,
  resolvePublicReleaseSourceRef,
} from './lib/public-release-rings.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {string} outputPath
 * @param {Record<string, string>} values
 */
function writeGithubOutput(outputPath, values) {
  if (!outputPath) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value ?? '')}`);
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

/**
 * @param {string} outPath
 * @param {unknown} value
 */
function writeJson(outPath, value) {
  if (!outPath) return;
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main() {
  const { values } = parseArgs({
    options: {
      channel: { type: 'string' },
      'source-ref': { type: 'string', default: 'auto' },
      'github-output': { type: 'string', default: '' },
      'out-json': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });

  const requestedChannel = String(values.channel ?? '').trim();
  if (!requestedChannel) fail('--channel is required');
  const channel = normalizePublicReleaseChannel(requestedChannel);
  if (!channel) {
    fail(`--channel must be ${JSON.stringify(formatPublicReleaseChannelChoices())} (got: ${requestedChannel || '<empty>'})`);
  }

  const sourceRef = resolvePublicReleaseSourceRef(channel, values['source-ref']);
  const entry = getPublicReleaseRingEntry(channel);
  const payload = {
    channel_id: channel,
    channel_label: formatPublicReleaseChannel(channel),
    source_ref: sourceRef,
    source_branch: entry.sourceBranch,
    app_env: resolveExpoAppEnvironmentForChannel(channel),
    embedded_policy_env: resolveEmbeddedPolicyForChannel(channel),
    expo_updates_channel: entry.expoUpdatesChannel,
    manifest_channel: entry.manifestChannel ?? '',
    rolling_release_suffix: entry.rollingReleaseSuffix ?? '',
  };

  writeGithubOutput(String(values['github-output'] ?? '').trim(), {
    channel_id: payload.channel_id,
    channel_label: payload.channel_label,
    source_ref: payload.source_ref,
    source_branch: payload.source_branch,
    app_env: payload.app_env,
    embedded_policy_env: payload.embedded_policy_env,
    expo_updates_channel: payload.expo_updates_channel,
    manifest_channel: payload.manifest_channel,
    rolling_release_suffix: payload.rolling_release_suffix,
  });
  writeJson(String(values['out-json'] ?? '').trim(), payload);

  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

main();
