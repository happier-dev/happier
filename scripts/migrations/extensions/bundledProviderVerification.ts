import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type JsonRecord = Readonly<Record<string, unknown>>;
type BuildQualifiedContributionKey = (
  identity: Readonly<{ pluginId: string; localId: string }>,
) => string;

type FirstPartyProviderVerificationSourceV1 = Readonly<{
  id: string;
  kind: 'official-doc' | 'repository-history' | 'product-decision';
  url?: string;
  locator?: string;
  accessedAt: string;
  revision: string;
}>;

type FirstPartyProviderVerificationFactV1 = Readonly<{
  path: string;
  sourceIds: readonly string[];
  status: 'verified' | 'experimental';
}>;

export type FirstPartyProviderVerificationV1 = Readonly<{
  v: 1;
  contributionKey: string;
  reviewedAt: string;
  sources: readonly FirstPartyProviderVerificationSourceV1[];
  facts: readonly FirstPartyProviderVerificationFactV1[];
}>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: JsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readRecordArray(record: JsonRecord, key: string): readonly JsonRecord[] {
  const value = record[key];
  return Array.isArray(value) && value.every(isRecord) ? value : [];
}

function addPath(paths: Set<string>, path: string, condition = true): void {
  if (condition) paths.add(path);
}

/**
 * Projects the official/external claims in a Provider contribution into stable
 * semantic paths. The paths identify facts but deliberately do not copy their
 * executable values into the evidence artifact.
 */
export function collectProviderExecutableFactPathsV1(contribution: unknown): readonly string[] {
  if (!isRecord(contribution)) throw new Error('Provider contribution must be an object');
  const paths = new Set<string>();
  addPath(paths, 'kind', typeof contribution.kind === 'string');
  addPath(paths, 'websiteUrl', typeof contribution.websiteUrl === 'string');

  for (const endpoint of readRecordArray(contribution, 'endpointTemplates')) {
    const id = readString(endpoint, 'id');
    if (!id) throw new Error('Provider endpoint template is missing an id');
    const prefix = `endpointTemplates.${id}`;
    addPath(paths, `${prefix}.protocol`, typeof endpoint.protocol === 'string');
    addPath(paths, `${prefix}.baseUrl`, typeof endpoint.baseUrl === 'string');
    addPath(paths, `${prefix}.localUrlCandidates`, Array.isArray(endpoint.localUrlCandidates));
    if (isRecord(endpoint.publicHeaders)) {
      for (const name of Object.keys(endpoint.publicHeaders)) addPath(paths, `${prefix}.publicHeaders.${name.toLowerCase()}`);
    }
    if (isRecord(endpoint.capabilities)) {
      for (const capability of Object.keys(endpoint.capabilities)) {
        if (endpoint.capabilities[capability] !== 'unknown') addPath(paths, `${prefix}.capabilities.${capability}`);
      }
    }
  }

  if (isRecord(contribution.credential)) {
    addPath(paths, 'credential.kind');
    addPath(paths, 'credential.required', typeof contribution.credential.required === 'boolean');
    addPath(paths, 'credential.keyUrl', typeof contribution.credential.keyUrl === 'string');
    for (const transport of readRecordArray(contribution.credential, 'transports')) {
      const id = readString(transport, 'id');
      if (!id) throw new Error('Provider credential transport is missing an id');
      addPath(paths, `credential.transports.${id}`);
    }
  }

  if (isRecord(contribution.catalog)) {
    addPath(paths, 'catalog.source', typeof contribution.catalog.source === 'string');
    for (const model of readRecordArray(contribution.catalog, 'staticModels')) {
      const id = readString(model, 'id');
      if (!id) throw new Error('Provider static model is missing an id');
      addPath(paths, `catalog.staticModels.${id}`);
    }
    for (const probe of readRecordArray(contribution.catalog, 'probes')) {
      const endpointId = readString(probe, 'endpointTemplateId');
      const parser = readString(probe, 'parser');
      if (!endpointId || !parser) throw new Error('Provider catalog probe is incomplete');
      addPath(paths, `catalog.probes.${endpointId}.${parser}`);
    }
  }

  if (isRecord(contribution.discovery)) {
    for (const key of ['listener', 'availabilityProbe', 'installedCheck', 'presenceCheck', 'catalogFallback', 'managedStart']) {
      addPath(paths, `discovery.${key}`, contribution.discovery[key] !== undefined);
    }
  }
  addPath(paths, 'modelLoad', isRecord(contribution.modelLoad));

  for (const override of readRecordArray(contribution, 'compatibilityOverrides')) {
    const agentTargetKey = readString(override, 'agentTargetKey');
    const protocol = readString(override, 'protocol');
    if (!agentTargetKey || !protocol) throw new Error('Provider compatibility override is incomplete');
    addPath(paths, `compatibilityOverrides.${agentTargetKey}.${protocol}`);
  }

  for (const migration of readRecordArray(contribution, 'legacyProfileMigrations')) {
    const sourceProfileId = readString(migration, 'sourceProfileId');
    if (!sourceProfileId) throw new Error('Provider legacy migration is missing a source profile id');
    const prefix = `legacyProfileMigrations.${sourceProfileId}`;
    addPath(paths, `${prefix}.descriptorRevision`, typeof migration.descriptorRevision === 'number');
    for (const replacement of readRecordArray(migration, 'implicitModelAliasReplacements')) {
      const legacyModelId = readString(replacement, 'legacyModelId');
      if (!legacyModelId) throw new Error('Provider implicit model alias replacement is incomplete');
      addPath(paths, `${prefix}.implicitModelAliasReplacements.${legacyModelId}`);
    }
    addPath(paths, `${prefix}.credentialBinding`, isRecord(migration.credentialBinding));
    addPath(paths, `${prefix}.primaryModel`, isRecord(migration.primaryModel));
    for (const key of ['migratedEnvironmentVariables', 'retainedEnvironmentVariables']) {
      for (const entry of readRecordArray(migration, key)) {
        const name = readString(entry, 'name');
        if (!name) throw new Error('Provider legacy environment disposition is missing a name');
        addPath(paths, `${prefix}.${key}.${name}`);
      }
    }
  }

  return [...paths].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function parseCanonicalDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) throw new Error(`${field} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a real UTC calendar date`);
  }
  return value;
}

