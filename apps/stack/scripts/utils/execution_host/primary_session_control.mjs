import { posix } from 'node:path';
import { safeBashSingleQuote as quote } from '@happier-dev/cli-common/ssh';
import { runCaptureResult } from '../proc/proc.mjs';
import { resolveDevTargetSshConfigFile } from '../dev_targets/mutagen_runtime.mjs';
import { runDevTargetSshProcess } from '../dev_targets/ssh_transport.mjs';

const permissionModes = new Set(['default', 'read-only', 'safe-yolo', 'yolo', 'plan']);
function fail(code) {
  return Object.assign(new Error(`[dev-vm] ${code}`), { code });
}

function requireMode(session) {
  if (!permissionModes.has(session?.permissionMode)) throw fail('SESSION_PERMISSION_AUTHORITY_MISSING');
}

// Read-only prerequisite inspection consumes the predecessor's public CLI.
// It does not authorize session admission, handoff, binding or rollback.
export function createPrimarySessionControlAdapter({ source, target, homeDir, workStackName, workRepoDir,
  stackBaseDir, workStackStorageDir, env = process.env }, boundary = {}) {
  if (!source?.ssh || !target?.ssh || source.name === target.name || source.platform !== 'posix' || target.platform !== 'posix'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(workStackName ?? '')
    || !String(homeDir ?? '').startsWith('/') || homeDir === '/' || posix.normalize(homeDir) !== homeDir
    || !String(workRepoDir ?? '').startsWith(`${homeDir}/`) || posix.normalize(workRepoDir) !== workRepoDir
    || /[\0\r\n]/.test(`${homeDir}${workRepoDir}`)) throw fail('WORK_SESSION_SCOPE_INVALID');
  const capture = boundary.capture ?? runCaptureResult;
  const storage = workStackStorageDir ?? posix.join(homeDir, '.happier', 'stacks');
  if (!String(storage).startsWith(`${homeDir}/`) || posix.normalize(storage) !== storage || /[\0\r\n]/.test(storage)) throw fail('WORK_SESSION_SCOPE_INVALID');

  async function command(peer, args) {
    const config = resolveDevTargetSshConfigFile(peer, { stackBaseDir, env });
    const remote = `cd ${quote(workRepoDir)} && exec env ${[
      `HAPPIER_STACK_STACK=${workStackName}`, `HAPPIER_STACK_STORAGE_DIR=${storage}`,
      'HAPPIER_STACK_CLI_ROOT_DISABLE=1', 'HAPPIER_STACK_EXECUTION_HOST_REENTRY=1', 'HAPPIER_CLI_UPDATE_CHECK=0',
    ].map(quote).join(' ')} ${quote(posix.join(workRepoDir, 'apps/stack/bin/hstack.mjs'))} happier ${[...args, '--json'].map(quote).join(' ')}`;
    const result = await runDevTargetSshProcess({ command: 'ssh', args: ['-o', 'BatchMode=yes',
      ...(config ? ['-F', config] : []), peer.ssh, remote], env }, async input => {
      const value = await capture(input.command, input.args, { env: input.env });
      return { ...value, code: value.exitCode ?? value.code };
    });
    if (result.code !== 0) throw fail('SESSION_CONTROL_UNAVAILABLE');
    let value;
    try { value = JSON.parse(result.out); } catch { throw fail('SESSION_CONTROL_OUTPUT_INVALID'); }
    if (value?.ok === false) throw fail(value.error?.code ?? 'SESSION_CONTROL_REJECTED');
    return value;
  }

  async function identity(peer) {
    const value = await command(peer, ['daemon', 'status']);
    if (value.daemon?.running !== true || value.auth?.authenticated !== true || !value.auth?.machineId
      || !value.auth?.accountId || !value.server?.comparableKey
      || value.runtimeConvergence?.controlReachable !== true || value.runtimeConvergence?.machineIdMatches !== true) throw fail('WORK_DAEMON_IDENTITY_UNAVAILABLE');
    return { machineId: value.auth.machineId, accountId: value.auth.accountId, relay: value.server.comparableKey };
  }

  async function preflight() {
    const [from, to] = await Promise.all([identity(source), identity(target)]);
    if (from.machineId === to.machineId || from.accountId !== to.accountId || from.relay !== to.relay) throw fail('WORK_DAEMON_SCOPE_MISMATCH');
    const described = await command(source, ['session', 'actions', 'describe', 'session.handoff']);
    const spec = described.data?.actionSpec;
    if (spec?.surfaces?.cli !== true || !spec.inputHints?.fields?.some(field => field.path === 'stateTransfer'
      && field.options?.some(option => option.value === 'existing'))) throw fail('WORK_SESSION_CONTRACT_UNAVAILABLE');
    const sessions = [], cursors = new Set(), ids = new Set();
    let cursor = '';
    do {
      const value = await command(source, ['session', 'list', '--active', '--include-system', ...(cursor ? ['--cursor', cursor] : [])]);
      const page = value.data;
      if (!Array.isArray(page?.sessions) || typeof page.hasNext !== 'boolean') throw fail('SESSION_INVENTORY_INVALID');
      for (const row of page.sessions) {
        // Neither host/path nor active/pending counts establish identity or idle.
        if (typeof row?.machineId !== 'string' || !row.machineId) throw fail('SESSION_MACHINE_AUTHORITY_MISSING');
        if (row.machineId !== from.machineId) continue;
        if (typeof row.id !== 'string' || !row.id || ids.has(row.id)) throw fail('SESSION_INVENTORY_INVALID');
        requireMode(row);
        ids.add(row.id);
        sessions.push({ id: row.id, permissionMode: row.permissionMode });
      }
      cursor = page.hasNext ? page.nextCursor : '';
      if (page.hasNext && (typeof cursor !== 'string' || !cursor || cursors.has(cursor))) throw fail('SESSION_INVENTORY_INVALID');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    // Complete inventory is prerequisite evidence; it authorizes no mutation.
    return { sourceMachineId: from.machineId, targetMachineId: to.machineId, sessions, scope: 'active-work-sessions' };
  }

  return { preflight };
}
