import { spawnProc } from '../proc/proc.mjs';
import { buildRemoteDoctorCommand, REMOTE_DOCTOR_RUNTIME_TARGET_PREFIX } from './remote_commands.mjs';
import { doctorManagedDevTargetRuntime } from './managed_runtime.mjs';
import { resolveDevTargetMutagenRuntime, resolveDevTargetSshConfigFile } from './mutagen_runtime.mjs';
import { DEV_TARGET_SYNC_EXECUTOR_REPO } from './mutagen_project.mjs';
import { classifyDevTargetSshDiagnostic, resolveDevTargetSshDiagnostic, runDevTargetSshProcess } from './ssh_transport.mjs';

async function defaultRunProcess({ label, command, args, env }) {
  let diagnosticReason = null;
  const runtimeTargetLines = [];
  const child = spawnProc(label, command, args, env, {
    silent: true,
    onLine({ stream, line }) {
      if (command === 'ssh' && stream === 'stderr') {
        diagnosticReason ??= classifyDevTargetSshDiagnostic(line);
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

function processResult(result, { diagnosticReason } = {}) {
  return {
    ok: result?.code === 0,
    code: result?.code ?? null,
    ...(result?.error?.code ? { errorCode: result.error.code } : {}),
    ...(result?.code === 0 || !diagnosticReason ? {} : { diagnosticReason }),
  };
}

export async function runDevTargetsDoctor(
  { targets, stackBaseDir, env = process.env },
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
      env: resolveDevTargetMutagenRuntime({ stackBaseDir: stackBaseDir ?? DEV_TARGET_SYNC_EXECUTOR_REPO, env }).env,
    }),
  );
  const targetResults = [];
  for (const target of targets) {
    const sshConfigFile = resolveDevTargetSshConfigFile(target, { stackBaseDir, env });
    const managedRuntime = target.managedRuntime
      ? await doctorManagedRuntime({ target, env })
      : null;
    const sshProcessResult = await runDevTargetSshProcess({
      label: `remote:${target.name}`, command: 'ssh', env,
      args: [
        ...(sshConfigFile ? ['-F', sshConfigFile] : []),
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        target.ssh,
        buildRemoteDoctorCommand(target),
      ],
    }, runProcess);
    const diagnosticReason = resolveDevTargetSshDiagnostic(sshProcessResult);
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