function assertNoExecutableFactCopies(record: JsonRecord): void {
  const forbidden = [
    'endpointTemplates', 'credential', 'catalog', 'discovery', 'modelLoad',
    'compatibilityOverrides', 'legacyProfileMigrations', 'value', 'expectedValue', 'claim',
  ];
  if (forbidden.some((key) => Object.prototype.hasOwnProperty.call(record, key))) {
    throw new Error('Provider verification must not restate executable Provider facts');
  }
}

export function assertBundledProviderVerificationV1(input: Readonly<{
  buildQualifiedContributionKey: BuildQualifiedContributionKey;
  pluginId: string;
  contribution: unknown;
  verification: unknown;
  todayUtc: string;
}>): FirstPartyProviderVerificationV1 {
  if (!isRecord(input.contribution) || !isRecord(input.verification)) {
    throw new Error('Provider contribution and verification must be objects');
  }
  assertNoExecutableFactCopies(input.verification);
  const contributionId = readString(input.contribution, 'id');
  const expectedKey = contributionId
    ? input.buildQualifiedContributionKey({
        pluginId: input.pluginId,
        localId: contributionId,
      })
    : null;
  if (!expectedKey || input.verification.contributionKey !== expectedKey) {
    throw new Error(`Provider verification contributionKey must equal '${String(expectedKey)}'`);
  }
  if (input.verification.v !== 1) throw new Error('Provider verification must use v1');
  const todayUtc = parseCanonicalDate(input.todayUtc, 'todayUtc');
  const reviewedAt = parseCanonicalDate(input.verification.reviewedAt, 'reviewedAt');
  if (reviewedAt > todayUtc) throw new Error('Provider verification review date is in the future');

  const rawSources = readRecordArray(input.verification, 'sources');
  if (rawSources.length === 0) throw new Error('Provider verification requires evidence sources');
  const sources: FirstPartyProviderVerificationSourceV1[] = [];
  const sourceIds = new Set<string>();
  for (const source of rawSources) {
    assertNoExecutableFactCopies(source);
    const id = readString(source, 'id');
    const kind = source.kind;
    const url = readString(source, 'url');
    const locator = readString(source, 'locator');
    const revision = readString(source, 'revision');
    const accessedAt = parseCanonicalDate(source.accessedAt, 'sources.accessedAt');
    if (!id || sourceIds.has(id)) throw new Error('Provider verification source ids must be unique and non-empty');
    if (kind !== 'official-doc' && kind !== 'repository-history' && kind !== 'product-decision') {
      throw new Error('Provider verification sources require a recognized kind');
    }
    if (kind === 'official-doc' && (!url || !url.startsWith('https://'))) {
      throw new Error('Official Provider verification sources must use HTTPS');
    }
    if (kind !== 'official-doc' && (!locator || locator.startsWith('/') || locator.includes('..'))) {
      throw new Error('Repository and product Provider evidence requires a canonical repository locator');
    }
    if (kind !== 'official-doc' && url !== null) {
      throw new Error('Repository and product Provider evidence must not invent a public URL');
    }
    if (!revision) throw new Error('Provider verification sources require a revision');
    if (accessedAt > reviewedAt || accessedAt > todayUtc) throw new Error('Provider verification source date is in the future');
    sourceIds.add(id);
    sources.push({
      id,
      kind,
      ...(url ? { url } : {}),
      ...(locator ? { locator } : {}),
      accessedAt,
      revision,
    });
  }

  const rawFacts = readRecordArray(input.verification, 'facts');
  const facts: FirstPartyProviderVerificationFactV1[] = [];
  const factPaths = new Set<string>();
  for (const fact of rawFacts) {
    assertNoExecutableFactCopies(fact);
    const path = readString(fact, 'path');
    const status = fact.status;
    const factSourceIds = Array.isArray(fact.sourceIds)
      ? fact.sourceIds.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : [];
    if (!path || factPaths.has(path)) throw new Error(`Duplicate Provider verification path '${String(path)}'`);
    if (status !== 'verified' && status !== 'experimental') throw new Error(`Invalid Provider verification status at '${path}'`);
    if (status === 'experimental' && path.startsWith('legacyProfileMigrations.')) {
      throw new Error(`Automatic Provider migration fact '${path}' must be verified`);
    }
    if (factSourceIds.length === 0 || new Set(factSourceIds).size !== factSourceIds.length) {
      throw new Error(`Provider verification path '${path}' must reference unique evidence sources`);
    }
    for (const sourceId of factSourceIds) {
      if (!sourceIds.has(sourceId)) throw new Error(`Provider verification path '${path}' references unknown evidence source '${sourceId}'`);
    }
    factPaths.add(path);
    facts.push({ path, sourceIds: factSourceIds, status });
  }

  const expectedPaths = collectProviderExecutableFactPathsV1(input.contribution);
  for (const path of expectedPaths) {
    if (!factPaths.has(path)) throw new Error(`Missing Provider verification for '${expectedKey}:${path}'`);
  }
  const expectedPathSet = new Set(expectedPaths);
  for (const path of factPaths) {
    if (!expectedPathSet.has(path)) throw new Error(`Orphaned Provider verification for '${expectedKey}:${path}'`);
  }

  return { v: 1, contributionKey: expectedKey, reviewedAt, sources, facts };
}

