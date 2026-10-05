import { spawnProc } from '../proc/proc.mjs';
import { buildRemoteDoctorCommand, REMOTE_DOCTOR_RUNTIME_TARGET_PREFIX } from './remote_commands.mjs';
import { doctorManagedDevTargetRuntime } from './managed_runtime.mjs';

const MAX_SSH_DOCTOR_ATTEMPTS = 2;

function classifySshDoctorDiagnosticLine(line) {
  const diagnostic = String(line ?? '').trim();
  if (/^ssh: connect to host .+ port \d+: Connection timed out$/i.test(diagnostic)) {
    return 'ssh-connect-timeout';
  }
  if (/permission denied \(|host key verification failed|too many authentication failures/i.test(diagnostic)) {
    return 'ssh-authentication-failed';
  }
  if (/mux_client_request_session: session request failed: Session open refused by peer/i.test(diagnostic)) {
    return 'ssh-multiplex-session-refused';
  }
  return null;
}

async function defaultRunProcess({ label, command, args, env }) {
  let diagnosticReason = null;
  const runtimeTargetLines = [];
  const child = spawnProc(label, command, args, env, {
    silent: true,
    onLine({ stream, line }) {
      if (command === 'ssh' && stream === 'stderr') {
        diagnosticReason ??= classifySshDoctorDiagnosticLine(line);
      }
      if (command === 'ssh' && stream === 'stdout' && line.startsWith(REMOTE_DOCTOR_RUNTIME_TARGET_PREFIX)) {
        runtimeTargetLines.push(line);
      }
    },
  });
  const result = await child.completion;
  return {
    ...result,
    ...(diagnosticReason ? { diagnosticReason } : {}),
    ...(runtimeTargetLines.length ? { stdout: runtimeTargetLines.join('\n') } : {}),
  };
}

function readObservedRuntimeTarget(result) {
  if (result?.code !== 0) return null;
  const line = String(result?.stdout ?? '').split(/\r?\n/).find(value => value.startsWith(REMOTE_DOCTOR_RUNTIME_TARGET_PREFIX));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(REMOTE_DOCTOR_RUNTIME_TARGET_PREFIX.length));
    if (typeof parsed?.platform !== 'string' || typeof parsed?.arch !== 'string'
      || !/^[a-z0-9_]+$/.test(parsed.platform) || !/^[a-z0-9_]+$/.test(parsed.arch)) return null;
    return { platform: parsed.platform, arch: parsed.arch };
  } catch {
    return null;
  }
}

function resolveSshDoctorDiagnosticReason(result) {
  if (result?.code === 0) return null;
  if (result?.code === 255) {
    if (result?.diagnosticReason) return result.diagnosticReason;
    for (const line of [result?.stderr, result?.err].filter(Boolean).flatMap((value) => String(value).split(/\r?\n/))) {
      const diagnosticReason = classifySshDoctorDiagnosticLine(line);
      if (diagnosticReason) return diagnosticReason;
    }
    return 'ssh-connection-failed';
  }
  return result?.error?.code ? 'ssh-process-failed' : 'remote-doctor-failed';
}

function processResult(result, { diagnosticReason } = {}) {
  return {
    ok: result?.code === 0,
    code: result?.code ?? null,
    ...(result?.error?.code ? { errorCode: result.error.code } : {}),
    ...(result?.code === 0 || !diagnosticReason ? {} : { diagnosticReason }),
  };
}

export async function runDevTargetsDoctor(
  { targets, env = process.env },
  {
    runProcess = defaultRunProcess,
    doctorManagedRuntime = doctorManagedDevTargetRuntime,
  } = {},
) {
  const mutagen = processResult(
    await runProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: ['version'],
      env,
    }),
  );
  const targetResults = [];
  for (const target of targets) {
    const managedRuntime = target.managedRuntime
      ? await doctorManagedRuntime({ target, env })
      : null;
    let sshProcessResult;
    let diagnosticReason;
    for (let attempt = 1; attempt <= MAX_SSH_DOCTOR_ATTEMPTS; attempt += 1) {
      const sshArgs = [
        ...(target.sshConfigFile ? ['-F', target.sshConfigFile] : []),
        '-o',
        'ControlMaster=no',
        ...(attempt > 1 ? ['-o', 'ControlPath=none'] : []),
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        target.ssh,
        buildRemoteDoctorCommand(target),
      ];
      sshProcessResult = await runProcess({
        label: `remote:${target.name}`,
        command: 'ssh',
        args: sshArgs,
        env,
      });
      diagnosticReason = resolveSshDoctorDiagnosticReason(sshProcessResult);
      if (
        sshProcessResult?.code === 0
        || !['ssh-connect-timeout', 'ssh-multiplex-session-refused'].includes(diagnosticReason)
        || attempt === MAX_SSH_DOCTOR_ATTEMPTS
      ) {
        break;
      }
    }
    const sshResult = processResult(sshProcessResult, { diagnosticReason });
    const runtimeTarget = readObservedRuntimeTarget(sshProcessResult);
    targetResults.push({
      name: target.name,
      platform: target.platform,
      ssh: target.ssh,
      ...sshResult,
      ...(runtimeTarget ? { runtimeTarget } : {}),
      ...(managedRuntime ? { managedRuntime, sshOk: sshResult.ok } : {}),
      ok: sshResult.ok && (managedRuntime?.ok ?? true),
    });
  }
  return {
    ok: mutagen.ok && targetResults.every((target) => target.ok),
    mutagen,
    targets: targetResults,
  };
}
