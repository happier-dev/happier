import { spawnProc } from '../proc/proc.mjs';
import { buildRemoteDoctorCommand } from './remote_commands.mjs';
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
  return null;
}

async function defaultRunProcess({ label, command, args, env }) {
  let diagnosticReason = null;
  const child = spawnProc(label, command, args, env, {
    silent: true,
    onLine({ stream, line }) {
      if (command === 'ssh' && stream === 'stderr') {
        diagnosticReason ??= classifySshDoctorDiagnosticLine(line);
      }
    },
  });
  const result = await child.completion;
  return diagnosticReason ? { ...result, diagnosticReason } : result;
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
    const sshArgs = [
      ...(target.sshConfigFile ? ['-F', target.sshConfigFile] : []),
      '-o',
      'ControlMaster=no',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      target.ssh,
      buildRemoteDoctorCommand(target),
    ];
    let sshProcessResult;
    let diagnosticReason;
    for (let attempt = 1; attempt <= MAX_SSH_DOCTOR_ATTEMPTS; attempt += 1) {
      sshProcessResult = await runProcess({
        label: `remote:${target.name}`,
        command: 'ssh',
        args: sshArgs,
        env,
      });
      diagnosticReason = resolveSshDoctorDiagnosticReason(sshProcessResult);
      if (
        sshProcessResult?.code === 0
        || diagnosticReason !== 'ssh-connect-timeout'
        || attempt === MAX_SSH_DOCTOR_ATTEMPTS
      ) {
        break;
      }
    }
    const sshResult = processResult(sshProcessResult, { diagnosticReason });
    targetResults.push({
      name: target.name,
      platform: target.platform,
      ssh: target.ssh,
      ...sshResult,
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
