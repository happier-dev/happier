#!/usr/bin/env node

// @ts-check

import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

/** @param {unknown} value @param {string} name */
function parseBoolean(value, name) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

/**
 * Resolve the release-ring facts that are safe to decide before source checkout.
 * This is deliberately the sole owner for npm tag/source-ref coupling; workflows
 * only provide GitHub topology and execute this local contract.
 *
 * @param {{
 *   channel: string;
 *   npmTag: string;
 *   sourceRef: string;
 *   authorizedSha: string;
 *   publishCli: boolean;
 *   publishStack: boolean;
 *   publishServer: boolean;
 *   publishPluginSdk: boolean;
 *   publishSdk: boolean;
 *   publishChannelsProtocol: boolean;
 * }} input
 */
export function resolveNpmReleaseInputs(input) {
  const channel = String(input.channel ?? '').trim();
  if (channel !== 'preview' && channel !== 'production') {
    throw new Error(`channel must be 'preview' or 'production' (got '${channel || '<empty>'}')`);
  }

  const requested = [
    input.publishCli,
    input.publishStack,
    input.publishServer,
    input.publishPluginSdk,
    input.publishSdk,
    input.publishChannelsProtocol,
  ];
  if (!requested.some(Boolean)) {
    throw new Error('At least one npm publication target must be true.');
  }

  const npmTag = String(input.npmTag ?? '').trim();
  const expectedTag = channel === 'preview' ? 'next' : 'latest';
  if (npmTag !== expectedTag) {
    throw new Error(`npm_tag must be '${expectedTag}' for channel='${channel}' (got '${npmTag}').`);
  }

  let sourceRef = String(input.sourceRef ?? '').trim();
  if (sourceRef === 'auto') sourceRef = channel === 'preview' ? 'preview' : 'main';
  const expectedSourceRef = channel === 'preview' ? 'preview' : 'main';
  if (sourceRef !== expectedSourceRef) {
    const label = channel === 'preview' ? 'Preview' : 'Production';
    throw new Error(`${label} releases must run from ${expectedSourceRef} (got source_ref='${sourceRef}').`);
  }

  const authorizedSha = String(input.authorizedSha ?? '').trim();
  if (!/^[0-9a-f]{40}$/u.test(authorizedSha)) {
    throw new Error('authorized_sha must be exactly 40 lowercase hexadecimal characters.');
  }

  return { channel, npmTag, sourceRef, authorizedSha };
}

function main() {
  const { values } = parseArgs({
    options: {
      channel: { type: 'string' },
      'npm-tag': { type: 'string' },
      'source-ref': { type: 'string', default: 'auto' },
      'authorized-sha': { type: 'string', default: '' },
      'publish-cli': { type: 'string', default: 'false' },
      'publish-stack': { type: 'string', default: 'false' },
      'publish-server': { type: 'string', default: 'false' },
      'publish-plugin-sdk': { type: 'string', default: 'false' },
      'publish-sdk': { type: 'string', default: 'false' },
      'publish-channels-protocol': { type: 'string', default: 'false' },
      'github-output': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });

  const result = resolveNpmReleaseInputs({
    channel: String(values.channel ?? ''),
    npmTag: String(values['npm-tag'] ?? ''),
    sourceRef: String(values['source-ref'] ?? 'auto'),
    authorizedSha: String(values['authorized-sha'] ?? ''),
    publishCli: parseBoolean(values['publish-cli'], '--publish-cli'),
    publishStack: parseBoolean(values['publish-stack'], '--publish-stack'),
    publishServer: parseBoolean(values['publish-server'], '--publish-server'),
    publishPluginSdk: parseBoolean(values['publish-plugin-sdk'], '--publish-plugin-sdk'),
    publishSdk: parseBoolean(values['publish-sdk'], '--publish-sdk'),
    publishChannelsProtocol: parseBoolean(values['publish-channels-protocol'], '--publish-channels-protocol'),
  });

  const githubOutput = String(values['github-output'] ?? '').trim();
  if (githubOutput) {
    appendFileSync(
      githubOutput,
      `channel=${result.channel}\nnpm_tag=${result.npmTag}\nsource_ref=${result.sourceRef}\nauthorized_sha=${result.authorizedSha}\n`,
      'utf8',
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
