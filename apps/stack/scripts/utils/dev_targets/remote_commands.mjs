import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStackStableScopeId } from '../auth/stable_scope_id.mjs';
import { REQUIRED_MANAGED_LIMA_GUEST_TOOLCHAIN } from '../managed_lima/provisioner.mjs';
import { resolveEffectiveDbProvider } from '../server/effective_db_provider.mjs';

export const DEFAULT_REMOTE_STACK_STARTUP_TIMEOUT_MS = 30 * 60_000;

// Both dispatchers evaluate this policy. The native artifact is generated once,
// while argv and path normalization remain thin transport adapters.
export const REMOTE_COMMAND_CLASSIFICATION = Object.freeze({
  packageManagerCommands: Object.freeze(['npm', 'npx', 'pnpm', 'yarn']),
  sourceTestComponents: Object.freeze(['apps/cli', 'apps/ui', 'packages/plugins/triage']),
  sourceTestConfigs: Object.freeze(['vitest.config.ts']),
  sourceTestScripts: Object.freeze(['vitest', 'vitest:local']),
});
const DEFAULT_COMMAND_POLICY = Object.freeze({
  placement: 'worker-eligible', commandClass: 'unclassified', bootstrap: '0',
  validation: '0', kind: 'runtime', heavyClass: '', workerTool: '',
  workerArguments: '0', runnerKnown: '0', componentOverride: '',
  generator: '0', generatorCheck: '0', componentFromNative: '0',
});
const validation = { validation: '1', bootstrap: '1', heavyClass: 'validation' };
// Available-memory envelopes, not process limits or fixed concurrency slots.
// The native selection and admission paths consume this generated policy too.
// 2026-10-05 Linux measurements: cli-common dist 1,853,332 KiB; Protocol
// dist 4,682,608 KiB. Both fit beneath the existing 6 GiB compiler/suite
// envelope. Unmeasured builds and full typechecks retain the 21 GiB envelope;
// a failed dependency-incomplete typecheck is not evidence to lower it.
// The successful full daemon worker request peaked at 16,442,992 KiB of
// aggregate process-tree RSS on Linux x64 (2026-10-05). Preserve at least
// Round 1's measured package headroom (6,291,456 - 4,682,608 = 1,608,848 KiB):
// peak + headroom = 18,051,840 KiB, rounded up to 18 GiB. This does not
// justify admitting a worker with only 15 GiB available.
const HEAVYWEIGHT_MEMORY_KIB = Object.freeze({
  validation: 6291456,
  'dependency-install': 6291456,
  'package-dist': 6291456,
  'runtime-build': 18874368,
  compilation: 22020096,
});
const COMMAND_RULES = [
  { when: { hasScript: ['1'] }, set: { bootstrap: '1' } },
  { when: { command: ['git'] }, set: { placement: 'primary-only', commandClass: 'vcs-authority' } },
  { when: { command: ['find', 'grep', 'rg'] }, set: { commandClass: 'source-search' } },
  { when: { command: ['rg'] }, set: { workerTool: 'rg' } },
  { when: { command: ['tsc', 'vitest'] }, set: validation },
  { when: { command: ['hstack-exec'] }, set: { validation: '1', heavyClass: 'validation' } },
  { when: { family: ['build', 'check', 'lint', 'test', 'tsc', 'typecheck', 'vitest'] }, set: validation },
  { when: { family: ['install'] }, set: { commandClass: 'dependency-install', heavyClass: 'dependency-install' } },
  { when: { family: ['test', 'vitest'] }, set: { workerTool: 'vitest' } },
  { when: { command: ['tsc'] }, set: { kind: 'typecheck', workerTool: 'typescript-native' } },
  { when: { family: ['tsc', 'typecheck'] }, set: { kind: 'typecheck', workerTool: 'typescript-native' } },
  { when: { command: ['node', 'nodejs'], entry: ['runTypeScriptCli.mjs'] }, set: { ...validation, kind: 'typecheck', workerTool: 'typescript-native' } },
  { when: { command: ['node', 'nodejs'], entry: ['buildTypeScriptPackageDist.mjs', 'build.mjs'] }, set: { ...validation, heavyClass: 'compilation' } },
  { when: { command: ['node', 'nodejs'], entryPath: ['packages/cli-common/scripts/build.mjs'] }, set: { componentOverride: 'packages/cli-common' } },
  { when: { command: ['vitest'] }, set: { runnerKnown: '1', workerTool: 'vitest', workerArguments: '1' } },
  { when: { command: ['node', 'nodejs', 'tsx'], entry: ['vitest.mjs'] }, set: { ...validation, runnerKnown: '1', workerTool: 'vitest', workerArguments: '1' } },
  { when: { managerNode: ['1'], entry: ['run-vitest-with-heartbeat.mjs'] }, set: { ...validation, runnerKnown: '1', workerTool: 'vitest', workerArguments: '1' } },
  { when: { script: REMOTE_COMMAND_CLASSIFICATION.sourceTestScripts }, set: { runnerKnown: '1' } },
  // Unknown native suites may consume emitted workspace packages. Only proven
  // source-resolving suites skip publication; all runners admit dependencies.
  { when: { command: ['node', 'nodejs'], nativeTest: ['1'] }, set: { ...validation, componentFromNative: '1' } },
  { when: { command: ['node', 'nodejs'], nativeTest: ['1'], nativeTestPath: ['packages/plugin-sdk/scripts/generateActionTypeMap.test.mjs'] }, set: { kind: 'source-test' } },
  { when: { command: ['node', 'nodejs'], nativeTest: ['1'], stackScope: ['1'] }, set: { kind: 'runtime', componentOverride: 'apps/stack' } },
  { when: { command: ['node'], stripTypes: ['1'], entryPath: ['apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', 'scripts/build-owned/generateBundledPluginEntries.ts'] }, set: { generator: '1', workerTool: 'bundled-plugin-generator', heavyClass: 'validation', placement: 'primary-only' } },
  { when: { command: ['node'], stripTypes: ['1'], entryPath: ['apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', 'scripts/build-owned/generateBundledPluginEntries.ts'], mode: ['check'] }, set: { ...validation, placement: 'worker-eligible', generatorCheck: '1', componentOverride: 'apps/cli' } },
  { when: { script: ['check:first-party-plugins:finite', 'check:first-party-plugins:finite:local', 'plugins:aggregate:finite', 'test:migration:bundled-plugin-projections', 'test:migration:governance'] }, set: { ...validation, generatorCheck: '1', componentOverride: 'apps/cli' } },
];
const FINAL_COMMAND_RULES = [
  { when: { entry: ['remote_runtime_build.mjs'] }, set: { heavyClass: 'compilation' } },
  { when: { validation: ['1'] }, set: { commandClass: 'targeted-validation' } },
  { when: { validation: ['1'], component: ['.'] }, set: { commandClass: 'full-validation' } },
  { when: { family: ['build'] }, set: { heavyClass: 'compilation' } },
  { when: { kind: ['typecheck'] }, set: { heavyClass: 'compilation' } },
  { when: { command: ['node', 'nodejs'], nativeTest: ['0'], workerRequest: ['1'], entryPath: ['apps/stack/scripts/build/remote_runtime_build.mjs'] }, set: { heavyClass: 'runtime-build' } },
  { when: { command: ['node', 'nodejs'], nativeTest: ['0'], workerRequest: ['1'], entryPath: ['scripts/build/remote_runtime_build.mjs'], component: ['apps/stack'] }, set: { heavyClass: 'runtime-build' } },
  { when: { script: ['build', 'build:finite', 'build:clean'], component: ['packages/cli-common', 'packages/protocol'] }, set: { heavyClass: 'package-dist' } },
  { when: { command: ['node', 'nodejs'], entryPath: ['scripts/build.mjs', 'packages/cli-common/scripts/build.mjs'], component: ['packages/cli-common'] }, set: { heavyClass: 'package-dist' } },
  { when: { command: ['node', 'nodejs'], entry: ['buildTypeScriptPackageDist.mjs'], component: ['packages/protocol'], project: ['tsconfig.json', './tsconfig.json'] }, set: { heavyClass: 'package-dist' } },
  { when: { kind: ['runtime'], runnerKnown: ['1'], component: REMOTE_COMMAND_CLASSIFICATION.sourceTestComponents, config: REMOTE_COMMAND_CLASSIFICATION.sourceTestConfigs, resolverOverride: ['0'] }, set: { kind: 'source-test' } },
];
function commandBasename(value) {
  return String(value ?? '').trim().replaceAll('\\', '/').split('/').at(-1);
}
function normalizeCommandPath(value) {
  return posix.normalize(String(value ?? '.').replaceAll('\\', '/')).replace(/\/+$/u, '') || '.';
}
const COMMAND_REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/u, '');

