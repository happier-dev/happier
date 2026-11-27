// @ts-check

import { realpathSync } from 'node:fs';
import { appendFile, lstat, readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  BINARY_PUBLISH_PRODUCT_IDS,
  CLI_OPTIONAL_COMPONENT_PRODUCTS,
  getBinaryPublishProductSpec,
} from '../publishing/product-specs.mjs';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;

/** @typedef {Readonly<{ product: string; aliases: readonly string[]; tagPrefix: string; checksumProduct: string }>} ImmutableProductSpec */

// Binary products come from their publication owner; UI products publish their own signed envelopes
// (tauri/prepare-publish-assets, publish-ui-web, expo/publish-apk-release) under these names.
/** @type {readonly ImmutableProductSpec[]} */
const PRODUCT_SPECS = Object.freeze([
  ...BINARY_PUBLISH_PRODUCT_IDS.map((id) => {
    const spec = getBinaryPublishProductSpec(id);
    return Object.freeze({
      product: id,
      aliases: Object.freeze(id === 'hstack' ? ['hstack', 'stack'] : [id]),
      tagPrefix: spec.versionTagPrefix,
      checksumProduct: spec.checksumProductStem,
    });
  }),
  ...['ui-desktop', 'ui-mobile', 'ui-web'].map((product) =>
    Object.freeze({
      product,
      aliases: Object.freeze([product]),
      tagPrefix: `${product}-v`,
      checksumProduct: `happier-${product}`,
    }),
  ),
]);

/** @param {string} message */
function fail(message) {
  throw new Error(`[release] ${message}`);
}

/** @param {unknown} value @param {string} label */
function requireSafeSegment(value, label) {
  const segment = String(value ?? '').trim();
  if (!SAFE_SEGMENT.test(segment))
    fail(`${label} must be a safe non-empty release segment.`);
  return segment;
}

/** @param {{ product: string; version: string }} params */
export function resolveImmutableCandidateIdentity(params) {
  const requestedProduct = String(params.product ?? '').trim();
  const spec = PRODUCT_SPECS.find((entry) =>
    entry.aliases.includes(requestedProduct),
  );
  if (!spec)
    fail(
      `unsupported immutable candidate product: ${requestedProduct || '<empty>'}`,
    );
  const version = requireSafeSegment(
    params.version,
    'immutable candidate version',
  );
  return Object.freeze({
    product: spec.product,
    version,
    sourceTag: `${spec.tagPrefix}${version}`,
    checksumsName: `checksums-${spec.checksumProduct}-v${version}.txt`,
  });
}

/**
 * Inspect one downloaded immutable release and bind its tag to the product/version-specific signed
 * checksum manifest: every file is a flat regular file that manifest names (CLI component envelopes
 * included), and nothing else. Minisign verification stays with verify-artifacts.mjs; this owner makes
 * sure the verifier receives the only admissible manifest and that no unsigned asset rides along.
 *
 * @param {{ directory: string; sourceTag: string }} params
 */
export async function inspectImmutableReleaseCandidate(params) {
  const directory = resolve(String(params.directory ?? '').trim());
  const sourceTag = String(params.sourceTag ?? '').trim();
  const spec = PRODUCT_SPECS.find((entry) =>
    sourceTag.startsWith(entry.tagPrefix),
  );
  if (!spec)
    fail(`unsupported immutable source tag: ${sourceTag || '<empty>'}`);
  const { product, version, checksumsName } = resolveImmutableCandidateIdentity(
    {
      product: spec.product,
      version: sourceTag.slice(spec.tagPrefix.length),
    },
  );
  const signatureName = `${checksumsName}.minisig`;

  const entries = await readdir(directory, { withFileTypes: true }).catch(() =>
    fail(`immutable candidate directory does not exist: ${directory}`),
  );
  for (const entry of entries) {
    const info = await lstat(join(directory, entry.name));
    if (!entry.isFile() || info.isSymbolicLink())
      fail(
        `immutable candidate asset must be a flat regular file: ${entry.name}`,
      );
  }
  const names = entries.map((entry) => entry.name).sort();
  if (!names.includes(checksumsName) || !names.includes(signatureName)) {
    fail(
      `immutable ${product} ${version} candidate is missing ${checksumsName} or its Minisign signature.`,
    );
  }
  const componentEnvelopes = new Set(
    product === 'cli'
      ? CLI_OPTIONAL_COMPONENT_PRODUCTS.flatMap((component) => [
          `checksums-${component}-v${version}.txt`,
          `checksums-${component}-v${version}.txt.minisig`,
        ])
      : [],
  );
  const competing = names.filter(
    (name) =>
      /^checksums-.+\.txt(?:\.minisig)?$/u.test(name) &&
      name !== checksumsName &&
      name !== signatureName &&
      !componentEnvelopes.has(name),
  );
  if (competing.length > 0)
    fail(
      `immutable candidate contains competing checksum envelopes: ${competing.join(', ')}`,
    );

  const payloadNames = (await readFile(join(directory, checksumsName), 'utf8'))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^[a-f0-9]{64}\s{2}(.+)$/u.exec(line);
      if (!match) fail(`invalid checksum line in ${checksumsName}: ${line}`);
      const name = match[1];
      if (
        basename(name) !== name ||
        name === '.' ||
        name === '..' ||
        name.includes('\\')
      ) {
        fail(`checksum manifest contains an unsafe asset name: ${name}`);
      }
      return name;
    });
  if (payloadNames.length === 0)
    fail(`immutable candidate checksum manifest is empty: ${checksumsName}`);
  if (new Set(payloadNames).size !== payloadNames.length)
    fail(`checksum manifest contains duplicate asset names: ${checksumsName}`);
  const expected = new Set([...payloadNames, checksumsName, signatureName]);
  const unsigned = names.filter((name) => !expected.has(name));
  const missing = [...expected].filter((name) => !names.includes(name));
  if (unsigned.length > 0 || missing.length > 0) {
    fail(
      'immutable candidate file set does not match its signed envelope' +
        `${unsigned.length ? `; unsigned assets: ${unsigned.join(', ')}` : ''}` +
        `${missing.length ? `; missing assets: ${missing.join(', ')}` : ''}`,
    );
  }

  return Object.freeze({
    product,
    version,
    sourceTag,
    checksumsName,
    signatureName,
    assetNames: Object.freeze(payloadNames),
  });
}

async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      describe: { type: 'boolean', default: false },
      product: { type: 'string', default: '' },
      version: { type: 'string', default: '' },
      directory: { type: 'string', default: '' },
      'source-tag': { type: 'string', default: '' },
      'github-output': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });
  const githubOutput = String(values['github-output'] ?? '').trim();
  if (values.describe) {
    const identity = resolveImmutableCandidateIdentity({
      product: String(values.product),
      version: String(values.version),
    });
    if (githubOutput)
      await appendFile(
        githubOutput,
        `candidate_tag=${identity.sourceTag}\nchecksums_name=${identity.checksumsName}\n`,
        'utf8',
      );
    console.log(JSON.stringify(identity));
    return;
  }
  const directory = resolve(String(values.directory ?? ''));
  const inspected = await inspectImmutableReleaseCandidate({
    directory,
    sourceTag: String(values['source-tag'] ?? ''),
  });
  if (githubOutput)
    await appendFile(
      githubOutput,
      `checksums=${join(directory, inspected.checksumsName)}\n`,
      'utf8',
    );
  console.log(JSON.stringify(inspected));
}

if (
  process.argv[1] &&
  pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
