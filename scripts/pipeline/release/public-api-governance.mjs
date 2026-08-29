import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { extractArchivePayloadToDirectory } from '@happier-dev/release-runtime/archiveExtraction';

import { renderDeclarationDiffSample, summarizeDeclarationDiff } from '../../api-governance/declarationDiff.mjs';
import { resolveWindowsCommandInvocation } from '../lib/windows/resolveWindowsCommandInvocation.mjs';
import { resolvePackedTarball } from '../npm/resolvePackedTarball.mjs';
import {
  listPublicReleaseChannelInputLabels,
  normalizePublicReleaseChannel,
  resolveRollingReleaseTagSuffix,
} from './lib/public-release-rings.mjs';

const INVENTORY_PATH = 'api-surface.json';
const DECLARATION_PATH = 'api-declarations.md';
const NPM_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const DEPRECATION_FIELDS = Object.freeze(['replacement', 'removalCondition']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pathIsInside(rootPath, candidatePath) {
  const rel = relative(resolve(rootPath), resolve(candidatePath));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function normalizePackageName(value) {
  const packageName = String(value ?? '').trim();
  if (!packageName || packageName.length > 214 || /\s/u.test(packageName)) {
    throw new Error('Public API release package name must be a bounded npm package name');
  }
  return packageName;
}

function normalizePublishedVersion(value, label) {
  const version = String(value ?? '').trim();
  if (!NPM_SEMVER.test(version)) {
    throw new Error(`${label} must be an exact npm semver`);
  }
  return version;
}

async function readRegularUtf8(path, label) {
  const stats = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
  return readFile(path, 'utf8');
}

async function readInventory(path, label) {
  const contents = await readRegularUtf8(path, label);
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Public API inventory must contain finite JSON numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isRecord(value)) throw new Error('Public API inventory must contain JSON values');
  return `{${Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function symbolKey(symbol) {
  if (!isRecord(symbol) || typeof symbol.specifier !== 'string' || typeof symbol.exportName !== 'string') {
    throw new Error('Public API inventory symbols must include string specifier and exportName fields');
  }
  return `${symbol.specifier}:${symbol.exportName}`;
}

function inventorySymbolMap(inventory, label) {
  if (!isRecord(inventory) || !Array.isArray(inventory.symbols)) {
    throw new Error(`${label} must contain a symbols array`);
  }
  const symbols = new Map();
  for (const symbol of inventory.symbols) {
    const key = symbolKey(symbol);
    if (symbols.has(key)) throw new Error(`${label} has a duplicate symbol: ${key}`);
    symbols.set(key, symbol);
  }
  return symbols;
}

function withoutDeprecationFields(symbol) {
  const result = { ...symbol };
  delete result.since;
  for (const field of DEPRECATION_FIELDS) delete result[field];
  return result;
}

function withoutPublisherOwnedFields(symbol) {
  const result = { ...symbol };
  delete result.since;
  return result;
}

function isPureDeprecation(previous, candidate) {
  const candidateDeclaresDeprecation = DEPRECATION_FIELDS.some((field) => (
    Object.hasOwn(candidate, field) && candidate[field] !== undefined
  ));
  const previousDeclaresDeprecation = DEPRECATION_FIELDS.some((field) => (
    Object.hasOwn(previous, field) && previous[field] !== undefined
  ));
  return candidateDeclaresDeprecation
    && !previousDeclaresDeprecation
    && canonicalJson(withoutPublisherOwnedFields(previous)) === canonicalJson(withoutDeprecationFields(candidate));
}

function noBaselineReport({ packageName, candidateVersion }) {
  return Object.freeze({
    status: 'dormant_pre_baseline',
    packageName,
    candidateVersion,
    previousVersion: null,
    disposition: Object.freeze({
      removedSymbolsAreBreaking: false,
      humanReviewRequired: false,
      versionDecision: 'not_applicable_pre_baseline',
    }),
  });
}

/**
 * Reports generated-record differences only. It deliberately does not decide
 * whether a declaration edit is breaking or choose a version: that remains a
 * human release decision.
 */
export function comparePublicApiReleaseRecords({
  packageName: packageNameInput,
  candidateVersion: candidateVersionInput,
  previousVersion: previousVersionInput,
  previousInventory,
  candidateInventory,
  previousDeclarations,
  candidateDeclarations,
}) {
  const packageName = normalizePackageName(packageNameInput);
  const candidateVersion = normalizePublishedVersion(candidateVersionInput, 'Candidate version');
  if (previousVersionInput === null || previousInventory === null || previousDeclarations === null) {
    return noBaselineReport({ packageName, candidateVersion });
  }
  const previousVersion = normalizePublishedVersion(previousVersionInput, 'Previous published version');
  if (typeof candidateDeclarations !== 'string' || typeof previousDeclarations !== 'string') {
    throw new Error('Public API declaration records must be strings');
  }

  const previousSymbols = inventorySymbolMap(previousInventory, 'Previous published API inventory');
  const candidateSymbols = inventorySymbolMap(candidateInventory, 'Candidate API inventory');
  const addedSymbols = [];
  const removedSymbols = [];
  const deprecatedSymbols = [];
  const changedSymbols = [];
  const unchangedSymbols = [];

  for (const [key, candidate] of candidateSymbols) {
    const previous = previousSymbols.get(key);
    if (previous === undefined) {
      addedSymbols.push(key);
      continue;
    }
    if (canonicalJson(withoutPublisherOwnedFields(previous)) === canonicalJson(withoutPublisherOwnedFields(candidate))) {
      unchangedSymbols.push(key);
      continue;
    }
    if (isPureDeprecation(previous, candidate)) {
      deprecatedSymbols.push(key);
      continue;
    }
    changedSymbols.push(key);
  }
  for (const key of previousSymbols.keys()) {
    if (!candidateSymbols.has(key)) removedSymbols.push(key);
  }

  const changedDeclarationBlocks = summarizeDeclarationDiff(previousDeclarations, candidateDeclarations);
  const requiresHumanReview = (
    removedSymbols.length > 0
    || deprecatedSymbols.length > 0
    || changedSymbols.length > 0
    || changedDeclarationBlocks.length > 0
  );
  const hasMechanicalDifference = addedSymbols.length > 0 || requiresHumanReview;
  return Object.freeze({
    status: 'comparison',
    packageName,
    candidateVersion,
    previousVersion,
    facts: Object.freeze({
      addedSymbols: Object.freeze(addedSymbols.sort((left, right) => left.localeCompare(right))),
      removedSymbols: Object.freeze(removedSymbols.sort((left, right) => left.localeCompare(right))),
      deprecatedSymbols: Object.freeze(deprecatedSymbols.sort((left, right) => left.localeCompare(right))),
      changedSymbols: Object.freeze(changedSymbols.sort((left, right) => left.localeCompare(right))),
      unchangedSymbols: Object.freeze(unchangedSymbols.sort((left, right) => left.localeCompare(right))),
      changedDeclarationBlocks,
    }),
    disposition: Object.freeze({
      removedSymbolsAreBreaking: removedSymbols.length > 0,
      humanReviewRequired: requiresHumanReview,
      versionDecision: requiresHumanReview
        ? 'human_required'
        : addedSymbols.length > 0
          ? 'compatible_addition'
          : 'no_surface_change',
    }),
  });
}

function isNpmNotFoundError(error) {
  if (!isRecord(error)) return false;
  const status = Number(error.status);
  const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8') : String(error.stderr ?? '');
  const message = String(error.message ?? '');
  return status === 404 || /\bE404\b|(?:\bHTTP\s*)?404\b/iu.test(`${stderr}\n${message}`);
}

function npmInvocation(args, env) {
  return resolveWindowsCommandInvocation({
    command: 'npm',
    args,
    env,
    resolveCommandOnPath: true,
  });
}

async function queryPublicationTimes({ packageName, repositoryRoot, env }) {
  const invocation = npmInvocation(['view', packageName, 'time', '--json'], env);
  let output;
  try {
    output = execFileSync(invocation.command, invocation.args, {
      cwd: repositoryRoot,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
  } catch (error) {
    if (isNpmNotFoundError(error)) return {};
    throw error;
  }
  try {
    const parsed = JSON.parse(String(output ?? ''));
    if (!isRecord(parsed)) throw new Error('npm returned a non-object time record');
    return parsed;
  } catch (error) {
    throw new Error(`Unable to parse npm publication times for ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeReleaseChannel(value) {
  const releaseChannel = normalizePublicReleaseChannel(value);
  if (!releaseChannel) {
    throw new Error('Public API release channel must be stable, preview, or dev');
  }
  return releaseChannel;
}

function versionBelongsToReleaseChannel(version, releaseChannel) {
  if (releaseChannel === 'stable') {
    return !version.includes('-') && !version.includes('+');
  }
  const suffix = resolveRollingReleaseTagSuffix(releaseChannel).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^[0-9]+\\.[0-9]+\\.[0-9]+-${suffix}\\.[1-9][0-9]*(?:\\.[1-9][0-9]*)?$`, 'u').test(version);
}

function resolveCandidateReleaseChannel(candidateVersion, requestedReleaseChannel) {
  if (requestedReleaseChannel !== undefined) return normalizeReleaseChannel(requestedReleaseChannel);
  for (const channelLabel of listPublicReleaseChannelInputLabels()) {
    const releaseChannel = normalizePublicReleaseChannel(channelLabel);
    if (releaseChannel && versionBelongsToReleaseChannel(candidateVersion, releaseChannel)) {
      return releaseChannel;
    }
  }
  throw new Error(`Candidate version does not identify a public release channel: ${candidateVersion}`);
}

function selectPreviousPublishedVersion(publicationTimes, candidateVersion, releaseChannel) {
  if (!isRecord(publicationTimes)) throw new Error('npm publication times must be an object');
  const candidates = [];
  for (const [version, publishedAt] of Object.entries(publicationTimes)) {
    if (
      version === candidateVersion
      || !NPM_SEMVER.test(version)
      || !versionBelongsToReleaseChannel(version, releaseChannel)
    ) continue;
    const time = Date.parse(String(publishedAt ?? ''));
    if (!Number.isFinite(time)) {
      throw new Error(`npm publication time for ${version} is invalid`);
    }
    candidates.push({ version, time });
  }
  candidates.sort((left, right) => right.time - left.time || right.version.localeCompare(left.version));
  return candidates.at(0)?.version ?? null;
}

async function downloadPublishedTarball({ packageName, version, destinationDir, repositoryRoot, env }) {
  const invocation = npmInvocation([
    'pack',
    `${packageName}@${version}`,
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    destinationDir,
  ], env);
  const output = execFileSync(invocation.command, invocation.args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 2 * 60_000,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  const { tgzPath } = resolvePackedTarball(output, {
    cwd: destinationDir,
    sourceLabel: `previous published tarball for ${packageName}@${version}`,
  });
  if (!pathIsInside(destinationDir, tgzPath)) {
    throw new Error('npm pack returned a previous published tarball outside its owned directory');
  }
  const stats = await lstat(tgzPath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw new Error('npm pack did not create a regular previous published tarball');
  }
  return tgzPath;
}

async function runRepositoryApiGovernance({ repositoryRoot, options }) {
  const ownerPath = join(resolve(repositoryRoot), 'scripts', 'api-governance', 'apiGovernance.mjs');
  const owner = await import(pathToFileURL(ownerPath).href);
  if (typeof owner.runApiGovernance !== 'function') {
    throw new Error(`Public API governance owner is unavailable: ${ownerPath}`);
  }
  return owner.runApiGovernance(options);
}

/**
 * Resolves history only from a registry tarball, never from an already
 * generated workspace record. The caller must invoke `cleanup()` after it has
 * passed the inventory to the canonical governance owner.
 */
export async function resolvePreviousPublishedApiInventory({
  packageName: packageNameInput,
  candidateVersion: candidateVersionInput,
  releaseChannel: releaseChannelInput,
  repositoryRoot,
  env = process.env,
  queryPublicationTimesImpl = queryPublicationTimes,
  downloadPublishedTarballImpl = downloadPublishedTarball,
  extractArchivePayloadToDirectoryImpl = extractArchivePayloadToDirectory,
}) {
  const packageName = normalizePackageName(packageNameInput);
  const candidateVersion = candidateVersionInput === null
    ? null
    : normalizePublishedVersion(candidateVersionInput, 'Candidate version');
  const releaseChannel = normalizeReleaseChannel(releaseChannelInput);
  const resolvedRepositoryRoot = resolve(repositoryRoot);
  const publicationTimes = await queryPublicationTimesImpl({
    packageName,
    repositoryRoot: resolvedRepositoryRoot,
    env,
  });
  const previousVersion = selectPreviousPublishedVersion(publicationTimes, candidateVersion, releaseChannel);
  if (previousVersion === null) {
    return Object.freeze({
      previousVersion: null,
      previousInventoryPath: null,
      previousDeclarationsPath: null,
      cleanup: async () => {},
    });
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'happier-public-api-history-'));
  try {
    const tarballPath = await downloadPublishedTarballImpl({
      packageName,
      version: previousVersion,
      destinationDir: temporaryRoot,
      repositoryRoot: resolvedRepositoryRoot,
      env,
    });
    if (!pathIsInside(temporaryRoot, tarballPath)) {
      throw new Error('Previous published tarball must stay under its owned temporary directory');
    }
    const extractDir = join(temporaryRoot, 'extract');
    await extractArchivePayloadToDirectoryImpl({
      archivePath: tarballPath,
      archiveName: basename(tarballPath),
      extractDir,
    });
    const extractedPackageRoot = join(extractDir, 'package');
    const manifest = JSON.parse(await readRegularUtf8(join(extractedPackageRoot, 'package.json'), 'Previous published package manifest'));
    if (!isRecord(manifest) || manifest.name !== packageName || manifest.version !== previousVersion) {
      throw new Error(`Previous published tarball identity did not match ${packageName}@${previousVersion}`);
    }
    const previousInventoryPath = join(extractedPackageRoot, INVENTORY_PATH);
    const previousDeclarationsPath = join(extractedPackageRoot, DECLARATION_PATH);
    await readInventory(previousInventoryPath, 'Previous published API inventory');
    await readRegularUtf8(previousDeclarationsPath, 'Previous published declaration record');
    return Object.freeze({
      previousVersion,
      previousInventoryPath,
      previousDeclarationsPath,
      cleanup: async () => {
        await rm(temporaryRoot, { recursive: true, force: true });
      },
    });
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Produces the mechanical API comparison used to inform editorial/version
 * approval. It deliberately verifies already-generated source records rather
 * than inventing a proposed release version or rewriting the shared worktree.
 */
export async function analyzeCurrentPublicApiForEditorial({
  profileId,
  packageName: packageNameInput,
  packageRoot,
  sourceVersion: sourceVersionInput,
  releaseChannel: releaseChannelInput,
  repositoryRoot = packageRoot,
  env = process.env,
  verifyCurrentRecords = true,
  resolvePreviousPublishedInventoryImpl = resolvePreviousPublishedApiInventory,
  runApiGovernanceImpl,
}) {
  const packageName = normalizePackageName(packageNameInput);
  const sourceVersion = normalizePublishedVersion(sourceVersionInput, 'Source package version');
  const releaseChannel = normalizeReleaseChannel(releaseChannelInput);
  const resolvedPackageRoot = resolve(packageRoot);
  const governanceInput = {
    profileId: String(profileId ?? '').trim(),
    packageRoot: resolvedPackageRoot,
    packageRootKind: 'source-complete-publication-sandbox',
    check: true,
  };
  if (!governanceInput.profileId) throw new Error('Public API governance profile id is required');
  if (verifyCurrentRecords) {
    const governanceReport = runApiGovernanceImpl
      ? await runApiGovernanceImpl(governanceInput)
      : await runRepositoryApiGovernance({ repositoryRoot, options: governanceInput });
    if (!isRecord(governanceReport) || governanceReport.status !== 'current') {
      throw new Error(`Public API governance records are not current for ${packageName}`);
    }
  }

  const baseline = await resolvePreviousPublishedInventoryImpl({
    packageName,
    candidateVersion: null,
    releaseChannel,
    repositoryRoot,
    env,
  });
  try {
    const [candidateInventory, candidateDeclarations] = await Promise.all([
      readInventory(join(resolvedPackageRoot, INVENTORY_PATH), 'Current source API inventory'),
      readRegularUtf8(join(resolvedPackageRoot, DECLARATION_PATH), 'Current source declaration record'),
    ]);
    const comparison = baseline.previousInventoryPath === null || baseline.previousDeclarationsPath === null
      ? comparePublicApiReleaseRecords({
        packageName,
        candidateVersion: sourceVersion,
        previousVersion: null,
        previousInventory: null,
        candidateInventory,
        previousDeclarations: null,
        candidateDeclarations,
      })
      : comparePublicApiReleaseRecords({
        packageName,
        candidateVersion: sourceVersion,
        previousVersion: baseline.previousVersion,
        previousInventory: await readInventory(baseline.previousInventoryPath, 'Previous published API inventory'),
        candidateInventory,
        previousDeclarations: await readRegularUtf8(baseline.previousDeclarationsPath, 'Previous published declaration record'),
        candidateDeclarations,
      });
    return Object.freeze({ sourceVersion, releaseChannel, comparison });
  } finally {
    await baseline.cleanup();
  }
}

/**
 * Runs the canonical generator against the isolated candidate package and
 * compares those records with the only allowed historical input: the previous
 * published tarball.
 */
export async function preparePublicApiGovernance({
  profileId,
  packageName: packageNameInput,
  packageRoot,
  candidateVersion: candidateVersionInput,
  releaseChannel: releaseChannelInput,
  repositoryRoot = packageRoot,
  env = process.env,
  resolvePreviousPublishedInventoryImpl = resolvePreviousPublishedApiInventory,
  runApiGovernanceImpl,
}) {
  const packageName = normalizePackageName(packageNameInput);
  const candidateVersion = normalizePublishedVersion(candidateVersionInput, 'Candidate version');
  const releaseChannel = resolveCandidateReleaseChannel(candidateVersion, releaseChannelInput);
  const resolvedPackageRoot = resolve(packageRoot);
  const baseline = await resolvePreviousPublishedInventoryImpl({
    packageName,
    candidateVersion,
    releaseChannel,
    repositoryRoot,
    env,
  });
  try {
    const governanceInput = {
      profileId: String(profileId ?? '').trim(),
      packageRoot: resolvedPackageRoot,
      packageRootKind: 'source-complete-publication-sandbox',
      write: true,
      publishedVersion: candidateVersion,
      ...(baseline.previousInventoryPath === null ? {} : {
        previousPublishedInventoryPath: baseline.previousInventoryPath,
      }),
    };
    if (!governanceInput.profileId) throw new Error('Public API governance profile id is required');
    if (runApiGovernanceImpl) {
      await runApiGovernanceImpl(governanceInput);
    } else {
      await runRepositoryApiGovernance({ repositoryRoot, options: governanceInput });
    }
    const [candidateInventory, candidateDeclarations] = await Promise.all([
      readInventory(join(resolvedPackageRoot, INVENTORY_PATH), 'Candidate API inventory'),
      readRegularUtf8(join(resolvedPackageRoot, DECLARATION_PATH), 'Candidate declaration record'),
    ]);
    if (baseline.previousInventoryPath === null || baseline.previousDeclarationsPath === null) {
      return comparePublicApiReleaseRecords({
        packageName,
        candidateVersion,
        previousVersion: null,
        previousInventory: null,
        candidateInventory,
        previousDeclarations: null,
        candidateDeclarations,
      });
    }
    const [previousInventory, previousDeclarations] = await Promise.all([
      readInventory(baseline.previousInventoryPath, 'Previous published API inventory'),
      readRegularUtf8(baseline.previousDeclarationsPath, 'Previous published declaration record'),
    ]);
    return comparePublicApiReleaseRecords({
      packageName,
      candidateVersion,
      previousVersion: baseline.previousVersion,
      previousInventory,
      candidateInventory,
      previousDeclarations,
      candidateDeclarations,
    });
  } finally {
    await baseline.cleanup();
  }
}

/** Gives pack callers a bounded, path-free release summary. */
export function summarizePublicApiReleaseComparison(report) {
  if (report.status === 'dormant_pre_baseline') {
    return Object.freeze({
      status: report.status,
      previousVersion: null,
      removedSymbolsAreBreaking: false,
      humanReviewRequired: false,
    });
  }
  return Object.freeze({
    status: report.status,
    previousVersion: report.previousVersion,
    addedSymbols: report.facts.addedSymbols.length,
    removedSymbols: report.facts.removedSymbols.length,
    deprecatedSymbols: report.facts.deprecatedSymbols.length,
    changedSymbols: report.facts.changedSymbols.length,
    changedDeclarationBlocks: report.facts.changedDeclarationBlocks.length,
    removedSymbolsAreBreaking: report.disposition.removedSymbolsAreBreaking,
    humanReviewRequired: report.disposition.humanReviewRequired,
  });
}

/** Human-oriented log output; the generated records remain the detailed diff. */
export function renderPublicApiReleaseComparison(report) {
  if (report.status === 'dormant_pre_baseline') {
    return [
      `[pipeline] public API comparison: ${report.packageName}@${report.candidateVersion} has no prior published tarball (dormant pre-baseline)`,
      '  human review required: no; no prior published baseline is available.',
      '',
    ].join('\n');
  }
  const facts = report.facts;
  return [
    `[pipeline] public API comparison: ${report.packageName}@${report.candidateVersion} vs ${report.previousVersion}`,
    `  added=${facts.addedSymbols.length} removed=${facts.removedSymbols.length} deprecated=${facts.deprecatedSymbols.length} changed-symbols=${facts.changedSymbols.length} changed-declaration-blocks=${facts.changedDeclarationBlocks.length}`,
    ...(facts.removedSymbols.length > 0 ? [`  removed (breaking): ${facts.removedSymbols.join(', ')}`] : []),
    ...(facts.changedDeclarationBlocks.length > 0 ? [`  declaration review: ${renderDeclarationDiffSample(facts.changedDeclarationBlocks).join(', ')}`] : []),
    `  human review required: ${report.disposition.humanReviewRequired ? 'yes' : 'no'}; compatibility classification and version selection remain human release decisions.`,
    '',
  ].join('\n');
}