function nativeTestComponent(testPath) {
  let parent = posix.dirname(testPath);
  if (parent.startsWith('/') || parent === '..' || parent.startsWith('../')) return '';
  while (parent !== '.') {
    if (existsSync(COMMAND_REPO_ROOT + '/' + parent + '/package.json')) return parent;
    parent = posix.dirname(parent);
  }
  return '';
}
function applyCommandRules(facts, rules, policy) {
  for (const rule of rules) {
    if (Object.entries(rule.when).every(([key, values]) => values.includes(String(facts[key] ?? policy[key] ?? '')))) Object.assign(policy, rule.set);
  }
  return policy;
}
function normalizeCommandArguments(commandArgs, cwd) {
  let args = Array.isArray(commandArgs) ? commandArgs.map(String) : [];
  if (args[0] === '--') args = args.slice(1);
  if (args[0]?.startsWith('--script=')) args = ['corepack', 'yarn', '-s', args[0].slice(9), ...args.slice(1)];
  const command = commandBasename(args[0]);
  const managerIndex = command === 'corepack' ? 1 : 0;
  const manager = commandBasename(args[managerIndex]);
  let script = '', entry = commandBasename(args[1]), managerCwd = '', managerNode = '0';
  if (REMOTE_COMMAND_CLASSIFICATION.packageManagerCommands.includes(manager)) {
    for (let index = managerIndex + 1; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '--cwd' || arg === '-C') { managerCwd = args[++index] ?? '.'; continue; }
      if (arg.startsWith('--cwd=')) { managerCwd = arg.slice(6); continue; }
      if (arg === 'workspace' && manager === 'yarn') { index += 1; continue; }
      if (arg === 'run' || arg.startsWith('-')) continue;
      script = arg;
      if (arg === 'node') { managerNode = '1'; entry = commandBasename(args[index + 1]); }
      break;
    }
  }
  const stripTypes = args[1] === '--experimental-strip-types' ? '1' : '0';
  if (stripTypes === '1') entry = commandBasename(args[2]);
  const rawEntryPath = String(args[stripTypes === '1' ? 2 : 1] ?? '').replaceAll('\\', '/');
  const entryPath = posix.normalize(rawEntryPath.startsWith(COMMAND_REPO_ROOT + '/') ? rawEntryPath.slice(COMMAND_REPO_ROOT.length + 1) : rawEntryPath);
  let config = 'vitest.config.ts', resolverOverride = '0', project = '', mode = 'write';
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (/^(?:--root|--workspace|--project)(?:=|$)/u.test(arg) || arg.startsWith('-r')) resolverOverride = '1';
    if (arg === '--config' || arg === '-c') config = args[++index] ?? '';
    else if (arg.startsWith('--config=')) config = arg.slice(9);
    else if (arg.startsWith('-c') && arg.length > 2) config = arg.slice(2);
    else if (arg === '--project' || arg === '-p') project = args[++index] ?? '';
    else if (arg.startsWith('--project=')) project = arg.slice(10);
    else if (arg === '--mode') mode = args[++index] ?? '';
    else if (arg.startsWith('--mode=')) mode = arg.slice(7);
  }
  const slashCwd = String(cwd ?? '.').replaceAll('\\', '/');
  const testPaths = args.slice(1).filter(arg => !arg.startsWith('-') && /\.(?:[cm]?[jt]s)$/u.test(arg)).map(arg => {
    const path = arg.replaceAll('\\', '/');
    return posix.normalize(path.startsWith(COMMAND_REPO_ROOT + '/') ? path.slice(COMMAND_REPO_ROOT.length + 1) : posix.join(slashCwd, path));
  });
  const testComponents = testPaths.map(nativeTestComponent);
  return {
    command, script, family: script.split(':', 1)[0], entry, entryPath, managerNode,
    hasScript: script ? '1' : '0', nativeTest: args.includes('--test') ? '1' : '0',
    stripTypes, mode, config: normalizeCommandPath(config), resolverOverride,
    workerRequest: args.some(arg => arg.startsWith('--worker-request=') && arg.length > '--worker-request='.length) ? '1' : '0',
    component: normalizeCommandPath(slashCwd), managerCwd, project,
    nativeTestPath: testPaths.length === 1 ? testPaths[0] : '',
    nativeComponent: testComponents.length && testComponents.every(component => component === testComponents[0]) ? testComponents[0] : '',
    stackScope: /^apps\/stack(?:\/|$)/u.test(posix.normalize(slashCwd))
      || args.some(arg => /(?:^|\/)apps\/stack\//u.test(arg.replaceAll('\\', '/'))) ? '1' : '0',
  };
}
export function resolveRemoteCommandPolicy(commandArgs, { cwd = '.' } = {}) {
  const facts = normalizeCommandArguments(commandArgs, cwd);
  const policy = applyCommandRules(facts, COMMAND_RULES, { ...DEFAULT_COMMAND_POLICY });
  if (facts.managerCwd) facts.component = posix.join(facts.component, facts.managerCwd.replaceAll('\\', '/'));
  else if (policy.kind === 'typecheck' && facts.project) {
    const project = facts.project.replaceAll('\\', '/');
    facts.component = posix.join(facts.component, project.endsWith('.json') ? posix.dirname(project) : project);
  }
  if (policy.componentOverride) facts.component = policy.componentOverride;
  else if (policy.componentFromNative === '1' && facts.nativeComponent) facts.component = facts.nativeComponent;
  facts.component = normalizeCommandPath(facts.component);
  applyCommandRules(facts, FINAL_COMMAND_RULES, policy);
  return { ...policy, component: normalizeCommandPath(facts.component) };
}
export function classifyRemoteCommand(commandArgs, options = {}) {
  const policy = resolveRemoteCommandPolicy(commandArgs, options);
  return { placement: policy.placement, commandClass: policy.commandClass, requiresDependencyBootstrap: policy.bootstrap === '1' };
}
export function resolveRemoteValidationComponentRelativeDir(commandArgs, options = {}) {
  return resolveRemoteCommandPolicy(commandArgs, options).component;
}
export function requiresRemoteWorkspacePreparation(commandArgs, options = {}) {
  return classifyRemoteCommand(commandArgs, options).commandClass === 'targeted-validation';
}
export function resolveRemoteValidationKind(commandArgs, options = {}) {
  return resolveRemoteCommandPolicy(commandArgs, options).kind;
}
export function requiresRemoteDependencyBootstrap(commandArgs, options = {}) {
  return classifyRemoteCommand(commandArgs, options).requiresDependencyBootstrap;
}
function renderShellCommandRules(rules) {
  return rules.map(({ when, set }) => {
    const conditions = Object.entries(when).map(([key, values]) => (
      '{ ' + values.map(value => '[ "$policy_' + key + '" = ' + posixQuote(value) + ' ]').join(' || ') + '; }'
    )).join(' && ');
    return '  if ' + conditions + '; then\n' + Object.entries(set).map(([key, value]) => '    policy_' + key + '=' + posixQuote(value)).join('\n') + '\n  fi';
  }).join('\n');
}
export function renderNativeCommandPolicy() {
  return [
    '# Generated by native_execution_projection.mjs --write-command-policy.',
    '# Rule authority: remote_commands.mjs. Do not edit this projection.',
    'heavyweight_memory_floor_kib() {',
    '  case "$1" in',
    ...Object.entries(HEAVYWEIGHT_MEMORY_KIB).map(([key, value]) => '    ' + key + ') printf ' + posixQuote(String(value)) + ' ;;'),
    // Historical dispatch labels are validation, while unrecognized resource
    // classes must not silently acquire a smaller compilation envelope.
    '    targeted-validation|full-validation) printf ' + posixQuote(String(HEAVYWEIGHT_MEMORY_KIB.validation)) + ' ;;',
    '    *) printf ' + posixQuote(String(HEAVYWEIGHT_MEMORY_KIB.compilation)) + ' ;;',
    '  esac', '}',
    'native_command_policy_base() {',
    ...Object.entries(DEFAULT_COMMAND_POLICY).map(([key, value]) => '  policy_' + key + '=' + posixQuote(value)),
    renderShellCommandRules(COMMAND_RULES), '}',
    'native_command_policy_finish() {', renderShellCommandRules(FINAL_COMMAND_RULES), '}',
    'native_package_manager() { case "$1" in ' + REMOTE_COMMAND_CLASSIFICATION.packageManagerCommands.join('|') + ') return 0 ;; *) return 1 ;; esac; }',
    NATIVE_COMMAND_NORMALIZATION, '',
  ].join('\n');
}

