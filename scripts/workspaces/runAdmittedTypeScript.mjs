import { availableParallelism } from 'node:os';
import { pathToFileURL } from 'node:url';
import { exitWithCommandResult, runCommand } from '../../apps/stack/scripts/utils/proc/proc.mjs';
import { isSingleThreadedTypeScript, resolveColdAdmissionCpuCost } from '../../apps/stack/scripts/utils/dev_targets/command_resources.mjs';

export function isNativeTypeScriptCompile(args) {
  return Array.isArray(args) && !args.some(arg => /^(-h|--help|-v|--version|--showconfig|--api)$/i.test(arg));
}

export function resolveNativeTypeScriptThreadBudget({ compiler, admissionClass, args, env }) {
  const granted = Number(env.GOMAXPROCS);
  const hasGrant = env.HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT && Number.isSafeInteger(granted) && granted > 0;
  const cores = Math.min(availableParallelism(), hasGrant ? granted : resolveColdAdmissionCpuCost(admissionClass));
  const serial = isSingleThreadedTypeScript(args);
  const rust = compiler === 'tsrs';
  // Native Rust checkers and the Rayon front end have separate pools. Leave
  // one core for their coordinator. Go shares one scheduler across its pools.
  const limit = rust ? (serial ? 1 : Math.max(1, Math.floor((cores - 1) / 2))) : cores;
  const rayon = Number(env.RAYON_NUM_THREADS);
  const compilerThreadEnv = rust
    ? { RAYON_NUM_THREADS: String(Number.isSafeInteger(rayon) && rayon > 0 ? Math.min(rayon, limit) : limit) }
    : { GOMAXPROCS: String(cores) };
  const checkerIndex = args.findLastIndex(arg => /^--checkers(?:=|$)/i.test(arg));
  const requested = checkerIndex === -1 ? undefined : Number(args[checkerIndex].includes('=')
    ? args[checkerIndex].split('=')[1] : args[checkerIndex + 1]);
  return {
    compilerThreadEnv,
    ...(!serial && (requested === undefined || (Number.isSafeInteger(requested) && requested > limit))
      ? { compilerThreadArgs: ['--checkers', String(limit)] } : {}),
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [compiler, admissionClass, ...args] = process.argv.slice(2);
  const { compilerThreadEnv, compilerThreadArgs = [] } = resolveNativeTypeScriptThreadBudget({
    compiler, admissionClass, args, env: process.env,
  });
  exitWithCommandResult(await runCommand(process.execPath, [...args, ...compilerThreadArgs], {
    env: { ...process.env, ...compilerThreadEnv },
    stdio: 'inherit',
    ownedProcessGroup: true,
  }));
}
