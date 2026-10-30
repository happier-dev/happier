import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACCOUNT_SESSION_READ_STATE_BACKFILL_MIGRATION,
  ACCOUNT_SESSION_READ_STATE_BACKFILL_PATHS,
  QUALIFIED_CONNECTED_ACCOUNTS_V4_ACTIVATION_MIGRATION,
  QUALIFIED_CONNECTED_ACCOUNTS_V4_ACTIVATION_PATHS,
  QUALIFIED_CONNECTED_ACCOUNTS_V4_ROLLBACK_SUPPORT,
  evaluateQualifiedConnectedAccountsV4ActivationAdmission,
  evaluateQualifiedConnectedAccountsV4PayloadPublicationAdmission,
} from './qualified-connected-accounts-v4-activation-admission.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const checkerPath = resolve(
  repoRoot,
  'scripts/release/qualified-connected-accounts-v4-activation-admission.mjs',
);
const absent = Object.fromEntries(
  QUALIFIED_CONNECTED_ACCOUNTS_V4_ACTIVATION_PATHS.map(({ provider }) => [provider, false]),
);
const present = Object.fromEntries(
  QUALIFIED_CONNECTED_ACCOUNTS_V4_ACTIVATION_PATHS.map(({ provider }) => [provider, true]),
);
const rollbackSupportPresent = Object.freeze({
  qualifiedAccountsV4: true,
  qualifiedConfigurationKind9: true,
  sessionMetadataLayout1Kind26: true,
  publicManagedProviderRuntime: true,
});
const rollbackSupportAbsent = Object.fromEntries(
  QUALIFIED_CONNECTED_ACCOUNTS_V4_ROLLBACK_SUPPORT
    .map(({ key }) => [key, false]),
);

test('qualified V4 activation admission names the migration in every database tree', async () => {
  assert.deepEqual(
    QUALIFIED_CONNECTED_ACCOUNTS_V4_ACTIVATION_PATHS.map(({ provider }) => provider),
    ['postgresql', 'mysql', 'sqlite'],
  );
  await Promise.all(
    QUALIFIED_CONNECTED_ACCOUNTS_V4_ACTIVATION_PATHS.map(({ path }) =>
      access(resolve(repoRoot, path)),
    ),
  );
});

test('qualified V4 activation admission pins current envelope reader, exact kind bytes, and custody capability evidence', async () => {
  assert.deepEqual(
    Object.fromEntries(
      QUALIFIED_CONNECTED_ACCOUNTS_V4_ROLLBACK_SUPPORT.map(({ key, checks }) => [
        key,
        checks.map(({ path, content, absent: expectedAbsent }) => ({
          path,
          content,
          absent: expectedAbsent === true,
        })),
      ]),
    ),
    {
      qualifiedAccountsV4: [
        {
          path: 'packages/protocol/src/connect/qualifiedConnectedAccountsV4.ts',
          content: 'export const CONNECTED_ACCOUNT_V4_PROTOCOL_VERSION = 4 as const;',
          absent: false,
        },
        {
          path: 'apps/cli/src/api/client/qualifiedConnectedAccountApi.ts',
          content: 'export async function listQualifiedConnectedAccountsV4',
          absent: false,
        },
      ],
      qualifiedConfigurationKind9: [
        {
          path: 'packages/protocol/src/crypto/accountScopedCipherEnvelope.ts',
          content: 'qualified_connected_account_configuration: 9,',
          absent: false,
        },
      ],
      sessionMetadataLayout1Kind26: [
        {
          path: 'packages/protocol/src/crypto/accountScopedCipherEnvelope.ts',
          content: 'session_owner_metadata: 26,',
          absent: false,
        },
        {
          path: 'packages/protocol/src/sessions/metadata/sessionMetadataSchemasV1.ts',
          content: 'export const SESSION_METADATA_LAYOUT_VERSION_V1 = 1 as const;',
          absent: false,
        },
        {
          path: 'apps/cli/src/session/metadata/sessionMetadataLayout.ts',
          content: 'if (layoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1) return null;',
          absent: false,
        },
      ],
      publicManagedProviderRuntime: [
        {
          path: 'apps/cli/src/providers/lifecycle/publicManagedProviderRuntimeStart.ts',
          content: 'export async function startPublicManagedProviderRuntime',
          absent: false,
        },
        {
          path: 'apps/cli/src/daemon/startup/startDaemonSessionControlRuntime.ts',
          content: "'sessionDemand' as const,",
          absent: false,
        },
        {
          path: 'apps/cli/src/providers/lifecycle/managedEndpointRecovery.ts',
          content: undefined,
          absent: true,
        },
        {
          path: 'apps/cli/src/providers/discovery/managedStart.ts',
          content: undefined,
          absent: true,
        },
      ],
    },
  );

  for (const { key, checks } of QUALIFIED_CONNECTED_ACCOUNTS_V4_ROLLBACK_SUPPORT) {
    for (const { path, content, absent: expectedAbsent } of checks) {
      if (expectedAbsent === true) {
        await assert.rejects(
          readFile(resolve(repoRoot, path), 'utf8'),
          (error) => error?.code === 'ENOENT',
          `expected retired predecessor path ${path} to be absent`,
        );
      } else {
        const source = await readFile(resolve(repoRoot, path), 'utf8');
        assert.ok(
          source.includes(content),
          `expected ${key} rollback capability evidence in ${path}`,
        );
      }
    }
  }
});