const NATIVE_COMMAND_NORMALIZATION = `
# Extract argv facts only; dispatch decisions come from the table above.
native_normalize_path() {
  native_path=$1
  while :; do case "$native_path" in *\\\\*) native_path="\${native_path%%\\\\*}/\${native_path#*\\\\}" ;; *) break ;; esac; done
  native_result=; native_absolute=
  case "$native_path" in /*) native_absolute=/ ;; esac
  while [ -n "$native_path" ]; do
    native_segment=\${native_path%%/*}
    if [ "$native_path" = "$native_segment" ]; then native_path=; else native_path=\${native_path#*/}; fi
    case "$native_segment" in
      ''|.) ;;
      ..) case "$native_result" in '') native_result=.. ;; ..|../*) native_result="$native_result/.." ;; */*) native_result=\${native_result%/*} ;; *) native_result= ;; esac ;;
      *) if [ -z "$native_result" ]; then native_result=$native_segment; else native_result="$native_result/$native_segment"; fi ;;
    esac
  done
  native_result="$native_absolute$native_result"
  [ -n "$native_result" ] || native_result=.
}
native_command_basename() {
  native_basename=$1
  while :; do case "$native_basename" in *\\\\*) native_basename="\${native_basename%%\\\\*}/\${native_basename#*\\\\}" ;; *) break ;; esac; done
  native_basename=\${native_basename##*/}
}
resolve_native_command_policy() {
  [ "\${1-}" = -- ] && shift
  case "\${1-}" in --script=*) native_script=\${1#--script=}; shift; [ "\${1-}" = -- ] && shift; set -- corepack yarn -s "$native_script" "$@" ;; esac
  native_command_basename "\${1-}"; policy_command=$native_basename
  native_command_basename "\${2-}"; policy_entry=$native_basename
  policy_script=; policy_hasScript=0; policy_managerNode=0; policy_stripTypes=0
  native_manager_cwd=; native_project=; policy_mode=write
  policy_nativeTest=0; policy_config=vitest.config.ts; policy_resolverOverride=0
  policy_project=; policy_workerRequest=0
  native_cwd=\${invoked_cwd#"$repo_root"}
  native_cwd=\${native_cwd#/}
  [ "\${explicit_relative_cwd_set-0}" = 1 ] && native_cwd=$explicit_relative_cwd
  native_normalize_path "$native_cwd"; policy_component=$native_result
  policy_stackScope=0
  case "$policy_component" in apps/stack|apps/stack/*) policy_stackScope=1 ;; esac
  if [ "\${2-}" = --experimental-strip-types ]; then policy_stripTypes=1; native_command_basename "\${3-}"; policy_entry=$native_basename; fi
  native_entry_path=\${2-}
  [ "$policy_stripTypes" = 1 ] && native_entry_path=\${3-}
  native_normalize_path "$native_entry_path"; policy_entryPath=$native_result
  case "$policy_entryPath" in "$repo_root"/*) policy_entryPath=\${policy_entryPath#"$repo_root"/} ;; esac
  native_pending=
  for native_arg in "$@"; do
    case "$native_pending" in
      config) policy_config=$native_arg; native_pending=; continue ;;
      project) native_project=$native_arg; native_pending=; continue ;;
      mode) policy_mode=$native_arg; native_pending=; continue ;;
    esac
    case "$native_arg" in
      --test) policy_nativeTest=1 ;;
      --worker-request=?*) policy_workerRequest=1 ;;
      --config|-c) native_pending=config; policy_config= ;;
      --config=*) policy_config=\${native_arg#--config=} ;;
      -c?*) policy_config=\${native_arg#-c} ;;
      --project|-p) native_pending=project; [ "$native_arg" = --project ] && policy_resolverOverride=1 ;;
      --project=*) native_project=\${native_arg#--project=}; policy_resolverOverride=1 ;;
      --root|--root=*|--workspace|--workspace=*|-r*) policy_resolverOverride=1 ;;
      --mode) native_pending=mode ;;
      --mode=*) policy_mode=\${native_arg#--mode=} ;;
    esac
    case "$native_arg" in apps/stack/*|./apps/stack/*|*/apps/stack/*) policy_stackScope=1 ;; esac
  done
  native_normalize_path "$policy_config"; policy_config=$native_result
  policy_project=$native_project
  policy_nativeTestPath=; native_test_count=0; native_test_component=; native_test_component_mixed=0
  for native_arg in "$@"; do
    case "$native_arg" in -*) continue ;; *.mjs|*.cjs|*.js|*.ts|*.mts|*.cts) ;; *) continue ;; esac
    native_normalize_path "$native_arg"; native_test_path=$native_result
    case "$native_test_path" in "$repo_root"/*) native_test_path=\${native_test_path#"$repo_root"/} ;; *) native_normalize_path "$policy_component/$native_test_path"; native_test_path=$native_result ;; esac
    native_test_count=$((native_test_count + 1))
    policy_nativeTestPath=$native_test_path
    native_parent=\${native_test_path%/*}
    [ "$native_parent" != "$native_test_path" ] || native_parent=.
    native_component=
    case "$native_parent" in /*|..|../*) native_parent=. ;; esac
    while [ "$native_parent" != . ]; do
      if [ -f "$repo_root/$native_parent/package.json" ]; then native_component=$native_parent; break; fi
      case "$native_parent" in */*) native_parent=\${native_parent%/*} ;; *) native_parent=. ;; esac
    done
    if [ "$native_test_count" -eq 1 ]; then native_test_component=$native_component
    elif [ "$native_test_component" != "$native_component" ]; then native_test_component_mixed=1; fi
  done
  [ "$native_test_count" -eq 1 ] || policy_nativeTestPath=
  [ "$native_test_component_mixed" -eq 0 ] || native_test_component=
  native_command_basename "\${1-}"; native_manager=$native_basename
  if [ "$native_manager" = corepack ]; then shift; native_command_basename "\${1-}"; native_manager=$native_basename; fi
  if native_package_manager "$native_manager"; then
    [ "$#" -gt 0 ] && shift
    while [ "$#" -gt 0 ]; do
      case "$1" in
        run|-s|--silent) shift ;;
        --cwd|-C) shift; native_manager_cwd=\${1-.}; [ "$#" -gt 0 ] && shift ;;
        --cwd=*) native_manager_cwd=\${1#--cwd=}; shift ;;
        workspace) if [ "$native_manager" = yarn ]; then shift; [ "$#" -gt 0 ] && shift; else policy_script=$1; break; fi ;;
        -*) shift ;;
        *) policy_script=$1; if [ "$1" = node ]; then policy_managerNode=1; native_command_basename "\${2-}"; policy_entry=$native_basename; fi; break ;;
      esac
    done
  fi
  [ -n "$policy_script" ] && policy_hasScript=1
  policy_family=\${policy_script%%:*}
  native_command_policy_base
  if [ -n "$native_manager_cwd" ]; then native_normalize_path "$policy_component/$native_manager_cwd"; policy_component=$native_result
  elif [ "$policy_kind" = typecheck ] && [ -n "$native_project" ]; then
    native_normalize_path "$native_project"; native_project=$native_result
    case "$native_project" in *.json) case "$native_project" in */*) native_project=\${native_project%/*} ;; *) native_project=. ;; esac ;; esac
    native_normalize_path "$policy_component/$native_project"; policy_component=$native_result
  fi
  [ -n "$policy_componentOverride" ] && policy_component=$policy_componentOverride
  if [ -z "$policy_componentOverride" ] && [ "$policy_componentFromNative" = 1 ] && [ -n "$native_test_component" ]; then policy_component=$native_test_component; fi
  native_command_policy_finish
}
`;

function posixQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

export function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function powershellNativeArgument(value) {
  const escaped = String(value).replace(/(\\*)"/g, (_match, backslashes) => (
    `${backslashes}${backslashes}\\"`
  ));
  return powershellQuote(escaped);
}

export function buildRemotePowerShellCommand(script) {
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(String(script), 'utf16le').toString('base64')}`;
}

function prependRemotePath(target, script) {
  const entries = Array.isArray(target.remotePath) ? target.remotePath.map(String) : [];
  if (entries.length === 0) return script;
  if (target.platform === 'windows') {
    return `$env:PATH = ${powershellQuote(entries.join(';'))} + [IO.Path]::PathSeparator + $env:PATH; ${script}`;
  }
  return `export PATH=${posixQuote(entries.join(':'))}:"$PATH"; ${script}`;
}

function requireRemoteRelativeWorkingDirectory(target, cwd) {
  const raw = String(cwd ?? '.').trim() || '.';
  if (/\0|\r|\n/.test(raw)) {
    throw new Error('[dev-targets] invalid remote working directory');
  }
  const slashNormalized = raw.replace(/\\/g, '/');
  if (
    slashNormalized.startsWith('/')
    || /^[A-Za-z]:\//.test(slashNormalized)
    || slashNormalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error('[dev-targets] remote working directory must stay inside the synchronized repository');
  }
  const segments = slashNormalized.split('/').filter((segment) => segment && segment !== '.');
  const root = String(target.repoDir).replace(/[\\/]+$/, '');
  return segments.length ? `${root}/${segments.join('/')}` : root;
}

function normalizeRemoteEnvironment(environment) {
  const result = [];
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`[dev-targets] invalid remote environment key: ${key}`);
    }
    const normalized = String(value ?? '');
    if (normalized.includes('\0')) {
      throw new Error(`[dev-targets] invalid remote environment value for ${key}`);
    }
    result.push([key, normalized]);
  }
  return result;
}

function requireRemoteExecutionId(executionId) {
  const normalized = String(executionId ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(normalized)) {
    throw new Error('[dev-targets] remote execution id must be a path-safe opaque identifier');
  }
  return normalized;
}

function resolveRemoteExecutionPidFile(target, executionId) {
  const normalizedHome = String(target.cliHomeDir).replace(/[\\/]+$/, '');
  return `${normalizedHome}/remote-exec/${requireRemoteExecutionId(executionId)}.pid`;
}

export function buildRemoteExecCommand(
  target,
  { executionId, cwd = '.', commandArgs, environment = {}, preparation = null, admissionClass = '', admissionMode = 'wait', lifetimeStdin = false } = {},
) {
  let args = Array.isArray(commandArgs) ? commandArgs.map(String) : [];
  if (args.length === 0 || !args[0]) {
    throw new Error('[dev-targets] remote command is required');
  }
  if (args.some((value) => value.includes('\0'))) {
    throw new Error('[dev-targets] remote command arguments cannot contain NUL bytes');
  }
  const workingDirectory = requireRemoteRelativeWorkingDirectory(target, cwd);
  const environmentEntries = normalizeRemoteEnvironment(environment);
  const normalizedExecutionId = requireRemoteExecutionId(executionId);
  const pidFile = resolveRemoteExecutionPidFile(target, normalizedExecutionId);
  if (target.platform !== 'windows' && (preparation || admissionClass)) {
    const repoDir = requireRemoteRelativeWorkingDirectory(target, '.');
    const body = ['set -euo pipefail', `cd -- ${posixQuote(repoDir)}`];
    const cacheEnv = `env ${posixQuote(`HAPPIER_STACK_PM_CACHE_BASE_DIR=${String(target.cliHomeDir).replace(/[\\/]+$/, '')}/cache`)}`;
    if (preparation?.bootstrap) {
      body.push(`${cacheEnv} node ./apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs ${posixQuote(`--validation-kind=${preparation.validationKind}`)} ${posixQuote(`--component-relative-dir=${preparation.bootstrapComponentRelativeDir ?? '.'}`)}`);
    }
    if (preparation?.componentRelativeDir != null) {
      requireRemoteRelativeWorkingDirectory(target, preparation.componentRelativeDir);
      body.push(`${cacheEnv} node ./apps/stack/scripts/utils/dev_targets/remote_validation_preparation.mjs ${posixQuote(`--component-relative-dir=${preparation.componentRelativeDir}`)} ${posixQuote(`--validation-kind=${preparation.validationKind}`)}`);
    }
    body.push(`cd -- ${posixQuote(workingDirectory)}`, `exec ${args.map(posixQuote).join(' ')}`);
    args = ['bash', '-c', body.join('; ')];
    if (admissionClass) {
      args = [`${repoDir}/apps/stack/bin/hstack-exec`, '--heavyweight-admission',
        `--class=${admissionClass}`, `--machine=${target.name}`, ...(admissionMode === 'try' ? ['--no-wait'] : []), '--', ...args];
    }
  }
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        "$ProgressPreference = 'SilentlyContinue'",
        `$pidFile = ${powershellQuote(pidFile)}`,
        'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pidFile) | Out-Null',
        '$selfProcess = Get-Process -Id $PID',
        '"$PID|$($selfProcess.StartTime.ToUniversalTime().Ticks)" | Set-Content -LiteralPath $pidFile -Encoding Ascii -NoNewline',
        'try { '
          + `Set-Location -LiteralPath ${powershellQuote(workingDirectory)}; `
          + environmentEntries.map(([key, value]) => `$env:${key} = ${powershellQuote(value)}; `).join('')
          + `& ${args.map(powershellNativeArgument).join(' ')}; `
          + '$commandStatus = $LASTEXITCODE; '
          + 'if ($null -eq $commandStatus) { $commandStatus = 0 }; '
          + 'exit $commandStatus '
          + '} finally { Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $pidFile }',
      ].join('; '),
    );
  }
  const body = [
      'set -euo pipefail',
      `cd -- ${posixQuote(workingDirectory)}`,
      ...environmentEntries.map(([key, value]) => `export ${key}=${posixQuote(value)}`),
      `exec ${args.map(posixQuote).join(' ')}`,
  ].join('; ');
  const custody = `${requireRemoteRelativeWorkingDirectory(target, '.')}/apps/stack/scripts/utils/dev_targets/remote_execution_custody.sh`;
  return wrapRemoteScript(target, `${lifetimeStdin ? 'HAPPIER_REMOTE_EXEC_LIFELINE=1 ' : ''}bash ${posixQuote(custody)} run ${posixQuote(pidFile)} ${posixQuote(normalizedExecutionId)} bash -c ${posixQuote(body)}`);
}

export function buildRemoteCancelCommand(target, { executionId } = {}) {
  const normalizedExecutionId = requireRemoteExecutionId(executionId);
  const pidFile = resolveRemoteExecutionPidFile(target, normalizedExecutionId);
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        "$ProgressPreference = 'SilentlyContinue'",
        `$pidFile = ${powershellQuote(pidFile)}`,
        'if (-not (Test-Path -LiteralPath $pidFile)) { exit 0 }',
        'try { '
          + '$identity = (Get-Content -Raw -LiteralPath $pidFile).Trim().Split(\'|\'); '
          + 'if ($identity.Count -ne 2) { exit 0 }; '
          + '[int]$remoteProcessId = 0; [long]$remoteStartTicks = 0; '
          + 'if (-not [int]::TryParse($identity[0], [ref]$remoteProcessId)) { exit 0 }; '
          + 'if (-not [long]::TryParse($identity[1], [ref]$remoteStartTicks)) { exit 0 }; '
          + '$remoteProcess = Get-Process -Id $remoteProcessId -ErrorAction SilentlyContinue; '
          + 'if ($null -eq $remoteProcess) { exit 0 }; '
          + 'if ($remoteProcess.StartTime.ToUniversalTime().Ticks -ne $remoteStartTicks) { exit 0 }; '
          + 'taskkill.exe /PID $remoteProcessId /T /F | Out-Null; '
          + 'exit 0 '
          + '} finally { Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $pidFile }',
      ].join('; '),
    );
  }
  const custody = `${requireRemoteRelativeWorkingDirectory(target, '.')}/apps/stack/scripts/utils/dev_targets/remote_execution_custody.sh`;
  return wrapRemoteScript(target, `bash ${posixQuote(custody)} cancel ${posixQuote(pidFile)} ${posixQuote(normalizedExecutionId)}`);
}

function wrapRemoteScript(target, script) {
  const wrappedScript = prependRemotePath(target, script);
  if (target.platform === 'windows') {
    return buildRemotePowerShellCommand(wrappedScript);
  }
  return `bash -lc ${posixQuote(wrappedScript)}`;
}

function buildWindowsOrphanedMutagenCleanupScript() {
  return [
    'try {',
    `  $mutagenAgents = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'mutagen-agent.exe'" -ErrorAction SilentlyContinue);`,
    '  foreach ($agent in $mutagenAgents) {',
    '    $launcher = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $agent.ParentProcessId) -ErrorAction SilentlyContinue;',
    "    if ($null -eq $launcher -or $launcher.Name -ne 'cmd.exe') { continue };",
    '    $sshParentPid = [int]$launcher.ParentProcessId;',
    '    if (-not (Get-Process -Id $sshParentPid -ErrorAction SilentlyContinue)) {',
    '      & taskkill.exe /PID ([string]$launcher.ProcessId) /T /F | Out-Null',
    '    }',
    '  }',
    '} catch { }',
  ].join(' ');
}