export function readAndAssertBundledProviderVerificationsV1(input: Readonly<{
  buildQualifiedContributionKey: BuildQualifiedContributionKey;
  rootDir: string;
  pluginPackageId: string;
  pluginId: string;
  contributions: readonly unknown[];
  todayUtc: string;
}>): readonly FirstPartyProviderVerificationV1[] {
  const directory = resolve(
    input.rootDir,
    'packages/plugins',
    input.pluginPackageId,
    'src/provider/verification',
  );
  const records = existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => {
        const path = resolve(directory, entry.name);
        try {
          return JSON.parse(readFileSync(path, 'utf8')) as unknown;
        } catch (error) {
          throw new Error(`Invalid Provider verification JSON '${path}': ${error instanceof Error ? error.message : String(error)}`);
        }
      })
    : [];
  const recordsByKey = new Map<string, unknown>();
  for (const record of records) {
    const contributionKey = isRecord(record) ? readString(record, 'contributionKey') : null;
    if (!contributionKey) throw new Error('Provider verification record is missing contributionKey');
    if (recordsByKey.has(contributionKey)) throw new Error(`Duplicate Provider verification record '${contributionKey}'`);
    recordsByKey.set(contributionKey, record);
  }

  const accepted: FirstPartyProviderVerificationV1[] = [];
  const expectedKeys = new Set<string>();
  for (const contribution of input.contributions) {
    const contributionId = isRecord(contribution) ? readString(contribution, 'id') : null;
    if (!contributionId) throw new Error(`Invalid Provider contribution in '${input.pluginPackageId}'`);
    const key = input.buildQualifiedContributionKey({
      pluginId: input.pluginId,
      localId: contributionId,
    });
    expectedKeys.add(key);
    const verification = recordsByKey.get(key);
    if (!verification) throw new Error(`Missing Provider verification record '${key}'`);
    accepted.push(assertBundledProviderVerificationV1({
      buildQualifiedContributionKey: input.buildQualifiedContributionKey,
      pluginId: input.pluginId,
      contribution,
      verification,
      todayUtc: input.todayUtc,
    }));
  }
  for (const key of recordsByKey.keys()) {
    if (!expectedKeys.has(key)) throw new Error(`Orphaned Provider verification record '${key}'`);
  }
  return accepted;
}
