import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { resolveRemoteCommandPolicy } from '../../apps/stack/scripts/utils/dev_targets/remote_commands.mjs';
import { isWorkspaceBuildStartup } from '../../apps/stack/scripts/utils/proc/workspace_build_admission.mjs';

const NATIVE_TYPESCRIPT_PACKAGE_JSON = '@typescript/native/package.json';
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function typecheckCompilerOptions(args, workspaceDir) {
  // Build graphs and watch/editor tooling retain Microsoft authority. Use the
  // retained API only to read options (including extends), never to check code.
  if (args.some(arg => ['-b', '--build', '-w', '--watch', '--help', '-h', '--version', '-v', '--showconfig'].includes(arg.toLowerCase()))) return;
  const commandLine = ts.parseCommandLine(args);
  const project = commandLine.options.project;
  let options = commandLine.options;
  const configPath = project
    ? resolve(workspaceDir, project.endsWith('.json') ? project : `${project}/tsconfig.json`)
    : commandLine.fileNames.length ? undefined : ts.findConfigFile(workspaceDir, ts.sys.fileExists);
  if (configPath) {
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, options, {
      ...ts.sys, readDirectory: () => [], onUnRecoverableConfigFileDiagnostic() {},
    });
    if (!parsed) return;
    options = parsed.options;
  }
  return options.noEmit === true || options.emitDeclarationOnly === true ? options : undefined;
}

// Native 7.1.0-beta incremental snapshots use xxh3.HashString128(text).Bytes()
// encoded as hexadecimal. The real-compiler input-version test covers this
// adapter, including Unicode and BOM handling, when the compiler pin changes.
// File text is UTF-8 decoded with its leading BOM removed. Keep this compiler
// adapter here; source bundle records still use their existing SHA-256 digests.
export async function matchesNativeTypeScriptInputVersion(contents, version) {
  const { xxhash128 } = await import('hash-wasm');
  return await xxhash128(contents.toString('utf8').replace(/^\uFEFF/, '')) === version;
}

export function shouldRouteTypeScriptCliThroughHstack(params) {
  if (params.args.length === 1 && ['--version', '-v', '--help', '-h'].includes(params.args[0])) return false;
  if (params.env.HAPPIER_DEV_TARGET_EXECUTION === '1') return false;
  if (params.env.HAPPIER_HSTACK_EXECUTION === '1') return false;
  if (params.env.HAPPIER_TYPECHECK_DISPATCHED === '1') return false;
  // Keep already-admitted build descendants on their selected machine. This
  // only selects transport; the native admission owner still validates tokens.
  if (params.env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN) return false;
  if (isWorkspaceBuildStartup({ env: params.env })) return false;
  return true;
}

export function requiresTypeScriptAdmission({ env = process.env, platform = process.platform } = {}) {
  return platform === 'linux' && !isWorkspaceBuildStartup({ env }) && (!env.CI || env.HAPPIER_DEV_TARGET_EXECUTION === '1'
    || env.HAPPIER_HSTACK_LOCAL_ADMISSION_REQUIRED === '1' || Boolean(env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN));
}