export function buildRemoteEnsureDirectoriesCommand(target, options = {}) {
  const additional = options.runtimeMode === 'controlled'
    ? (() => { const paths = resolveRemoteStackStatePaths(target, options); return [paths.stackBaseDir, paths.cliHomeDir, paths.workspaceDir]; })()
    : [];
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        "$ProgressPreference = 'SilentlyContinue'",
        buildWindowsOrphanedMutagenCleanupScript(),
        `New-Item -ItemType Directory -Force -Path ${powershellQuote(target.repoDir)} | Out-Null`,
        `New-Item -ItemType Directory -Force -Path ${powershellQuote(target.cliHomeDir)} | Out-Null`,
        ...additional.map(path => `New-Item -ItemType Directory -Force -Path ${powershellQuote(path)} | Out-Null`),
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    `set -euo pipefail; mkdir -p -- ${[target.repoDir, target.cliHomeDir, ...additional].map(posixQuote).join(' ')}`,
  );
}

export const REMOTE_DOCTOR_RUNTIME_TARGET_PREFIX = '__HAPPIER_RUNTIME_TARGET__=';

export function buildRemoteDoctorCommand(target) {
  const runtimeTargetExpression = JSON.stringify(REMOTE_DOCTOR_RUNTIME_TARGET_PREFIX)
    + ' + JSON.stringify({platform:process.platform,arch:process.arch})';
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        ...REQUIRED_MANAGED_LIMA_GUEST_TOOLCHAIN.map(({ command, label }) => (
          `if (-not (Get-Command ${command} -ErrorAction SilentlyContinue)) { throw "${label} is required on the remote target" }`
        )),
        ...REQUIRED_MANAGED_LIMA_GUEST_TOOLCHAIN.flatMap(({ command }) => [
          `${command} --version`,
          'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        ]),
        `node -p ${powershellNativeArgument(runtimeTargetExpression)}`,
        'exit $LASTEXITCODE',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      ...REQUIRED_MANAGED_LIMA_GUEST_TOOLCHAIN.map(({ command, label }) => (
        `command -v ${command} >/dev/null || { echo "${label} is required on the remote target" >&2; exit 127; }`
      )),
      ...REQUIRED_MANAGED_LIMA_GUEST_TOOLCHAIN.map(({ command }) => `${command} --version`),
      `node -p ${posixQuote(runtimeTargetExpression)}`,
    ].join('; '),
  );
}

export function buildRemoteInstallCredentialCommand(target, { stagedPath, finalPath }) {
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        `$destination = ${powershellQuote(finalPath)}`,
        'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null',
        `Move-Item -Force -LiteralPath ${powershellQuote(stagedPath)} -Destination $destination`,
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      `install -d -m 700 -- ${posixQuote(finalPath.slice(0, finalPath.lastIndexOf('/')))}`,
      `install -m 600 -- ${posixQuote(stagedPath)} ${posixQuote(finalPath)}`,
      `rm -f -- ${posixQuote(stagedPath)}`,
    ].join('; '),
  );
}

function requireServicePort(value, label, { optional = false } = {}) {
  if (optional && value == null) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`[dev-targets] ${label} must be an integer from 1024 to 65535`);
  }
  return port;
}

const REMOTE_SERVER_LIGHT_SEMANTIC_ENV_KEYS = new Set([
  'HAPPIER_STACK_SHARED_DB_SOURCE_STACK',
  'HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE',
  'HAPPIER_SQLITE_AUTO_MIGRATE',
  'HAPPIER_STACK_MIGRATE_MODE',
  'METRICS_ENABLED',
  'HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY',
  // The application origin mailed links (verification, reset, invitations) are rendered on.
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_SQLITE_BUSY_TIMEOUT_MS',
  'HAPPIER_SQLITE_CONNECTION_LIMIT',
]);
const REMOTE_SERVER_LIGHT_SEMANTIC_ENV_PREFIXES = [
  'HAPPIER_SERVER_RETENTION__',
  // Auth mail delivery and the email/password method: a Stack's own settings must reach its server
  // wherever it is placed, or mail-dependent sign-in silently stays off on a remote target.
  'HAPPIER_AUTH_EMAIL_',
  'HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__',
];
// Secrets never enter a remote command line or its persisted env file.
const REMOTE_SERVER_LIGHT_NEVER_FORWARDED_ENV_KEYS = new Set(['HAPPIER_AUTH_EMAIL_SMTP_PASSWORD']);

function isRemoteServerLightSemanticEnvKey(key) {
  if (REMOTE_SERVER_LIGHT_NEVER_FORWARDED_ENV_KEYS.has(key)) return false;
  return REMOTE_SERVER_LIGHT_SEMANTIC_ENV_KEYS.has(key)
    || REMOTE_SERVER_LIGHT_SEMANTIC_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function projectRemoteServerLightSemanticEnvironment(env) {
  const projected = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!isRemoteServerLightSemanticEnvKey(key) || value == null) continue;
    if (!/^[A-Z0-9_]+$/.test(key)) {
      throw new Error('[dev-targets] invalid remote server semantic environment key');
    }
    const normalized = String(value).trim();
    if (!normalized) continue;
    if (/[\0\r\n]/.test(normalized)) {
      throw new Error('[dev-targets] invalid remote server semantic environment value');
    }
    projected[key] = normalized;
  }
  return projected;
}

