import test from 'node:test';
import assert from 'node:assert/strict';
import { projectStackReloadVerification } from './reload_verdict.mjs';
import { createStackRuntimeCleanupIncompleteError } from '../utils/stack/stop_failure.mjs';

function readyInfo() {
  return { runtime: { mode: 'source-snapshot', running: true, valid: true,
    health: { status: 'healthy', issues: [] },
    components: { server: { running: true }, daemon: { running: true, status: 'running' } },
    daemonEntry: { selected: '/source/cli/src/index.mjs', loaded: '/source/cli/src/index.mjs' },
    sourceRuntimeIdentities: { server: { selected: 'server-new', loaded: 'server-new' },
      daemon: { selected: 'daemon-new', loaded: 'daemon-new' } },
    managedCli: { status: 'installed', binaryPath: '/managed/cli/versions/one/happier' } } };
}

test('a stale registered daemon identity prevents READY and reports every participant', () => {
  const info = readyInfo();
  const participants = [
    { identity: 'default', status: 'running', selected: 'daemon-new', loaded: 'daemon-new', sourceTime: '2026-11-04T08:00:00.000Z', reason: null },
    { identity: 'account-b', status: 'running', selected: 'daemon-new', loaded: 'daemon-old', sourceTime: '2026-11-03T12:59:00.000Z', reason: 'participant_source_stale' },
  ];
  info.runtime.daemonParticipants = participants;
  const input = { info, beforeManagedCli: info.runtime.managedCli, auth: { authenticated: true } };
  const refused = projectStackReloadVerification(input);
  assert.equal(refused.status, 'NOT_READY');
  assert.equal(refused.check, 'participant:account-b');
  assert.equal(refused.evidence.reason, 'participant_source_stale');
  assert.deepEqual(refused.participants, participants);
  participants[1] = { ...participants[1], loaded: 'daemon-new', sourceTime: participants[0].sourceTime, reason: null };
  assert.equal(projectStackReloadVerification(input).status, 'READY');
  assert.deepEqual(projectStackReloadVerification(input).participants, participants);
  participants[1] = { ...participants[1], loaded: null, sourceTime: null, reason: 'participant_source_unknown' };
  assert.equal(projectStackReloadVerification(input).evidence.reason, 'participant_source_unknown');
});

test('reload presents a refused daemon stop with its original typed reason', () => {
  const verdict = projectStackReloadVerification({ failure: { check: 'start', error: Object.assign(new Error('private diagnostic'), {
    code: 'daemon_stop_incomplete', reason: 'process_identity_unverified',
  }) } });
  assert.equal(verdict.status, 'NOT_READY');
  assert.deepEqual(verdict.evidence, { code: 'daemon_stop_incomplete', reason: 'process_identity_unverified' });
  const wrapped = createStackRuntimeCleanupIncompleteError({ stackName: 'reload-fixture',
    finalization: { finalized: false, reason: 'cleanup_unconfirmed' },
    errors: [{ step: 'daemon', code: 'daemon_stop_incomplete', reason: 'process_identity_unverified', error: 'private diagnostic' }],
  });
  assert.deepEqual(projectStackReloadVerification({ failure: { check: 'start', error: wrapped } }).evidence,
    { code: 'ESTACKRUNTIMECLEANUPINCOMPLETE', reason: 'process_identity_unverified' });
});