test('qualified V4 activation admission requires explicit release approval for the first promoted activation', () => {
  assert.throws(
    () => evaluateQualifiedConnectedAccountsV4ActivationAdmission({
      baselinePresence: absent,
      candidatePresence: present,
      baselineRollbackSupport: rollbackSupportAbsent,
      candidateRollbackSupport: rollbackSupportPresent,
      approved: false,
      approvalSource: 'release-confirm',
    }),
    (error) => {
      assert.match(error.message, new RegExp(QUALIFIED_CONNECTED_ACCOUNTS_V4_ACTIVATION_MIGRATION));
      assert.match(error.message, /backup.+restore readiness/i);
      assert.match(error.message, /old-server rollback.+prohibited/i);
      return true;
    },
  );

  assert.deepEqual(
    evaluateQualifiedConnectedAccountsV4ActivationAdmission({
      baselinePresence: absent,
      candidatePresence: present,
      baselineRollbackSupport: rollbackSupportAbsent,
      candidateRollbackSupport: rollbackSupportPresent,
      approved: true,
      approvalSource: 'release-confirm: release dev to preview',
    }),
    {
      status: 'activation-approved',
      migration: QUALIFIED_CONNECTED_ACCOUNTS_V4_ACTIVATION_MIGRATION,
      approvalSource: 'release-confirm: release dev to preview',
      irreversible: true,
      oldServerRollbackAllowed: false,
      oldDaemonRollbackAllowed: false,
    },
  );
});

test('qualified V4 activation admission is not an ongoing gate after the deployed baseline contains the migration', () => {
  assert.deepEqual(
    evaluateQualifiedConnectedAccountsV4ActivationAdmission({
      baselinePresence: present,
      candidatePresence: present,
      baselineRollbackSupport: rollbackSupportPresent,
      candidateRollbackSupport: rollbackSupportPresent,
      approved: false,
      approvalSource: '',
    }),
    {
      status: 'already-activated',
      migration: QUALIFIED_CONNECTED_ACCOUNTS_V4_ACTIVATION_MIGRATION,
      irreversible: true,
      oldServerRollbackAllowed: false,
      oldDaemonRollbackAllowed: false,
    },
  );
});

test('qualified V4 activation admission rejects retained-migration rollback candidates that drop required old-daemon readers', () => {
  for (const missingSupport of Object.keys(rollbackSupportPresent)) {
    assert.throws(
      () => evaluateQualifiedConnectedAccountsV4ActivationAdmission({
        baselinePresence: present,
        candidatePresence: present,
        baselineRollbackSupport: rollbackSupportPresent,
        candidateRollbackSupport: {
          ...rollbackSupportPresent,
          [missingSupport]: false,
        },
        approved: true,
        approvalSource: 'test',
      }),
      new RegExp(`candidate.+${missingSupport}.+old-daemon rollback`, 'i'),
      `expected retained-migration rollback to reject missing ${missingSupport} support`,
    );
  }
});