export function resolveRemoteServerRuntimeConfig({ serverComponentName, env = {} } = {}) {
  if (serverComponentName !== 'happier-server-light') {
    throw new Error('[dev-targets] remote server placement only supports happier-server-light');
  }
  const effectiveProvider = resolveEffectiveDbProvider({ serverComponentName, env });
  if (!effectiveProvider.ok) {
    throw new Error('[dev-targets] remote server placement has an unsupported SQLite provider configuration');
  }
  if (effectiveProvider.provider !== 'sqlite') {
    throw new Error('[dev-targets] remote server placement only supports SQLite');
  }
  return {
    serverComponentName: 'happier-server-light',
    dbProvider: 'sqlite',
    environment: projectRemoteServerLightSemanticEnvironment(env),
  };
}

function normalizeRemoteServerRuntimeConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('[dev-targets] remote server placement requires a supported server runtime configuration');
  }
  const environment = config.environment ?? {};
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new Error('[dev-targets] remote server semantic environment must be an object');
  }
  const envProvider = environment.HAPPIER_DB_PROVIDER;
  if (
    config.dbProvider != null
    && envProvider != null
    && String(config.dbProvider).trim().toLowerCase() !== String(envProvider).trim().toLowerCase()
  ) {
    throw new Error('[dev-targets] remote server runtime DB provider configuration conflicts');
  }
  return resolveRemoteServerRuntimeConfig({
    serverComponentName: config.serverComponentName,
    env: {
      ...environment,
      ...(config.dbProvider != null ? { HAPPIER_DB_PROVIDER: config.dbProvider } : {}),
    },
  });
}

function requireStableOuterServerUrl(value, { label = '--server-public-url' } = {}) {
  const urlText = String(value ?? '').trim();
  if (!urlText || /[\0\r\n]/.test(urlText)) {
    throw new Error(`[dev-targets] remote server placement requires a stable outer ${label}`);
  }
  let url;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error(`[dev-targets] remote server placement requires an HTTP(S) ${label}`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`[dev-targets] remote server placement requires an HTTP(S) ${label}`);
  }
  return urlText;
}

function buildRemoteDevArgs({ services, serverUrl, publicServerUrl, startMobile }) {
  const args = [];
  if (!services.server) args.push('--no-server');
  if (!services.expo) args.push('--no-ui');
  if (!services.daemon) args.push('--no-daemon');
  args.push('--no-browser', '--no-dev-targets', '--watch');
  if (services.expo && startMobile) args.push('--mobile');
  if (services.server) {
    if (publicServerUrl) args.push(`--server-public-url=${publicServerUrl}`);
  } else {
    args.push(`--server-url=${serverUrl}`);
    if (publicServerUrl) args.push(`--server-public-url=${publicServerUrl}`);
  }
  return args;
}

function formatPosixDevArg(arg) {
  const separator = arg.indexOf('=');
  if (separator < 0) return arg;
  return `${arg.slice(0, separator + 1)}${posixQuote(arg.slice(separator + 1))}`;
}

function formatPowerShellDevArg(arg) {
  const separator = arg.indexOf('=');
  if (separator < 0) return arg;
  return `${arg.slice(0, separator + 1)}${powershellQuote(arg.slice(separator + 1))}`;
}

function resolveRemoteTargetStackName(target, { stackName } = {}) {
  const controllerStackName = String(stackName ?? '').trim();
  const targetName = String(target?.name ?? '').trim().toLowerCase();
  if (!controllerStackName || !targetName) {
    throw new Error('[dev-targets] remote Stack identity requires controller Stack and target names');
  }
  const targetToken = targetName
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'target';
  const fingerprint = createHash('sha256')
    .update(`${controllerStackName}\0${targetName}\0${String(target.repoDir ?? '')}\0${String(target.cliHomeDir ?? '')}`)
    .digest('hex')
    .slice(0, 16);
  return `dev-target-${targetToken}-${fingerprint}`;
}

export function resolveRemoteStackStatePaths(target, { stackName, runtimeMode = 'source' } = {}) {
  if (runtimeMode === 'controlled') {
    const pathApi = target.platform === 'windows' ? win32 : posix;
    const relativeHome = pathApi.relative(String(target.repoDir).replaceAll('\\', '/'), String(target.cliHomeDir).replaceAll('\\', '/'));
    if (!pathApi.isAbsolute(relativeHome) && relativeHome !== '..' && !relativeHome.startsWith(`..${pathApi.sep}`)) {
      throw new Error('[dev-targets] controlled CLI state and workspace must be outside the one-way source replica; configure an external target cli-home-dir');
    }
  }
  const remoteStackName = runtimeMode === 'controlled' ? stackName : resolveRemoteTargetStackName(target, { stackName });
  const stackStorageDir = `${String(target.cliHomeDir).replace(/[\\/]+$/, '')}/stack-state`;
  const stackBaseDir = `${stackStorageDir}/${remoteStackName}`;
  return {
    activeServerId: buildStackStableScopeId({
      stackName: runtimeMode === 'controlled' ? stackName : remoteStackName,
      cliIdentity: 'default',
    }),
    stackName: remoteStackName,
    stackStorageDir,
    stackBaseDir,
    stackEnvPath: `${stackBaseDir}/env`,
    cliHomeDir: runtimeMode === 'controlled' ? `${stackBaseDir}/cli` : String(target.cliHomeDir).replace(/[\\/]+$/, ''),
    workspaceDir: `${stackBaseDir}/workspace`,
    serverLightDataDir: `${stackBaseDir}/server-light`,
  };
}

export function buildRemoteStackRetirementProbeCommand(target, { stackName, runtimeMode = 'source' } = {}) {
  const { stackBaseDir } = resolveRemoteStackStatePaths(target, { stackName, runtimeMode });
  const runtimeStatePath = `${stackBaseDir}/stack.runtime.json`;
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        `if (Test-Path -LiteralPath ${powershellQuote(runtimeStatePath)}) { exit 1 }`,
        'exit 0',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      `test ! -e ${posixQuote(runtimeStatePath)}`,
    ].join('; '),
  );
}

export function buildRemoteRuntimeSnapshotImportCommand(target, { stackName, archivePath, snapshotId, requiredComponents }) {
  const paths = resolveRemoteStackStatePaths(target, { stackName, runtimeMode: 'controlled' });
  const args = ['./apps/stack/scripts/utils/dev_targets/runtime_artifact_transfer.mjs', `--archive=${archivePath}`, `--stack-base-dir=${paths.stackBaseDir}`, `--snapshot-id=${snapshotId}`,
    ...(requiredComponents ? [`--required-components=${requiredComponents.join(',')}`] : [])];
  const quote = target.platform === 'windows' ? powershellQuote : posixQuote;
  return wrapRemoteScript(target, target.platform === 'windows'
    ? `$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath ${quote(target.repoDir)}; node ${args.map(quote).join(' ')}; exit $LASTEXITCODE`
    : `set -euo pipefail; cd -- ${quote(target.repoDir)}; exec node ${args.map(quote).join(' ')}`);
}

export function buildRemoteRuntimeSnapshotProbeCommand(target, { stackName, snapshotId }) {
  const paths = resolveRemoteStackStatePaths(target, { stackName, runtimeMode: 'controlled' });
  const expression = `const fs=require('node:fs');const s=JSON.parse(fs.readFileSync(${JSON.stringify(paths.stackBaseDir + '/stack.runtime.json')},'utf8'));process.exit(s.runtimeSnapshotId===${JSON.stringify(snapshotId)}?0:1)`;
  const quote = target.platform === 'windows' ? powershellQuote : posixQuote;
  return wrapRemoteScript(target, target.platform === 'windows' ? `node -e ${quote(expression)}; exit $LASTEXITCODE` : `exec node -e ${quote(expression)}`);
}