export function resolveTypeScriptCliInvocation(params) {
  const processExecPath = params.processExecPath ?? process.execPath;
  const requireResolve = params.requireResolve ?? createRequire(import.meta.url).resolve;
  const readFileSyncImpl = params.readFileSyncImpl ?? readFileSync;
  const env = params.env ?? process.env;
  const compilerOverride = env.HAPPIER_TYPESCRIPT_COMPILER || 'auto';
  if (!['auto', 'microsoft', 'tsrs'].includes(compilerOverride)) {
    throw new Error('HAPPIER_TYPESCRIPT_COMPILER must be auto, microsoft or tsrs');
  }
  // Callers that have not supplied their compiler arguments cannot prove a
  // typecheck invocation (notably build and authoring-validation owners).
  const platform = params.platform ?? process.platform;
  const arch = params.arch ?? process.arch;
  const supported = (platform === 'linux' && ['x64', 'arm64'].includes(arch))
    || (platform === 'darwin' && arch === 'arm64');
  const options = Array.isArray(params.args) && compilerOverride !== 'microsoft' && params.invocationKind !== 'build'
    && (supported || compilerOverride === 'tsrs')
    ? typecheckCompilerOptions(params.args, params.workspaceDir ?? process.cwd()) : undefined;
  const packageName = options ? 'tsrs/package.json' : NATIVE_TYPESCRIPT_PACKAGE_JSON;
  const binaryName = options ? 'tsrs' : 'tsc';
  const packageJsonPath = requireResolve(packageName);
  const packageJson = JSON.parse(readFileSyncImpl(packageJsonPath, 'utf8'));
  const tscBin = packageJson?.bin?.[binaryName];
  if (typeof tscBin !== 'string' || !tscBin.trim()) {
    throw new Error(`${packageName} does not declare a ${binaryName} binary`);
  }

  const compilerPath = resolve(dirname(packageJsonPath), tscBin);
  // The synchronous native API spawns an executable, not the Node CLI wrapper.
  // Reuse the selected package's platform resolver; API tooling always selects Microsoft.
  const apiExecutable = params.args?.includes('--api')
    ? { apiExecutable: createRequire(packageJsonPath)('./lib/getExePath.js').default() }
    : {};
  // Rust snapshots and internal declarations never share Microsoft's caches.
  const cacheSuffix = options ? '.tsrs' : '';
  const buildInfoPath = options && ts.getTsBuildInfoEmitOutputFilePath(options);
  const cacheArgs = buildInfoPath ? { argsSuffix: ['--tsBuildInfoFile', `${resolve(params.workspaceDir ?? process.cwd(), buildInfoPath)}.tsrs`] } : {};
  const admissionClass = params.admissionClass ?? resolveRemoteCommandPolicy(
    ['node', 'scripts/workspaces/runTypeScriptCli.mjs', ...(params.admissionArgs ?? params.args ?? [])],
    { cwd: relative(params.repoRoot ?? REPO_ROOT, params.workspaceDir ?? process.cwd()) || '.',
      repoRoot: params.repoRoot ?? REPO_ROOT },
  ).heavyClass;
  // Preparation is a phase of this compilation, inside its authenticated
  // admission. Microsoft emission and the consumer never reserve twice.
  const prepare = params.prepareWorkspaceDeclarations && Array.isArray(params.args)
    && params.invocationKind !== 'build' && typecheckCompilerOptions(params.args, params.workspaceDir ?? process.cwd());
  const compilerArgs = prepare
    ? [resolve(REPO_ROOT, 'scripts/workspaces/prepareReferencedTypecheckDeclarations.mjs'), '--prepare-for-typecheck',
      dirname(typecheckCompilerOptions(params.admissionArgs ?? params.args, params.workspaceDir ?? process.cwd())?.configFilePath
        ?? resolve(params.workspaceDir ?? process.cwd(), 'tsconfig.json')), admissionClass, '--', processExecPath, compilerPath]
    : [compilerPath];
  // Match the native local admission owner's ordinary CI exemption. Placed
  // workers, explicit local overrides and admitted descendants retain guards.
  if (requiresTypeScriptAdmission({ env, platform: params.platform ?? process.platform })) {
    // Routing markers select transport; only the native admission owner can
    // validate/reuse an admitted ancestor or wait for compilation headroom.
    return {
      command: resolve(REPO_ROOT, 'apps/stack/bin/hstack-exec'),
      argsPrefix: ['--heavyweight-admission', `--class=${admissionClass}`,
        `--machine=${env.HAPPIER_DEV_TARGET_EXECUTION === '1' ? 'worker' : 'local'}`,
        '--exec-admitted', '--', processExecPath, ...compilerArgs],
      compilerPath,
      ...apiExecutable,
      cacheSuffix,
      ...cacheArgs,
    };
  }
  return {
    command: processExecPath,
    argsPrefix: compilerArgs,
    compilerPath,
    ...apiExecutable,
    cacheSuffix,
    ...cacheArgs,
  };
}
