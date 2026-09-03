// @ts-check

import { appendFile, lstat, readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** @type {readonly Readonly<{ product: string; aliases: readonly string[]; tagPrefix: string; checksumProduct: string }>[] } */
const PRODUCT_SPECS = Object.freeze([
  Object.freeze({ product: 'ui-desktop', aliases: Object.freeze(['ui-desktop']), tagPrefix: 'ui-desktop-v', checksumProduct: 'happier-ui-desktop' }),
  Object.freeze({ product: 'ui-mobile', aliases: Object.freeze(['ui-mobile']), tagPrefix: 'ui-mobile-v', checksumProduct: 'happier-ui-mobile' }),
  Object.freeze({ product: 'ui-web', aliases: Object.freeze(['ui-web']), tagPrefix: 'ui-web-v', checksumProduct: 'happier-ui-web' }),
  Object.freeze({ product: 'hstack', aliases: Object.freeze(['hstack', 'stack']), tagPrefix: 'stack-v', checksumProduct: 'hstack' }),
  Object.freeze({ product: 'server', aliases: Object.freeze(['server']), tagPrefix: 'server-v', checksumProduct: 'happier-server' }),
  Object.freeze({ product: 'cli', aliases: Object.freeze(['cli']), tagPrefix: 'cli-v', checksumProduct: 'happier' }),
]);

function fail(message) {
  throw new Error(`[release] ${message}`);
}

/** @param {unknown} value @param {string} label */
function requireSafeSegment(value, label) {
  const segment = String(value ?? '').trim();
  if (!SAFE_SEGMENT.test(segment)) fail(`${label} must be a safe non-empty release segment.`);
  return segment;
}

/** @param {string} product */
function findProductSpec(product) {
  return PRODUCT_SPECS.find((spec) => spec.aliases.includes(product));
}

/** @param {string} sourceTag */
function findSourceTagSpec(sourceTag) {
  return PRODUCT_SPECS.find((spec) => sourceTag.startsWith(spec.tagPrefix));
}

/** @param {{ product: string; version: string }} params */
export function resolveImmutableCandidateIdentity(params) {
  const requestedProduct = String(params.product ?? '').trim();
  const spec = findProductSpec(requestedProduct);
  if (!spec) fail(`unsupported expected product: ${requestedProduct || '<empty>'}`);
  const version = requireSafeSegment(params.version, 'immutable candidate version');
  return Object.freeze({
    product: spec.product,
    version,
    sourceTag: `${spec.tagPrefix}${version}`,
    checksumsName: `checksums-${spec.checksumProduct}-v${version}.txt`,
  });
}

/**
 * Inspect one downloaded immutable release envelope and bind its public tag to the exact
 * product/version-specific checksum manifest. Minisign verification remains owned by
 * verify-artifacts.mjs; this owner makes sure that verifier receives the only admissible manifest.
 *
 * @param {{ directory: string; sourceTag: string; expectedProduct?: string; expectedVersion?: string }} params
 */
export async function inspectImmutableReleaseCandidate(params) {
  const directory = resolve(String(params.directory ?? '').trim());
  const sourceTag = String(params.sourceTag ?? '').trim();
  const tagSpec = findSourceTagSpec(sourceTag);
  if (!tagSpec) fail(`unsupported immutable source tag: ${sourceTag || '<empty>'}`);

  const expectedProductRaw = String(params.expectedProduct ?? '').trim();
  const expectedSpec = expectedProductRaw ? findProductSpec(expectedProductRaw) : tagSpec;
  if (!expectedSpec) fail(`unsupported expected product: ${expectedProductRaw}`);
  if (expectedSpec !== tagSpec) {
    fail(`immutable source tag ${sourceTag} does not identify expected product ${expectedProductRaw}.`);
  }

  const version = requireSafeSegment(sourceTag.slice(tagSpec.tagPrefix.length), 'immutable candidate version');
  const expectedVersionRaw = String(params.expectedVersion ?? '').trim();
  if (expectedVersionRaw && requireSafeSegment(expectedVersionRaw, 'expected version') !== version) {
    fail(`immutable source tag ${sourceTag} does not identify expected version ${expectedVersionRaw}.`);
  }

  const checksumsName = resolveImmutableCandidateIdentity({ product: tagSpec.product, version }).checksumsName;
  const signatureName = `${checksumsName}.minisig`;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => {
    fail(`immutable candidate directory does not exist: ${directory}`);
  });
  const names = entries.map((entry) => entry.name).sort();
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (!entry.isFile() || info.isSymbolicLink() || basename(entry.name) !== entry.name) {
      fail(`immutable candidate asset must be a flat regular file: ${entry.name}`);
    }
  }
  if (!names.includes(checksumsName) || !names.includes(signatureName)) {
    fail(`immutable ${tagSpec.product} ${version} candidate is missing ${checksumsName} or its Minisign signature.`);
  }
  const competingChecksums = names.filter((name) => /^checksums-.+\.txt(?:\.minisig)?$/u.test(name)
    && name !== checksumsName && name !== signatureName);
  if (competingChecksums.length > 0) {
    fail(`immutable candidate contains competing checksum envelopes: ${competingChecksums.join(', ')}`);
  }

  const checksumLines = (await readFile(join(directory, checksumsName), 'utf8'))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (checksumLines.length === 0) fail(`immutable candidate checksum manifest is empty: ${checksumsName}`);
  const payloadNames = checksumLines.map((line) => {
    const match = /^[a-f0-9]{64}\s{2}(.+)$/u.exec(line);
    if (!match) fail(`invalid checksum line in ${checksumsName}: ${line}`);
    const name = match[1];
    if (!name || basename(name) !== name || name === '.' || name === '..') {
      fail(`checksum manifest contains an unsafe asset name: ${name || '<empty>'}`);
    }
    return name;
  });
  if (new Set(payloadNames).size !== payloadNames.length) {
    fail(`checksum manifest contains duplicate asset names: ${checksumsName}`);
  }
  const expectedNames = [...payloadNames, checksumsName, signatureName].sort();
  if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
    const unsigned = names.filter((name) => !expectedNames.includes(name));
    const missing = expectedNames.filter((name) => !names.includes(name));
    fail(
      `immutable candidate file set does not match its signed envelope`
      + `${unsigned.length ? `; unsigned assets: ${unsigned.join(', ')}` : ''}`
      + `${missing.length ? `; missing assets: ${missing.join(', ')}` : ''}`,
    );
  }

  return Object.freeze({
    product: tagSpec.product,
    version,
    sourceTag,
    checksumsName,
    signatureName,
    assetNames: Object.freeze([...payloadNames]),
  });
}

async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      directory: { type: 'string' },
      'source-tag': { type: 'string' },
      'expected-product': { type: 'string', default: '' },
      'expected-version': { type: 'string', default: '' },
      'github-output': { type: 'string', default: '' },
      describe: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const result = values.describe === true
    ? resolveImmutableCandidateIdentity({
        product: String(values['expected-product'] ?? ''),
        version: String(values['expected-version'] ?? ''),
      })
    : await inspectImmutableReleaseCandidate({
        directory: String(values.directory ?? ''),
        sourceTag: String(values['source-tag'] ?? ''),
        expectedProduct: String(values['expected-product'] ?? ''),
        expectedVersion: String(values['expected-version'] ?? ''),
      });
  const githubOutput = String(values['github-output'] ?? '').trim();
  if (githubOutput) {
    const output = values.describe === true
      ? `candidate_tag=${result.sourceTag}\nchecksums_name=${result.checksumsName}\n`
      : `checksums=${join(resolve(String(values.directory)), result.checksumsName)}\n`;
    await appendFile(githubOutput, output, 'utf8');
  }
  console.log(JSON.stringify(result));
  return result;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
