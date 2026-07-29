import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, test } from 'vitest';

type RuntimeSchema = Readonly<{
  safeParse(value: unknown): Readonly<{ success: boolean }>;
}>;

type RuntimeEnumSchema = RuntimeSchema & Readonly<{
  options: readonly string[];
}>;

type RuntimeActivityProtocolModule = Readonly<{
  SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX: number;
  SessionRuntimeActivityStateSchema?: RuntimeEnumSchema;
  SessionRuntimeActivitySnapshotSchema?: RuntimeSchema;
  SessionRuntimeActivityProjectionSchema?: RuntimeSchema;
  decideRuntimeIdleAdmission(projection: unknown): unknown;
}>;

type ProjectionValue = Readonly<{
  state: string;
  activeCount: number;
  observedAt: number | null;
  revision: number;
}>;

type FixtureCase<T> = Readonly<{
  id: string;
  value: T;
}>;

type PrismaFieldFingerprint = Readonly<{
  name: string;
  type: string;
  nullable: boolean;
  default: string | number | null;
}>;

type RuntimeActivityParityFixture = Readonly<{
  contract: 'runtime-activity-projection-v1';
  states: readonly string[];
  activeCountMax: number;
  snapshotFields: readonly string[];
  projectionFields: readonly string[];
  prismaSessionFields: readonly PrismaFieldFingerprint[];
  semanticCas: Readonly<{
    compareFields: readonly string[];
    expectedRevisionPrecondition: 'exact_current_revision';
    duplicateSnapshot: Readonly<{
      decision: 'unchanged';
      revision: 'preserve';
      observedAt: 'preserve';
    }>;
    changedSnapshot: Readonly<{
      decision: 'applied';
      revision: 'increment_by_one';
      observedAt: 'server_stamped_for_revision';
    }>;
  }>;
  validSnapshots: readonly FixtureCase<Readonly<Record<string, unknown>>>[];
  invalidSnapshots: readonly FixtureCase<Readonly<Record<string, unknown>>>[];
  validProjections: readonly FixtureCase<ProjectionValue>[];
  invalidProjections: readonly FixtureCase<Readonly<Record<string, unknown>>>[];
  admissionCases: readonly Readonly<{
    id: string;
    projection: ProjectionValue;
    expected: Readonly<Record<string, unknown>>;
  }>[];
}>;

const testFile = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(testFile), '../../../..');
const fixtureRelativePath = 'packages/tests/fixtures/runtime-activity/projection-v1.json';
const fixturePath = resolve(repoRoot, fixtureRelativePath);
const fixtureExists = existsSync(fixturePath);

function readNormalizedFixture(path: string): Readonly<{
  raw: string;
  parsed: RuntimeActivityParityFixture;
  normalized: string;
}> {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as RuntimeActivityParityFixture;
  return { raw, parsed, normalized: `${JSON.stringify(parsed, null, 2)}\n` };
}

async function loadLocalProtocolModule(): Promise<RuntimeActivityProtocolModule> {
  const devOwnerPath = resolve(
    repoRoot,
    'packages/protocol/src/sessions/runtime/activity/sessionRuntimeActivity.ts',
  );
  const remoteProjectionPath = resolve(
    repoRoot,
    'packages/protocol/src/sessionRuntimeActivity/projection.ts',
  );
  const hasDevTopology = existsSync(devOwnerPath);
  const hasRemoteTopology = existsSync(remoteProjectionPath);
  if (hasDevTopology === hasRemoteTopology) {
    throw new Error('Runtime Activity topology is missing or ambiguous');
  }
  if (hasDevTopology) {
    return await import(pathToFileURL(devOwnerPath).href) as RuntimeActivityProtocolModule;
  }
  const remoteAdmissionPath = resolve(
    repoRoot,
    'packages/protocol/src/sessionRuntimeActivity/admission.ts',
  );
  if (!existsSync(remoteAdmissionPath)) {
    throw new Error('Remote Runtime Activity admission owner not found');
  }
  const projectionModule = await import(
    pathToFileURL(remoteProjectionPath).href
  ) as Partial<RuntimeActivityProtocolModule>;
  const admissionModule = await import(
    pathToFileURL(remoteAdmissionPath).href
  ) as Partial<RuntimeActivityProtocolModule>;
  return { ...projectionModule, ...admissionModule } as RuntimeActivityProtocolModule;
}