test('qualified V4 activation admission permits a complete forward repair from a partially supported activated baseline', () => {
  assert.deepEqual(
    evaluateQualifiedConnectedAccountsV4ActivationAdmission({
      baselinePresence: present,
      candidatePresence: present,
      baselineRollbackSupport: {
        ...rollbackSupportPresent,
        publicManagedProviderRuntime: false,
      },
      candidateRollbackSupport: rollbackSupportPresent,
      approved: false,
      approvalSource: '',
    }),
    {
      status: 'already-activated',
      migration: QUALIFIED_CONNECTED_ACCOUNTS_V4_ACTIVATION_MIGRATION,
      irreversible: true,
      oldServerRollbackAllowed: false,
      oldDaemonRollbackAllowed: false,
    },
  );
});

test('qualified V4 activation admission rejects provider migration split-brain and rollback removal', () => {
  assert.throws(
    () => evaluateQualifiedConnectedAccountsV4ActivationAdmission({
      baselinePresence: absent,
      candidatePresence: { ...present, mysql: false },
      approved: true,
      approvalSource: 'test',
    }),
    /candidate.+PostgreSQL=true.+MySQL=false.+SQLite=true/i,
  );
  assert.throws(
    () => evaluateQualifiedConnectedAccountsV4ActivationAdmission({
      baselinePresence: { ...present, sqlite: false },
      candidatePresence: present,
      approved: true,
      approvalSource: 'test',
    }),
    /deployed baseline.+PostgreSQL=true.+MySQL=true.+SQLite=false/i,
  );
  assert.throws(
    () => evaluateQualifiedConnectedAccountsV4ActivationAdmission({
      baselinePresence: present,
      candidatePresence: absent,
      baselineRollbackSupport: rollbackSupportPresent,
      candidateRollbackSupport: rollbackSupportAbsent,
      approved: true,
      approvalSource: 'test',
    }),
    /removes.+old-server rollback is prohibited/i,
  );
});

test('qualified V4 activation admission ignores releases before the activation exists', () => {
  assert.deepEqual(
    evaluateQualifiedConnectedAccountsV4ActivationAdmission({
      baselinePresence: absent,
      candidatePresence: absent,
      approved: false,
      approvalSource: '',
    }),
    {
      status: 'not-present',
      migration: QUALIFIED_CONNECTED_ACCOUNTS_V4_ACTIVATION_MIGRATION,
      irreversible: true,
      oldServerRollbackAllowed: false,
      oldDaemonRollbackAllowed: false,
    },
  );
});

test('qualified V4 payload publication admits exact local payload reversion but no semantic rollback before activation', () => {
  assert.deepEqual(
    evaluateQualifiedConnectedAccountsV4PayloadPublicationAdmission({
      baselinePresence: absent,
      candidateRollbackSupport: rollbackSupportAbsent,
    }),
    {
      status: 'pre-activation',
      migration: QUALIFIED_CONNECTED_ACCOUNTS_V4_ACTIVATION_MIGRATION,
      irreversible: true,
      exactPayloadReversionAllowed: true,
      oldServerRollbackAllowed: false,
      oldDaemonRollbackAllowed: false,
    },
  );
});

test('qualified V4 payload publication rejects every missing daemon reader after server activation', () => {
  for (const missingSupport of Object.keys(rollbackSupportPresent)) {
    assert.throws(
      () => evaluateQualifiedConnectedAccountsV4PayloadPublicationAdmission({
        baselinePresence: present,
        candidateRollbackSupport: {
          ...rollbackSupportPresent,
          [missingSupport]: false,
        },
      }),
      new RegExp(`candidate payload.+${missingSupport}.+old-daemon rollback`, 'i'),
      `expected post-activation payload publication to reject missing ${missingSupport} support`,
    );
  }

  assert.deepEqual(
    evaluateQualifiedConnectedAccountsV4PayloadPublicationAdmission({
      baselinePresence: present,
      candidateRollbackSupport: rollbackSupportPresent,
    }),
    {
      status: 'post-activation-compatible',
      migration: QUALIFIED_CONNECTED_ACCOUNTS_V4_ACTIVATION_MIGRATION,
      irreversible: true,
      exactPayloadReversionAllowed: false,
      oldServerRollbackAllowed: false,
      oldDaemonRollbackAllowed: false,
    },
  );
});