function resolveRemoteStackInvocation(target, {
  services,
  serverUrl,
  publicServerUrl = '',
  canonicalServerUrl = '',
  stackName,
  remoteServerPort = null,
  remoteExpoPort = null,
  expoPublicPort = null,
  expoPublicUrl = '',
  startMobile = false,
  resolveServerPublicUrlOnTarget = false,
  resolveExpoPublicUrlOnTarget = false,
  remoteServerRuntimeConfig = null,
  deferDaemonStartUntilCredentials = false,
  attended = false,
  runtimeMode = 'source',
  runtimeSnapshotId = null,
  borrowedExpoProducerStackName = '',
}) {
  const normalizedServices = {
    server: services?.server === true,
    expo: services?.expo === true,
    daemon: services?.daemon === true,
  };
  if (!Object.values(normalizedServices).some(Boolean)) {
    throw new Error('[dev-targets] remote Stack command requires at least one service');
  }
  const serverPort = normalizedServices.server
    ? requireServicePort(remoteServerPort, 'remote server port')
    : null;
  const serverRuntimeConfig = normalizedServices.server
    ? normalizeRemoteServerRuntimeConfig(remoteServerRuntimeConfig)
    : null;
  const stablePublicServerUrl = normalizedServices.server
    ? (resolveServerPublicUrlOnTarget ? '' : requireStableOuterServerUrl(publicServerUrl))
    : publicServerUrl;
  // The signed auth audience belongs to the originating Stack: every client reaches this server
  // through the origin's canonical origin, so the remote server must sign that one instead of the
  // canonical origin the target would derive from its own Stack name and forwarded port.
  const originCanonicalServerUrl = normalizedServices.server && String(canonicalServerUrl ?? '').trim()
    ? requireStableOuterServerUrl(canonicalServerUrl, { label: 'canonical server URL' })
    : '';
  const expoPort = normalizedServices.expo
    ? requireServicePort(remoteExpoPort, 'remote Expo port')
    : null;
  const stablePublicExpoPort = normalizedServices.expo && resolveExpoPublicUrlOnTarget
    ? requireServicePort(expoPublicPort, 'public Expo port')
    : null;
  const {
    activeServerId,
    stackName: remoteStackName,
    stackStorageDir,
    stackBaseDir,
    stackEnvPath,
    cliHomeDir,
    workspaceDir,
  } = resolveRemoteStackStatePaths(target, { stackName, runtimeMode });
  const stackServerComponent = serverRuntimeConfig?.serverComponentName ?? 'happier-server-light';
  const stackDbProvider = serverRuntimeConfig?.dbProvider ?? 'sqlite';
  const stackEnvLines = [
    `HAPPIER_STACK_REPO_DIR=${target.repoDir}`,
    `HAPPIER_STACK_CLI_HOME_DIR=${cliHomeDir}`,
    ...(runtimeMode === 'controlled' ? [
      'HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES=0',
      'HAPPIER_STACK_UPDATE_CHECK=0',
      `HAPPIER_STACK_INVOKED_CWD=${workspaceDir}`,
      ...(borrowedExpoProducerStackName ? [`HAPPIER_STACK_EXPO_SOURCE_STACK=${borrowedExpoProducerStackName}`] : []),
    ] : []),
    `HAPPIER_STACK_SERVER_COMPONENT=${stackServerComponent}`,
    `HAPPIER_DB_PROVIDER=${stackDbProvider}`,
    ...Object.entries(serverRuntimeConfig?.environment ?? {}).map(([key, value]) => `${key}=${value}`),
    `HAPPIER_CLI_PKGROLL_TIMEOUT_MS=${DEFAULT_REMOTE_STACK_STARTUP_TIMEOUT_MS}`,
    'HAPPIER_DEV_TARGET_EXECUTION=1',
    ...(normalizedServices.daemon && deferDaemonStartUntilCredentials
      ? ['HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH=1']
      : []),
    ...(serverPort ? [`HAPPIER_STACK_SERVER_PORT=${serverPort}`] : []),
    ...(runtimeMode === 'controlled' && stablePublicServerUrl ? [`HAPPIER_PUBLIC_SERVER_URL=${stablePublicServerUrl}`] : []),
    ...(originCanonicalServerUrl ? [`HAPPIER_CANONICAL_SERVER_URL=${originCanonicalServerUrl}`] : []),
    ...(expoPort ? [
      `HAPPIER_STACK_EXPO_DEV_PORT=${expoPort}`,
      'HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY=stable',
      'HAPPIER_STACK_EXPO_HOST=localhost',
    ] : []),
    ...(stablePublicExpoPort ? [`HAPPIER_STACK_EXPO_PUBLIC_PORT=${stablePublicExpoPort}`] : []),
    ...(expoPublicUrl && !resolveExpoPublicUrlOnTarget ? [`EXPO_PACKAGER_PROXY_URL=${expoPublicUrl}`] : []),
  ];
  const devArgs = runtimeMode === 'controlled'
    ? ['--runtime', '--no-dev-targets', '--no-browser', ...(!normalizedServices.daemon ? ['--no-daemon'] : []), ...(borrowedExpoProducerStackName ? ['--no-ui'] : [])]
    : buildRemoteDevArgs({
    services: normalizedServices,
    serverUrl,
    publicServerUrl: stablePublicServerUrl,
    startMobile,
  });
  return {
    activeServerId,
    attended: attended === true,
    runtimeMode,
    runtimeSnapshotId,
    cliHomeDir,
    workspaceDir,
    devArgs,
    stackBaseDir,
    stackEnvLines,
    stackEnvPath,
    stackServerComponent,
    stackDbProvider,
    stackName: remoteStackName,
    stackStorageDir,
  };
}

function buildWindowsRemoteStackPrelude(target, invocation) {
  return [
    '$ErrorActionPreference = "Stop"',
    `$env:HAPPIER_HOME_DIR = ${powershellQuote(invocation.cliHomeDir)}`,
    `$env:HAPPIER_STACK_HOME_DIR = ${powershellQuote(target.cliHomeDir)}`,
    `$env:HAPPIER_STACK_CLI_HOME_DIR = ${powershellQuote(invocation.cliHomeDir)}`,
    `$env:HAPPIER_STACK_STORAGE_DIR = ${powershellQuote(invocation.stackStorageDir)}`,
    `$env:HAPPIER_STACK_PM_CACHE_BASE_DIR = ${powershellQuote(`${String(target.cliHomeDir).replace(/[\\/]+$/, '')}/cache`)}`,
    `$env:HAPPIER_STACK_STACK = ${powershellQuote(invocation.stackName)}`,
    `$env:HAPPIER_ACTIVE_SERVER_ID = ${powershellQuote(invocation.activeServerId)}`,
    `$env:HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID = ${powershellQuote(invocation.activeServerId)}`,
    ...(invocation.attended ? ["$env:HAPPIER_STACK_TUI = '1'"] : []),
    `Set-Location -LiteralPath ${powershellQuote(target.repoDir)}`,
    ...(invocation.runtimeMode === 'controlled' ? [
      `New-Item -ItemType Directory -Force -Path ${powershellQuote(invocation.cliHomeDir)},${powershellQuote(invocation.workspaceDir)} | Out-Null`,
      "$env:HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES = '0'",
      "$env:HAPPIER_STACK_UPDATE_CHECK = '0'",
    ] : []),
  ];
}

function buildPosixRemoteStackPrelude(target, invocation) {
  return [
    'set -euo pipefail',
    `export HAPPIER_HOME_DIR=${posixQuote(invocation.cliHomeDir)}`,
    `export HAPPIER_STACK_HOME_DIR=${posixQuote(target.cliHomeDir)}`,
    `export HAPPIER_STACK_CLI_HOME_DIR=${posixQuote(invocation.cliHomeDir)}`,
    `export HAPPIER_STACK_STORAGE_DIR=${posixQuote(invocation.stackStorageDir)}`,
    `export HAPPIER_STACK_PM_CACHE_BASE_DIR=${posixQuote(`${String(target.cliHomeDir).replace(/[\\/]+$/, '')}/cache`)}`,
    `export HAPPIER_STACK_STACK=${posixQuote(invocation.stackName)}`,
    `export HAPPIER_ACTIVE_SERVER_ID=${posixQuote(invocation.activeServerId)}`,
    `export HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID=${posixQuote(invocation.activeServerId)}`,
    ...(invocation.attended ? ['export HAPPIER_STACK_TUI=1'] : []),
    `cd -- ${posixQuote(target.repoDir)}`,
    ...(invocation.runtimeMode === 'controlled' ? [
      `mkdir -p -- ${posixQuote(invocation.cliHomeDir)} ${posixQuote(invocation.workspaceDir)}`,
      'export HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES=0',
      'export HAPPIER_STACK_UPDATE_CHECK=0',
    ] : []),
  ];
}