function requireExport<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Missing local Runtime Activity export: ${name}`);
  return value;
}

function readSessionModel(schemaSource: string): string {
  const modelStart = schemaSource.indexOf('model Session {');
  if (modelStart < 0) throw new Error('Prisma Session model not found');
  const bodyStart = schemaSource.indexOf('{', modelStart) + 1;
  let depth = 1;
  for (let index = bodyStart; index < schemaSource.length; index += 1) {
    if (schemaSource[index] === '{') depth += 1;
    if (schemaSource[index] === '}') depth -= 1;
    if (depth === 0) return schemaSource.slice(bodyStart, index);
  }
  throw new Error('Prisma Session model is not closed');
}

function normalizeDefault(rawDefault: string | undefined): string | number | null {
  if (rawDefault === undefined) return null;
  const unquoted = rawDefault.replace(/^"|"$/g, '');
  const numeric = Number(unquoted);
  return Number.isFinite(numeric) ? numeric : unquoted;
}

function readPrismaRuntimeActivityFingerprint(schemaPath: string): PrismaFieldFingerprint[] {
  const sessionModel = readSessionModel(readFileSync(schemaPath, 'utf8'));
  return sessionModel
    .split('\n')
    .map((line): PrismaFieldFingerprint | null => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('runtimeActivity')) return null;
      const [name, rawType] = trimmed.split(/\s+/);
      const defaultMatch = trimmed.match(/@default\(([^)]+)\)/);
      return {
        name,
        type: rawType.replace(/\?$/, ''),
        nullable: rawType.endsWith('?'),
        default: normalizeDefault(defaultMatch?.[1]),
      };
    })
    .filter((field): field is PrismaFieldFingerprint => field !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function resolveSiblingCheckout(): string | null {
  const explicit = process.env.HAPPIER_RUNTIME_ACTIVITY_PARITY_SIBLING;
  if (explicit) return resolve(explicit);
  const siblingName = basename(repoRoot) === 'remote-dev' ? 'dev' : 'remote-dev';
  const candidate = resolve(repoRoot, '..', siblingName);
  return existsSync(resolve(candidate, fixtureRelativePath)) ? candidate : null;
}

test('checks in the canonical Runtime Activity projection parity fixture', () => {
  expect(fixtureExists).toBe(true);
});

describe.runIf(fixtureExists)('Runtime Activity projection parity contract', () => {
  test('keeps fixture bytes normalized and matches the sibling checkout contract fingerprint', () => {
    const local = readNormalizedFixture(fixturePath);
    expect(local.raw).toBe(local.normalized);

    const siblingCheckout = resolveSiblingCheckout();
    if (siblingCheckout === null) return;

    const sibling = readNormalizedFixture(resolve(siblingCheckout, fixtureRelativePath));
    expect(sibling.raw).toBe(sibling.normalized);
    expect(sibling.normalized).toBe(local.normalized);
    expect({
      states: sibling.parsed.states,
      activeCountMax: sibling.parsed.activeCountMax,
      snapshotFields: sibling.parsed.snapshotFields,
      projectionFields: sibling.parsed.projectionFields,
      prismaSessionFields: sibling.parsed.prismaSessionFields,
      semanticCas: sibling.parsed.semanticCas,
    }).toEqual({
      states: local.parsed.states,
      activeCountMax: local.parsed.activeCountMax,
      snapshotFields: local.parsed.snapshotFields,
      projectionFields: local.parsed.projectionFields,
      prismaSessionFields: local.parsed.prismaSessionFields,
      semanticCas: local.parsed.semanticCas,
    });
  });

  test('matches the local canonical protocol schemas and rejects divergent value semantics', async () => {
    const fixture = readNormalizedFixture(fixturePath).parsed;
    const protocol = await loadLocalProtocolModule();
    const stateSchema = requireExport(protocol.SessionRuntimeActivityStateSchema, 'state schema');
    const snapshotSchema = requireExport(protocol.SessionRuntimeActivitySnapshotSchema, 'snapshot schema');
    const projectionSchema = requireExport(protocol.SessionRuntimeActivityProjectionSchema, 'projection schema');

    expect(fixture.contract).toBe('runtime-activity-projection-v1');
    expect(fixture.snapshotFields).toEqual(['state', 'activeCount']);
    expect(fixture.projectionFields).toEqual([
      'state',
      'activeCount',
      'observedAt',
      'revision',
    ]);
    expect(fixture.semanticCas).toEqual({
      compareFields: ['state', 'activeCount'],
      expectedRevisionPrecondition: 'exact_current_revision',
      duplicateSnapshot: {
        decision: 'unchanged',
        revision: 'preserve',
        observedAt: 'preserve',
      },
      changedSnapshot: {
        decision: 'applied',
        revision: 'increment_by_one',
        observedAt: 'server_stamped_for_revision',
      },
    });
    expect(stateSchema.options).toEqual(fixture.states);
    expect(protocol.SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX).toBe(fixture.activeCountMax);

    for (const fixtureCase of fixture.validSnapshots) {
      expect(Object.keys(fixtureCase.value)).toEqual(fixture.snapshotFields);
      expect(snapshotSchema.safeParse(fixtureCase.value).success, fixtureCase.id).toBe(true);
    }
    for (const fixtureCase of fixture.invalidSnapshots) {
      expect(snapshotSchema.safeParse(fixtureCase.value).success, fixtureCase.id).toBe(false);
    }
    for (const fixtureCase of fixture.validProjections) {
      expect(Object.keys(fixtureCase.value)).toEqual(fixture.projectionFields);
      expect(projectionSchema.safeParse(fixtureCase.value).success, fixtureCase.id).toBe(true);
    }
    for (const fixtureCase of fixture.invalidProjections) {
      expect(projectionSchema.safeParse(fixtureCase.value).success, fixtureCase.id).toBe(false);
    }
    for (const fixtureCase of fixture.admissionCases) {
      expect(protocol.decideRuntimeIdleAdmission(fixtureCase.projection), fixtureCase.id)
        .toEqual(fixtureCase.expected);
    }
  });

  test('matches the normalized final Session Prisma projection on every local provider', () => {
    const fixture = readNormalizedFixture(fixturePath).parsed;
    const schemaPaths = [
      'apps/server/prisma/schema.prisma',
      'apps/server/prisma/mysql/schema.prisma',
      'apps/server/prisma/sqlite/schema.prisma',
      'apps/server/generated/mysql-client/schema.prisma',
      'apps/server/generated/sqlite-client/schema.prisma',
    ];

    for (const schemaRelativePath of schemaPaths) {
      expect(
        readPrismaRuntimeActivityFingerprint(resolve(repoRoot, schemaRelativePath)),
        schemaRelativePath,
      ).toEqual(fixture.prismaSessionFields);
    }
  });
});
