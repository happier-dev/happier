import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
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
  sessionMetadataLayout1Kind10: true,
  managedLocalServiceRunAttachment: true,
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

test('qualified V4 activation admission pins current reader and custody capability evidence', async () => {
  for (const { key, checks } of QUALIFIED_CONNECTED_ACCOUNTS_V4_ROLLBACK_SUPPORT) {
    for (const { path, content } of checks) {
      const source = await readFile(resolve(repoRoot, path), 'utf8');
      assert.ok(
        source.includes(content),
        `expected ${key} rollback capability evidence in ${path}`,
      );
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
        managedLocalServiceRunAttachment: false,
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

test('qualified V4 payload publication preserves released-dev rollback before server activation', () => {
  assert.deepEqual(
    evaluateQualifiedConnectedAccountsV4PayloadPublicationAdmission({
      baselinePresence: absent,
      candidateRollbackSupport: rollbackSupportAbsent,
    }),
    {
      status: 'pre-activation',
      migration: QUALIFIED_CONNECTED_ACCOUNTS_V4_ACTIVATION_MIGRATION,
      irreversible: true,
      oldServerRollbackAllowed: true,
      oldDaemonRollbackAllowed: true,
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
    for (const { path, content } of checks) {
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
});