test('qualified V4 activation CLI reads the exact pending migration set from Git refs', async (t) => {
  const gitRoot = await mkdtemp(join(tmpdir(), 'qualified-v4-release-admission-'));
  t.after(async () => rm(gitRoot, { recursive: true, force: true }));
  const runGit = (...args) => {
    const result = spawnSync('git', args, { cwd: gitRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return String(result.stdout).trim();
  };

  runGit('init', '--quiet');
  runGit('config', 'user.email', 'release-contract@example.invalid');
  runGit('config', 'user.name', 'Release Contract');
  await writeFile(join(gitRoot, 'README.md'), 'baseline\n');
  runGit('add', 'README.md');
  runGit('commit', '--quiet', '-m', 'baseline');
  const baseline = runGit('rev-parse', 'HEAD');

  await Promise.all(
    QUALIFIED_CONNECTED_ACCOUNTS_V4_ACTIVATION_PATHS.map(async ({ path }) => {
      const absolutePath = join(gitRoot, path);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, '-- activation\n');
    }),
  );
  const rollbackSupportContentByPath = new Map();
  for (const { checks } of QUALIFIED_CONNECTED_ACCOUNTS_V4_ROLLBACK_SUPPORT) {
    for (const { path, content, absent: expectedAbsent } of checks) {
      if (expectedAbsent === true) continue;
      const contents = rollbackSupportContentByPath.get(path) ?? [];
      contents.push(content);
      rollbackSupportContentByPath.set(path, contents);
    }
  }
  await Promise.all(
    [...rollbackSupportContentByPath].map(async ([path, contents]) => {
      const absolutePath = join(gitRoot, path);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, `${contents.join('\n')}\n`);
    }),
  );
  runGit('add', 'apps/server/prisma');
  runGit('add', 'apps/cli', 'packages/protocol');
  runGit('commit', '--quiet', '-m', 'activate');
  const candidate = runGit('rev-parse', 'HEAD');

  const denied = spawnSync(process.execPath, [
    checkerPath,
    '--repo-root', gitRoot,
    '--baseline-ref', baseline,
    '--candidate-ref', candidate,
    '--approval-kind', 'explicit-checkbox',
    '--approval-value', 'false',
  ], { encoding: 'utf8' });
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /pending and irreversible/i);

  const admitted = spawnSync(process.execPath, [
    checkerPath,
    '--repo-root', gitRoot,
    '--baseline-ref', baseline,
    '--candidate-ref', candidate,
    '--approval-kind', 'explicit-checkbox',
    '--approval-value', 'true',
  ], { encoding: 'utf8' });
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.match(admitted.stdout, /status: `activation-approved`/);
  assert.match(admitted.stdout, /old-server rollback allowed after activation: `false`/);
  assert.match(admitted.stdout, /old-daemon rollback allowed after activation: `false`/);

  await writeFile(
    join(gitRoot, 'apps/cli/src/api/client/qualifiedConnectedAccountApi.ts'),
    '// old daemon client without Qualified Connected Accounts V4 support\n',
  );
  runGit('add', 'apps/cli/src/api/client/qualifiedConnectedAccountApi.ts');
  runGit('commit', '--quiet', '-m', 'retain migration but roll back daemon reader');
  const rollbackCandidate = runGit('rev-parse', 'HEAD');
  const rollbackDenied = spawnSync(process.execPath, [
    checkerPath,
    '--repo-root', gitRoot,
    '--baseline-ref', candidate,
    '--candidate-ref', rollbackCandidate,
    '--approval-kind', 'explicit-checkbox',
    '--approval-value', 'true',
  ], { encoding: 'utf8' });
  assert.equal(rollbackDenied.status, 1);
  assert.match(
    rollbackDenied.stderr,
    /candidate.+qualifiedAccountsV4.+old-daemon rollback.+prohibited/i,
  );

  const preActivationPayloadAdmitted = spawnSync(process.execPath, [
    checkerPath,
    '--repo-root', gitRoot,
    '--baseline-ref', baseline,
    '--candidate-ref', baseline,
    '--admission-kind', 'payload-publication',
  ], { encoding: 'utf8' });
  assert.equal(
    preActivationPayloadAdmitted.status,
    0,
    preActivationPayloadAdmitted.stderr,
  );
  assert.match(
    preActivationPayloadAdmitted.stdout,
    /status: `pre-activation`/,
  );
  assert.match(
    preActivationPayloadAdmitted.stdout,
    /exact local payload reversion is admitted before activation: `true`/,
  );
  assert.match(
    preActivationPayloadAdmitted.stdout,
    /old-server semantic rollback allowed: `false`/,
  );
  assert.match(
    preActivationPayloadAdmitted.stdout,
    /old-daemon semantic rollback allowed: `false`/,
  );

  const postActivationPayloadDenied = spawnSync(process.execPath, [
    checkerPath,
    '--repo-root', gitRoot,
    '--baseline-ref', candidate,
    '--candidate-ref', rollbackCandidate,
    '--admission-kind', 'payload-publication',
  ], { encoding: 'utf8' });
  assert.equal(postActivationPayloadDenied.status, 1);
  assert.match(
    postActivationPayloadDenied.stderr,
    /candidate payload.+qualifiedAccountsV4.+old-daemon rollback.+prohibited/i,
  );

  // Exercise the npm entry's real final admission with the deployed baseline
  // moving independently of candidate packing. Only npm itself is substituted.
  runGit('remote', 'add', 'origin', gitRoot);
  runGit('update-ref', 'refs/heads/deploy/preview/server', candidate);
  const bin = join(gitRoot, 'bin');
  await mkdir(bin);
  const npmCalls = join(gitRoot, 'npm-calls');
  await writeFile(join(bin, 'npm'), '#!/bin/sh\nprintf called >> "$NPM_CALLS"\n', { mode: 0o700 });
  const finalAdmission = resolve(repoRoot, 'scripts/pipeline/release/admit-qualified-v4-npm-cli-payload.mjs');
  const publication = spawnSync('bash', ['-ec',
    '"$NODE" "$ADMISSION" --channel preview --source-ref refs/qualified-v4-payload-candidate --source-sha "$SOURCE_SHA"\nnpm publish fixture.tgz',
  ], {
    cwd: gitRoot, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, NODE: process.execPath,
      ADMISSION: finalAdmission, SOURCE_SHA: rollbackCandidate, NPM_CALLS: npmCalls },
  });
  assert.equal(publication.status, 1, publication.stderr);
  assert.match(publication.stderr, /candidate payload.+qualifiedAccountsV4.+old-daemon rollback.+prohibited/i);
  await assert.rejects(readFile(npmCalls), (error) => error?.code === 'ENOENT');
});