function buildWindowsRemoteStackInitializationCommands(target, invocation) {
  return [
    `corepack yarn workspace @happier-dev/stack stack new ${powershellQuote(invocation.stackName)} --server=${powershellQuote(invocation.stackServerComponent)} --db-provider=${powershellQuote(invocation.stackDbProvider)} --repo=${powershellQuote(target.repoDir)} --no-copy-auth --non-interactive --if-missing`,
    `corepack yarn workspace @happier-dev/stack stack env ${powershellQuote(invocation.stackName)} set ${invocation.stackEnvLines.map(powershellQuote).join(' ')}`,
  ];
}

function buildPosixRemoteStackInitializationCommands(target, invocation) {
  return [
    `corepack yarn workspace @happier-dev/stack stack new ${posixQuote(invocation.stackName)} --server=${posixQuote(invocation.stackServerComponent)} --db-provider=${posixQuote(invocation.stackDbProvider)} --repo=${posixQuote(target.repoDir)} --no-copy-auth --non-interactive --if-missing`,
    `corepack yarn workspace @happier-dev/stack stack env ${posixQuote(invocation.stackName)} set ${invocation.stackEnvLines.map(posixQuote).join(' ')}`,
  ];
}

export function buildRemoteStackStopCommand(target, options) {
  const invocation = resolveRemoteStackInvocation(target, options);
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        ...buildWindowsRemoteStackPrelude(target, invocation),
        "$env:HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES = '0'",
        "$env:HAPPIER_STACK_UPDATE_CHECK = '0'",
        `corepack yarn workspace @happier-dev/stack stack stop ${powershellQuote(invocation.stackName)} --yes --no-docker`,
        'exit $LASTEXITCODE',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      ...buildPosixRemoteStackPrelude(target, invocation),
      'export HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES=0',
      'export HAPPIER_STACK_UPDATE_CHECK=0',
      `exec corepack yarn workspace @happier-dev/stack stack stop ${posixQuote(invocation.stackName)} --yes --no-docker`,
    ].join('; '),
  );
}

export function buildRemoteStackCommand(target, options) {
  const invocation = resolveRemoteStackInvocation(target, options);
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        ...buildWindowsRemoteStackPrelude(target, invocation),
        ...buildWindowsRemoteStackInitializationCommands(target, invocation).flatMap((command) => [
          command,
          'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        ]),
        `corepack yarn workspace @happier-dev/stack stack ${invocation.runtimeMode === 'controlled' ? 'start' : 'dev'} ${powershellQuote(invocation.stackName)} ${invocation.devArgs.map(formatPowerShellDevArg).join(' ')}`,
        'exit $LASTEXITCODE',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      ...buildPosixRemoteStackPrelude(target, invocation),
      ...buildPosixRemoteStackInitializationCommands(target, invocation),
      `exec corepack yarn workspace @happier-dev/stack stack ${invocation.runtimeMode === 'controlled' ? 'start' : 'dev'} ${posixQuote(invocation.stackName)} ${invocation.devArgs.map(formatPosixDevArg).join(' ')}`,
    ].join('; '),
  );
}

export function buildRemoteDaemonCommand(target, { serverUrl, activeServerId, stackName }) {
  return buildRemoteStackCommand(target, {
    services: { server: false, expo: false, daemon: true },
    serverUrl,
    activeServerId,
    stackName,
  });
}

export function buildRemoteForwardProbeCommand(target, { remoteServerPort }) {
  const port = Math.trunc(Number(remoteServerPort));
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        '$client = [System.Net.Sockets.TcpClient]::new()',
        `try { $client.Connect('127.0.0.1', ${port}) } finally { $client.Dispose() }`,
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      `exec 3<>/dev/tcp/127.0.0.1/${port}`,
      'exec 3>&-',
    ].join('; '),
  );
}

export function buildRemoteDaemonReadinessProbeCommand(target, { stackName, runtimeMode = 'source' }) {
  const { activeServerId, cliHomeDir } = resolveRemoteStackStatePaths(target, { stackName, runtimeMode });
  const statePath = `${cliHomeDir}/servers/${String(activeServerId)}/daemon.state.json`;
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        `$statePath = ${powershellQuote(statePath)}`,
        'if (-not (Test-Path -LiteralPath $statePath)) { exit 1 }',
        '$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json',
        'if ($null -eq $state.pid) { exit 1 }',
        '$daemonProcess = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue',
        'if ($null -eq $daemonProcess) { exit 1 }',
        'exit 0',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      `state_path=${posixQuote(statePath)}`,
      '[ -f "$state_path" ] || exit 1',
      'daemon_pid=$(sed -n \'s/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p\' "$state_path" | head -n 1)',
      'case "$daemon_pid" in \'\'|*[!0-9]*) exit 1 ;; esac',
      'kill -0 "$daemon_pid" 2>/dev/null',
    ].join('; '),
  );
}

export function buildSshTunnelArgs(
  target,
  { localServerPort, remoteServerPort, sshArgs = [] },
) {
  return [
    '-T',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    ...sshArgs,
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-N',
    '-R',
    `127.0.0.1:${remoteServerPort}:127.0.0.1:${localServerPort}`,
    target.ssh,
  ];
}

function formatSshForward(forward) {
  const direction = forward?.direction;
  if (direction !== 'local' && direction !== 'reverse') {
    throw new Error('[dev-targets] SSH forward direction must be local or reverse');
  }
  const listenHost = String(forward.listenHost ?? '127.0.0.1').trim();
  const targetHost = String(forward.targetHost ?? '127.0.0.1').trim();
  if (!/^[A-Za-z0-9.:[\]-]+$/.test(listenHost) || !/^[A-Za-z0-9.:[\]-]+$/.test(targetHost)) {
    throw new Error('[dev-targets] invalid SSH forward host');
  }
  // OpenSSH treats `0.0.0.0` as IPv4-only, while `*` is its native dual-stack
  // wildcard. LAN-exposed local forwards (notably remote Metro) must remain
  // reachable when a device resolves this Mac through IPv6/Tailscale.
  const effectiveListenHost = direction === 'local' && listenHost === '0.0.0.0'
    ? '*'
    : listenHost;
  const listenPort = requireServicePort(forward.listenPort, 'SSH forward listen port');
  const targetPort = requireServicePort(forward.targetPort, 'SSH forward target port');
  return {
    flag: direction === 'local' ? '-L' : '-R',
    specification: `${effectiveListenHost}:${listenPort}:${targetHost}:${targetPort}`,
  };
}

export function buildSshForwardArgs(target, { forwards, sshArgs = [] } = {}) {
  if (!Array.isArray(forwards) || forwards.length === 0) {
    throw new Error('[dev-targets] at least one SSH forward is required');
  }
  return [
    '-T',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    ...sshArgs,
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    ...forwards.flatMap((forward) => {
      const formatted = formatSshForward(forward);
      return [formatted.flag, formatted.specification];
    }),
    '-N',
    target.ssh,
  ];
}

export function buildSshWorkerArgs(
  target,
  { remoteCommand, sshArgs = [], tty = target.platform !== 'windows' },
) {
  return [
    tty ? '-tt' : '-T',
    ...sshArgs,
    '-o',
    'BatchMode=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    target.ssh,
    remoteCommand,
  ];
}