test('server migration admission rejects the read-state owner backfill until legacy API writers are drained', async (t) => {
  const gitRoot = await mkdtemp(join(tmpdir(), 'read-state-release-admission-'));
  t.after(async () => rm(gitRoot, { recursive: true, force: true }));
  const runGit = (...args) => {
    const result = spawnSync('git', args, { cwd: gitRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return String(result.stdout).trim();
  };

  runGit('init', '--quiet');
  runGit('config', 'user.email', 'release-contract@example.invalid');
  runGit('config', 'user.name', 'Release Contract');
  await writeFile(join(gitRoot, 'README.md'), 'baseline\n');
  runGit('add', 'README.md');
  runGit('commit', '--quiet', '-m', 'baseline');
  const baseline = runGit('rev-parse', 'HEAD');

  for (const { path } of ACCOUNT_SESSION_READ_STATE_BACKFILL_PATHS) {
    const migrationPath = join(gitRoot, path);
    await mkdir(dirname(migrationPath), { recursive: true });
    await writeFile(migrationPath, '-- owner-only read-state backfill\n');
  }
  runGit('add', 'apps/server/prisma');
  runGit('commit', '--quiet', '-m', 'add read-state owner backfill');
  const candidate = runGit('rev-parse', 'HEAD');

  const denied = spawnSync(process.execPath, [
    checkerPath,
    '--repo-root', gitRoot,
    '--baseline-ref', baseline,
    '--candidate-ref', candidate,
    '--approval-kind', 'explicit-checkbox',
    '--approval-value', 'false',
  ], { encoding: 'utf8' });

  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /read-state.+backfill.+legacy API read-state writers are drained/i);
  assert.match(denied.stderr, new RegExp(ACCOUNT_SESSION_READ_STATE_BACKFILL_MIGRATION));

  const admitted = spawnSync(process.execPath, [
    checkerPath,
    '--repo-root', gitRoot,
    '--baseline-ref', baseline,
    '--candidate-ref', candidate,
    '--approval-kind', 'explicit-checkbox',
    '--approval-value', 'true',
  ], { encoding: 'utf8' });

  assert.equal(admitted.status, 0, admitted.stderr);
  assert.match(admitted.stdout, /AccountSessionReadState backfill admission/);
  assert.match(admitted.stdout, /legacy API read-state writers drained before backfill: `required`/);
});
