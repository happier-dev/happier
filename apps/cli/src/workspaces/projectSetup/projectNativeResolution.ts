import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ProjectDefinitionDetectionV1, ProjectDevcontainerSelectionV1, ProjectToolchainSelectionV1, ProjectExecutionInputV1, ProjectNativeRefV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import type { PluginProjectNativeCommandResultV1 } from '@happier-dev/plugin-sdk';
import { preserveUnconfirmedNativeProcess, type ProjectNativeAdapterProductionV1 } from '@/plugins/runtime/lifecycle/contributions/targetProjectNativeAdapters';
import { readProjectDefinitionFileBytes } from './nativeDefinitionFiles';
import { readLiteralCommandExecutedFiles, type LiteralCommandFileFactV1, type LiteralCommandLines } from './literalCommandFiles';
import { getPathRemainderWithinBase } from '@/session/handoff/paths/sessionHandoffPathNormalization';
import { inspectProjectDefinitionFacts } from './nativeDefinitionInspection';
import { collectNativeDiscoveryFiles, collectNativePackageDirectories, isNativeDefinitionRecord, parseNativePackage, resolveNativePackageManager, type NativePackage, type NativePackageManagerSelection } from './nativePackageScripts';
import { createFloxServiceActivationArgs } from './floxServiceActivation';
import { MANAGED_SERVICE_NUMERIC_CONTRACT } from '@/plugins/runtime/invocation/services/managedServiceSpecNormalization';

export type ProjectNativeRefusal = Readonly<{ kind: 'refused'; reason: 'missing' | 'outside_root' | 'invalid' | 'dynamic_unsupported' | 'unavailable' | 'unsupported' | 'cancelled'; code: string }>;
export type ProjectNativeFileFact = Readonly<{ file: string; content: string }>;
export type ProjectNativeCommandIo = Readonly<{
    /** Resolve an installed managed/system tool only. No installation or command execution. */
    resolveTool(tool: string, request: Readonly<{ cwd: string; version?: string; signal?: AbortSignal }>): Promise<Readonly<{ executablePath: string; args?: readonly string[]; version?: string; environmentOverlay?: Readonly<Record<string, string>> }> | null>;
}>;
export type ProjectNativeCommandResult = ProjectNativeRefusal | Readonly<{
    kind: 'resolved'; command: string; args: readonly string[]; cwd: string;
    reviewInputs: readonly ProjectNativeFileFact[];
    /** Checkout files the selected package script or recipe lines run; part of every reviewed effect. */
    executedFiles?: readonly LiteralCommandFileFactV1[];
    toolchain: Readonly<{ tool: string; version?: string }>;
    /** Semantic invocation before installed runtime prefixes and target-local launch environment. */
    reviewInvocation: Readonly<{ args: readonly string[]; environmentOverlay?: Readonly<Record<string, string>> }>;
    packageManager?: NativePackageManagerSelection;
    nativeCommandToolchain?: ProjectToolchainSelectionV1;
    environmentOverlay?: Readonly<Record<string, string>>;
}> | Readonly<{ kind: 'pluginResolved'; command: Extract<PluginProjectNativeCommandResultV1, { kind: 'resolved' }> }>;

const refuse = (reason: ProjectNativeRefusal['reason'], code: string): ProjectNativeRefusal => ({ kind: 'refused', reason, code });
async function selectedFile(root: string, file: string, readBytes = readProjectDefinitionFileBytes): Promise<ProjectNativeFileFact | ProjectNativeRefusal> {
    const read = await readBytes(root, file);
    if (read.kind === 'absent') return refuse('missing', 'native_configuration_missing');
    if (read.kind === 'refused') return refuse(read.code === 'outside_root' ? 'outside_root' : 'invalid', read.code);
    return { file: relative(resolve(root), resolve(root, file.replaceAll('\\', '/'))).replaceAll('\\', '/'), content: read.bytes.toString('utf8') };
}

type PackageScriptBasis = Readonly<{
    kind: 'selected'; cwd: string; pkg: NativePackage; packageManager: NativePackageManagerSelection; reviewInputs: readonly ProjectNativeFileFact[];
}>;

const PACKAGE_SCRIPT_RUN = /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)(?:\s+-{1,2}[\w-]+)*\s+(?:run(?:-script)?\s+)?([^\s;&|()'"]+)/gu;
/** `run <target>` executes its pre/post scripts and the package scripts its lines run by name. */
function packageScriptCommandLines(scripts: Readonly<Record<string, string>>, target: string): string[] {
    const lines: string[] = [];
    const seen = new Set<string>();
    const queue = [target];
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
        for (const script of [`pre${name}`, name, `post${name}`]) {
            if (seen.has(script) || !Object.hasOwn(scripts, script)) continue;
            seen.add(script);
            lines.push(scripts[script]!);
            for (const match of scripts[script]!.matchAll(PACKAGE_SCRIPT_RUN)) if (Object.hasOwn(scripts, match[1]!)) queue.push(match[1]!);
        }
    }
    return lines;
}

/** Recipe lines of a make/just target and the targets it depends on in the same file (lexical). */
function recipeCommandLines(content: string, tool: 'make' | 'just', target: string): string[] {
    const recipes = new Map<string, { deps: string[]; lines: string[] }>();
    let current: { deps: string[]; lines: string[] }[] = [];
    for (const raw of content.split(/\r?\n/u)) {
        if (/^\s/u.test(raw)) {
            const line = raw.trim().replace(/^[@+-]+/u, '');
            if (line && !line.startsWith('#')) for (const recipe of current) recipe.lines.push(line);
            continue;
        }
        current = [];
        const header = tool === 'make' ? /^([^:#=\s][^:#=]*?)\s*::?(?!=)\s*([^;#]*)(?:;(.*))?$/u.exec(raw)
            : /^@?([A-Za-z_][\w-]*)\b[^:=]*:(?!=)\s*([^#]*)$/u.exec(raw);
        if (!header) continue;
        const deps = header[2]!.split(/\s+/u).map(dep => dep.replace(/^\(|\)$/gu, '')).filter(Boolean);
        for (const name of tool === 'make' ? header[1]!.split(/\s+/u) : [header[1]!]) {
            const recipe = recipes.get(name) ?? { deps: [], lines: [] };
            recipe.deps.push(...deps);
            if (header[3]?.trim()) recipe.lines.push(header[3].trim());
            recipes.set(name, recipe);
            current.push(recipe);
        }
    }
    const lines: string[] = [];
    const seen = new Set<string>();
    const queue = [target];
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
        const recipe = recipes.get(name);
        if (seen.has(name) || !recipe) continue;
        seen.add(name);
        lines.push(...recipe.lines);
        queue.push(...recipe.deps);
    }
    return lines;
}

type CommandLine = Exclude<LiteralCommandLines, string>[number];
/** mise runs tasks from the config root: the file's folder, or the project above `.config/mise/`. */
function miseConfigRoot(file: string): string {
    const normalized = file.replaceAll('\\', '/');
    return normalized.endsWith('/.config/mise/config.toml') ? dirname(dirname(dirname(file))) : dirname(file);
}
/** What a selected native target runs: its command lines and further files it loads directly. */
type NativeExecutedInputs = Readonly<{ lines: readonly CommandLine[]; files?: readonly string[] }>;
const textList = (value: unknown): string[] => typeof value === 'string' ? [value]
    : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const recordOf = (value: unknown): Readonly<Record<string, unknown>> => isNativeDefinitionRecord(value) ? value : {};

/** Visit a target and the same-file tasks it names, once each. */
function taskClosure(target: string, visit: (name: string, push: (command: string, cwd: string) => void, queue: (name: string) => void) => void): CommandLine[] {
    const lines: CommandLine[] = [];
    const seen = new Set<string>();
    const queue = [target];
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
        if (seen.has(name)) continue;
        seen.add(name);
        visit(name, (command, cwd) => lines.push({ command, cwd }), next => queue.push(next));
    }
    return lines;
}

async function taskfileExecutedInputs(content: string, target: string, base: string): Promise<NativeExecutedInputs> {
    const yaml = await import('yaml');
    const tasks = recordOf(recordOf({ ...yaml.default, ...yaml }.parse(content)).tasks);
    return { lines: taskClosure(target, (name, push, queue) => {
        const task = tasks[name];
        if (typeof task === 'string') return push(task, base);
        const definition: Readonly<Record<string, unknown>> = isNativeDefinitionRecord(task) ? task : { cmds: task };
        const dir = typeof definition.dir === 'string' ? resolve(base, definition.dir) : base;
        for (const item of [definition.cmd, ...(Array.isArray(definition.cmds) ? definition.cmds : [definition.cmds])]) {
            if (typeof item === 'string') push(item, dir);
            else if (isNativeDefinitionRecord(item)) {
                if (typeof item.cmd === 'string') push(item.cmd, dir);
                if (typeof item.task === 'string') queue(item.task);
            }
        }
        for (const dep of Array.isArray(definition.deps) ? definition.deps : []) {
            if (typeof dep === 'string') queue(dep);
            else if (isNativeDefinitionRecord(dep) && typeof dep.task === 'string') queue(dep.task);
        }
    }) };
}

async function miseExecutedInputs(content: string, target: string, base: string): Promise<NativeExecutedInputs> {
    const tasks = recordOf(recordOf((await import('smol-toml')).parse(content)).tasks);
    const files: string[] = [];
    const lines = taskClosure(target, (name, push, queue) => {
        const task = tasks[name];
        const definition: Readonly<Record<string, unknown>> = isNativeDefinitionRecord(task) ? task : { run: task };
        const dir = typeof definition.dir === 'string' ? resolve(base, definition.dir) : base;
        for (const item of Array.isArray(definition.run) ? definition.run : [definition.run]) {
            if (typeof item === 'string') push(item, dir);
            else if (isNativeDefinitionRecord(item)) for (const next of [...textList(item.task), ...textList(item.tasks)]) queue(next);
        }
        if (typeof definition.file === 'string') files.push(resolve(base, definition.file));
        for (const dep of [...textList(definition.depends), ...textList(definition.depends_post)]) queue(dep.trim().split(/\s+/u)[0]!);
    });
    return { lines, files };
}

function devboxExecutedInputs(content: string, target: string, base: string): NativeExecutedInputs {
    const shell = recordOf(recordOf(JSON.parse(content)).shell);
    // `devbox run` runs the init_hook before the selected script.
    return { lines: [...textList(shell.init_hook), ...textList(recordOf(shell.scripts)[target])].map(command => ({ command, cwd: base })) };
}

/** `turbo run <task>` runs that package script (and the tasks it depends on) in every package under turbo.json. */
async function turboExecutedInputs(root: string, content: string, target: string, base: string): Promise<NativeExecutedInputs> {
    const pipeline = recordOf((value => value.tasks ?? value.pipeline)(recordOf((await import('json5')).default.parse(content))));
    const names = new Set<string>();
    taskClosure(target, (name, _push, queue) => {
        names.add(name);
        for (const dep of textList(recordOf(pipeline[name]).dependsOn)) if (!dep.startsWith('$')) queue(dep.replace(/^\^/u, '').split('#').at(-1)!);
    });
    const lines: CommandLine[] = [];
    const files: string[] = [];
    for (const directory of await collectNativePackageDirectories(base)) {
        const file = join(directory, 'package.json');
        files.push(file);
        const read = await readProjectDefinitionFileBytes(root, relative(root, file));
        if (read.kind !== 'read') continue;
        let scripts: Readonly<Record<string, string>>;
        try { scripts = parseNativePackage(read.bytes.toString('utf8'), directory).scripts; } catch { continue; }
        for (const name of names) lines.push(...packageScriptCommandLines(scripts, name).map(command => ({ command, cwd: directory })));
    }
    return { lines, files };
}

async function readPackageScriptBasis(params: Readonly<{ root: string; file: string; inheritAncestors?: boolean }>,
    readBytes = readProjectDefinitionFileBytes): Promise<PackageScriptBasis | ProjectNativeRefusal> {
    const fact = await selectedFile(params.root, params.file, readBytes);
    if ('kind' in fact) return fact;
    if (basename(fact.file) !== 'package.json') return refuse('unsupported', 'native_configuration_filename_unsupported');
    const cwd = dirname(resolve(params.root, fact.file));
    try {
        const pkg = parseNativePackage(fact.content, cwd);
        const packageManager = await resolveNativePackageManager(cwd, params.inheritAncestors ? undefined : resolve(params.root), async (root, file) => {
            const read = await readBytes(root, file);
            return read.kind === 'read' ? { kind: 'read', content: read.bytes.toString('utf8') } : read;
        });
        if (packageManager.root === cwd && (pkg.packageManager !== undefined || packageManager.version !== undefined)
            && pkg.packageManager !== `${packageManager.manager}@${packageManager.version}`) return refuse('invalid', 'native_configuration_changed');
        const reviewInputs: ProjectNativeFileFact[] = [fact];
        if (packageManager.version && packageManager.root !== cwd && !params.inheritAncestors) {
            const managerFile = relative(resolve(params.root), resolve(packageManager.root, 'package.json')).replaceAll('\\', '/');
            const declaration = await selectedFile(params.root, managerFile, readBytes);
            if ('kind' in declaration) return declaration;
            if (parseNativePackage(declaration.content, packageManager.root).packageManager !== `${packageManager.manager}@${packageManager.version}`) return refuse('invalid', 'native_configuration_changed');
            reviewInputs.push(declaration);
        }
        return { kind: 'selected', cwd, pkg, packageManager, reviewInputs };
    } catch { return refuse('invalid', 'invalid_definition'); }
}

function selectPackageScript(basis: PackageScriptBasis | ProjectNativeRefusal, target: string) {
    if (basis.kind === 'refused') return basis;
    if (!Object.hasOwn(basis.pkg.scripts, target)) return refuse('missing', 'native_target_missing');
    if (!target || /^-|[\0\r\n]/u.test(target)) return refuse('invalid', 'native_target_invalid');
    const { pkg, ...selected } = basis;
    return { ...selected, args: ['run', target], executedInputs: async (): Promise<NativeExecutedInputs> => ({ lines: packageScriptCommandLines(pkg.scripts, target) }) };
}

/** Single package-script intent producer, shared by Services and native command previews. */
export async function resolveNativePackageScript(params: Readonly<{ root: string; file: string; target: string; inheritAncestors?: boolean }>): Promise<ProjectNativeRefusal | Readonly<{
    kind: 'selected'; cwd: string; args: readonly string[]; packageManager: NativePackageManagerSelection; reviewInputs: readonly ProjectNativeFileFact[];
    executedInputs: () => Promise<NativeExecutedInputs>;
}>> {
    return selectPackageScript(await readPackageScriptBasis(params), params.target);
}

type NativeInspectionReads = Readonly<{
    readBytes: typeof readProjectDefinitionFileBytes;
    packageScript(file: string): Promise<PackageScriptBasis | ProjectNativeRefusal>;
    definition(fact: ProjectNativeFileFact, format: Extract<ProjectNativeRefV1, { kind: 'native' }>['tool']): Promise<ProjectDefinitionDetectionV1>;
}>;

/** Resolve the actual contained config; does not produce or evaluate its environment. */
export async function resolveProjectToolchainSelection(params: Readonly<{ root: string; selection: ProjectToolchainSelectionV1 }>): Promise<ProjectNativeRefusal | Readonly<{
    kind: 'selected'; selection: ProjectToolchainSelectionV1; file?: string; content?: string; coverage: 'complete' | 'partial'; diagnostics: readonly Readonly<{ file: string; code: string }>[];
    /** Checkout files the environment loads beyond its config file (imported `.nix`, locks, hook-run and sourced scripts). */
    executedFiles?: readonly LiteralCommandFileFactV1[];
}>> {
    const selection = params.selection;
    if (selection.kind === 'host') return { kind: 'selected', selection, coverage: 'complete', diagnostics: [] };
    if (!selection.configPath) return refuse('missing', 'native_configuration_missing');
    const fact = await selectedFile(params.root, selection.configPath);
    if ('kind' in fact) return fact;
    const normalized = { ...selection, configPath: fact.file };
    if (selection.kind === 'pluginToolchain') return { kind: 'selected', selection: normalized, ...fact, coverage: 'complete', diagnostics: [] };
    const detection = await inspectProjectDefinitionFacts(params.root, [{ ...fact, format: selection.tool }]);
    if (!detection.toolchains.some(candidate => candidate.kind === 'toolchain' && candidate.tool === selection.tool)) return refuse('invalid', 'invalid_definition');
    let inputs: NativeExecutedInputs;
    try { inputs = await toolchainExecutedInputs(selection.tool, resolve(params.root, fact.file), fact.content); }
    catch { return refuse('invalid', 'invalid_definition'); }
    const executed = await readLiteralCommandExecutedFiles(params.root, dirname(resolve(params.root, fact.file)), inputs.lines, inputs.files ? { files: inputs.files } : undefined);
    if (executed.kind === 'refused') return refuse(executed.code === 'outside_root' ? 'outside_root' : 'invalid', executed.code);
    return { kind: 'selected', selection: normalized, ...fact, coverage: detection.coverage, diagnostics: detection.diagnostics,
        ...(executed.files.length ? { executedFiles: executed.files } : {}) };
}

/**
 * What an environment loads beyond its config file. Nix and devenv evaluate every `.nix` file
 * under their root (not just the config), so all non-ignored ones and the locks are inputs; a
 * `.nix` edit re-asks. devbox runs `init_hook`; mise sources `_.source`.
 * Flox hooks live in its manifest, which is already the reviewed config file.
 */
async function toolchainExecutedInputs(tool: Extract<ProjectToolchainSelectionV1, { kind: 'toolchain' }>['tool'], file: string, content: string): Promise<NativeExecutedInputs> {
    const base = dirname(file);
    if (tool === 'nix_flake' || tool === 'devenv') {
        const locks = tool === 'nix_flake' ? ['flake.lock'] : ['flake.lock', 'devenv.lock', 'devenv.yaml'];
        return { lines: [], files: [...await collectNativeDiscoveryFiles(base, name => name.endsWith('.nix')), ...locks.map(lock => join(base, lock))] };
    }
    if (tool === 'devbox') {
        // A devbox `include` is refused before review (unresolved_include), so only init_hook remains.
        return { lines: textList(recordOf(recordOf(JSON.parse(content)).shell).init_hook).map(command => ({ command, cwd: base })) };
    }
    if (tool === 'mise') {
        const sources = recordOf(recordOf(recordOf((await import('smol-toml')).parse(content)).env)._).source;
        const paths = (Array.isArray(sources) ? sources : [sources]).flatMap(item => typeof item === 'string' ? [item]
            : isNativeDefinitionRecord(item) && typeof item.path === 'string' ? [item.path] : []);
        return { lines: [], files: paths.filter(path => !path.startsWith('~')).map(path => resolve(miseConfigRoot(file), path)) };
    }
    return { lines: [] };
}

export async function resolveProjectDevcontainerSelection(params: Readonly<{ root: string; selection: ProjectDevcontainerSelectionV1 }>): Promise<ProjectNativeRefusal | Readonly<{
    kind: 'selected'; selection: ProjectDevcontainerSelectionV1; file: string; content: string;
}>> {
    if (!params.selection.configPath) return refuse('missing', 'native_configuration_missing');
    const fact = await selectedFile(params.root, params.selection.configPath);
    if ('kind' in fact) return fact;
    const detection = await inspectProjectDefinitionFacts(params.root, [{ ...fact, format: 'devcontainer' }]);
    if (!detection.devcontainers.length) return refuse('invalid', 'invalid_definition');
    return { kind: 'selected', selection: { ...params.selection, configPath: fact.file }, ...fact };
}

type NativeCommandIntent = Readonly<{
    kind: 'selected'; tool: string; args: readonly string[]; cwd: string; reviewInputs: readonly ProjectNativeFileFact[];
    /** Read lazily on the review path: what the target runs; the files it names join the reviewed effect. */
    executedInputs?: () => Promise<NativeExecutedInputs>;
    packageManager?: NativePackageManagerSelection;
    nativeCommandToolchain?: ProjectToolchainSelectionV1;
    environmentOverlay?: Readonly<Record<string, string>>;
}>;

export type ProjectNativeEnvironmentSelection = Readonly<{
    environmentInstanceId: string;
    services: readonly string[];
    physicalProjectName?: string;
}>;

/** Environment custody supplies the physical name; actors, releases and services do not. */
export function resolveEnvironmentComposeProjectName(environment: ProjectNativeEnvironmentSelection): string {
    const project = environment.physicalProjectName
        ?? `happier-${createHash('sha256').update(environment.environmentInstanceId).digest('hex')}`;
    if (!environment.environmentInstanceId || !/^[a-z0-9][a-z0-9_-]*$/u.test(project)) throw new Error('native_compose_project_invalid');
    return project;
}

/** The same static argv intent supplies preview and launch; availability is a separate installed fact. */
async function selectNativeCommand(input: Readonly<{
    root: string; source: Extract<ProjectNativeRefV1, { kind: 'native' }>; usage: 'script' | 'service' | 'setup';
    serviceScope?: string;
    environment?: ProjectNativeEnvironmentSelection;
}>, observation?: NativeInspectionReads): Promise<NativeCommandIntent | ProjectNativeRefusal> {
    const source = input.source;
    const fact = await selectedFile(input.root, source.file, observation?.readBytes);
    if ('kind' in fact) return fact;
    if (!source.target || /^-|[\0\r\n]/u.test(source.target)) return refuse('invalid', 'native_target_invalid');
    if ((source.tool === 'compose' || source.tool === 'procfile') && input.usage !== 'service') return refuse('unsupported', 'native_service_only');
    let cwd = dirname(resolve(input.root, source.file.replaceAll('\\', '/')));
    let args: readonly string[];
    let tool: string = source.tool;
    let packageManager: NativePackageManagerSelection | undefined;
    let nativeCommandToolchain: ProjectToolchainSelectionV1 | undefined;
    let environmentOverlay: Readonly<Record<string, string>> | undefined;
    let reviewInputs: readonly ProjectNativeFileFact[] = [fact];
    let executedInputs: (() => Promise<NativeExecutedInputs>) | undefined;
    if (source.tool === 'package_script') {
        const selected = observation
            ? selectPackageScript(await observation.packageScript(source.file), source.target)
            : await resolveNativePackageScript({ root: input.root, file: source.file, target: source.target });
        if (selected.kind === 'refused') return selected;
        ({ cwd, args, packageManager, reviewInputs, executedInputs } = selected);
        tool = packageManager.manager;
    } else if (source.tool === 'compose' && input.environment) {
        // Deployment review is authoritative only after native rendering. The
        // workspace discovery parser cannot reject a valid interpolated model.
        if (input.environment.services.some(service => !service || /^-|[\0\r\n]/u.test(service))) return refuse('invalid', 'native_target_invalid');
        let project: string;
        try { project = resolveEnvironmentComposeProjectName(input.environment); }
        catch { return refuse('invalid', 'native_compose_project_invalid'); }
        tool = 'docker';
        args = ['compose', '--project-name', project, '--file', resolve(input.root, fact.file),
            'up', '--detach', '--wait', '--remove-orphans', '--no-build', '--pull', 'never', ...input.environment.services];
    } else {
        const detection = observation ? await observation.definition(fact, source.tool)
            : await inspectProjectDefinitionFacts(input.root, [{ ...fact, format: source.tool }]);
        const entry = detection.entries.find(candidate => candidate.source.target === source.target && (source.tool !== 'flox' || (candidate.usage === 'service') === (input.usage === 'service')));
        if (!entry) return refuse(detection.coverage === 'partial' ? 'dynamic_unsupported' : 'missing', detection.diagnostics[0]?.code ?? 'native_target_missing');
        const literalDevenv = source.tool === 'devenv' && detection.diagnostics.every(diagnostic => diagnostic.code === 'unevaluated_nix');
        if (detection.coverage === 'partial' && !literalDevenv) return refuse('dynamic_unsupported', detection.diagnostics[0]?.code ?? 'dynamic_definition');
        const absoluteFile = resolve(input.root, source.file.replaceAll('\\', '/'));
        // Primary invocation contracts: GNU make -f; just --justfile; Task --taskfile;
        // mise run + explicit MISE_OVERRIDE_CONFIG_FILENAMES; Docker compose --file up;
        // Devbox run --config (directory); Flox build or owned service activation.
        switch (source.tool) {
            case 'make': args = ['-f', absoluteFile, source.target]; executedInputs = async () => ({ lines: recipeCommandLines(fact.content, 'make', source.target) }); break;
            case 'just': args = ['--justfile', absoluteFile, source.target]; executedInputs = async () => ({ lines: recipeCommandLines(fact.content, 'just', source.target) }); break;
            case 'taskfile': tool = 'task'; args = ['--taskfile', absoluteFile, source.target];
                executedInputs = () => taskfileExecutedInputs(fact.content, source.target, dirname(absoluteFile)); break;
            case 'mise':
                cwd = resolve(input.root);
                args = ['run', source.target];
                nativeCommandToolchain = { kind: 'toolchain', tool: 'mise', configPath: fact.file };
                environmentOverlay = { MISE_OVERRIDE_CONFIG_FILENAMES: absoluteFile };
                executedInputs = () => miseExecutedInputs(fact.content, source.target, miseConfigRoot(absoluteFile));
                break;
            case 'turbo':
                if (basename(absoluteFile) !== 'turbo.json') return refuse('unsupported', 'native_configuration_filename_unsupported');
                args = ['run', source.target];
                executedInputs = () => turboExecutedInputs(input.root, fact.content, source.target, dirname(absoluteFile)); break;
            case 'compose': {
                // A stable, requester-scoped native project is recoverable after daemon loss.
                // The container IDs captured by its lifecycle, not this name alone, own Stop.
                const project = `happier-${createHash('sha256').update(JSON.stringify([resolve(input.root), fact.file, source.target, input.serviceScope ?? ''])).digest('hex')}`;
                tool = 'docker'; args = ['compose', '--project-name', project, '--file', absoluteFile, 'up', '--detach', source.target]; break;
            }
            case 'devbox':
                if (basename(absoluteFile) !== 'devbox.json') return refuse('unsupported', 'native_configuration_filename_unsupported');
                args = ['run', '--config', cwd, source.target];
                executedInputs = async () => devboxExecutedInputs(fact.content, source.target, dirname(absoluteFile));
                nativeCommandToolchain = { kind: 'toolchain', tool: 'devbox', configPath: fact.file }; break;
            case 'flox':
                if (!source.file.replaceAll('\\', '/').endsWith('.flox/env/manifest.toml')) return refuse('unsupported', 'native_configuration_filename_unsupported');
                cwd = dirname(dirname(dirname(absoluteFile)));
                args = input.usage === 'service' ? ['services', 'start', '--dir', cwd, source.target] : ['build', '--dir', cwd, source.target];
                nativeCommandToolchain = { kind: 'toolchain', tool: 'flox', configPath: fact.file }; break;
            case 'procfile': return refuse('unsupported', 'procfile_runner_not_selected');
            case 'devenv':
                if (basename(absoluteFile) !== 'devenv.nix') return refuse('unsupported', 'native_configuration_filename_unsupported');
                // scripts.<name>.exec produces an executable inside the native shell.
                // This is an argv preview only: Nix evaluation remains an admitted effect.
                args = ['shell', '--', source.target];
                nativeCommandToolchain = { kind: 'toolchain', tool: 'devenv', configPath: fact.file }; break;
        }
    }
    return { kind: 'selected', tool, args, cwd, reviewInputs, ...(executedInputs ? { executedInputs } : {}), ...(packageManager ? { packageManager } : {}),
        ...(nativeCommandToolchain ? { nativeCommandToolchain } : {}), ...(environmentOverlay ? { environmentOverlay } : {}) };
}

async function resolveSelectedNativeCommand(intent: NativeCommandIntent, io: ProjectNativeCommandIo, signal?: AbortSignal): Promise<ProjectNativeRefusal | Extract<ProjectNativeCommandResult, { kind: 'resolved' }>> {
    const { tool, cwd, packageManager, reviewInputs, nativeCommandToolchain } = intent;
    let { args, environmentOverlay } = intent;
    const cancelled = () => refuse('cancelled', 'native_resolution_cancelled');
    if (signal?.aborted) return cancelled();
    try {
        const executable = await io.resolveTool(tool, { cwd, ...(packageManager?.version ? { version: packageManager.version } : {}), ...(signal ? { signal } : {}) });
        if (signal?.aborted) return cancelled();
        if (!executable) return refuse('unavailable', 'native_tool_unavailable');
        if (!isAbsolute(executable.executablePath) || executable.executablePath.includes('\0')) return refuse('invalid', 'native_tool_invalid');
        if (packageManager?.version && executable.version === undefined) return refuse('unavailable', 'native_tool_version_unresolved');
        if (packageManager?.version && executable.version !== packageManager.version) return refuse('unavailable', 'native_tool_version_mismatch');
        const floxService = tool === 'flox' && args[0] === 'services' && args[1] === 'start';
        if (floxService) {
            args = createFloxServiceActivationArgs({ command: executable.executablePath, prefixArgs: executable.args ?? [],
                root: cwd, target: args.at(-1)!, observationIntervalMs: MANAGED_SERVICE_NUMERIC_CONTRACT.healthIntervalMs.defaultValue });
            environmentOverlay = { ...environmentOverlay, FLOX_SHELL: '/bin/bash' };
        } else args = [...(executable.args ?? []), ...args];
        if (executable.environmentOverlay) environmentOverlay = { ...executable.environmentOverlay, ...environmentOverlay };
        return { kind: 'resolved', command: executable.executablePath, args, cwd, reviewInputs, toolchain: { tool, ...(executable.version ? { version: executable.version } : {}) },
            reviewInvocation: { args: floxService ? args.slice(executable.args?.length ?? 0) : intent.args,
                ...((floxService ? environmentOverlay : intent.environmentOverlay) ? { environmentOverlay: floxService ? environmentOverlay : intent.environmentOverlay } : {}) },
            ...(packageManager ? { packageManager } : {}), ...(nativeCommandToolchain ? { nativeCommandToolchain } : {}), ...(environmentOverlay ? { environmentOverlay } : {}) };
    } catch { return signal?.aborted ? cancelled() : refuse('unavailable', 'native_tool_unavailable'); }
}

/** Passive built-in intent and installed-tool facts; no plugin production callback. */
export async function inspectProjectNativeCommand(input: Readonly<{
    root: string; source: Extract<ProjectNativeRefV1, { kind: 'native' }>; usage: 'script' | 'service' | 'setup'; io: ProjectNativeCommandIo; signal?: AbortSignal;
    serviceScope?: string;
    environment?: ProjectNativeEnvironmentSelection;
}>): Promise<ProjectNativeRefusal | Extract<ProjectNativeCommandResult, { kind: 'resolved' }>> {
    if (input.signal?.aborted) return refuse('cancelled', 'native_resolution_cancelled');
    const intent = await selectNativeCommand(input);
    if (intent.kind === 'refused') return intent;
    const resolved = await resolveSelectedNativeCommand(intent, input.io, input.signal);
    if (resolved.kind !== 'resolved' || !intent.executedInputs) return resolved;
    // The definition file is a review input; the scripts its selected lines run are too.
    let inputs: NativeExecutedInputs;
    try { inputs = await intent.executedInputs(); } catch { return refuse('invalid', 'invalid_definition'); }
    const executed = await readLiteralCommandExecutedFiles(input.root, intent.cwd, inputs.lines, inputs.files ? { files: inputs.files } : undefined);
    if (input.signal?.aborted) return refuse('cancelled', 'native_resolution_cancelled');
    if (executed.kind === 'refused') return refuse('invalid', executed.code);
    return executed.files.length ? { ...resolved, executedFiles: executed.files } : resolved;
}

/** Plugin resolution may execute native effects and belongs to admitted execution. */
export async function resolveProjectNativeCommand(input: Readonly<{
    root: string; source: ProjectNativeRefV1; usage: 'script' | 'service' | 'setup'; io: ProjectNativeCommandIo; signal?: AbortSignal;
    serviceScope?: string;
    environment?: ProjectNativeEnvironmentSelection;
    plugin?: Readonly<{ lease: Pick<ProjectNativeAdapterProductionV1, 'resolveCommand' | 'isCurrent'> }>;
}>): Promise<ProjectNativeCommandResult> {
    const cancelled = () => refuse('cancelled', 'native_resolution_cancelled');
    if (input.signal?.aborted) return cancelled();
    const source = input.source;
    if (source.kind !== 'pluginNative') {
        return inspectProjectNativeCommand({ ...input, source });
    }
    const fact = await selectedFile(input.root, source.file);
    if ('kind' in fact) return fact;
    const port = input.plugin;
    if (!port || !port.lease.isCurrent()) return refuse('unavailable', 'native_adapter_unavailable');
    try {
        const result = await port.lease.resolveCommand({ root: input.root, adapter: source.adapter, files: [fact], source: { ...source, file: fact.file } }, input.signal ? { signal: input.signal } : undefined);
        if (result.kind === 'resolved') {
            if (result.nativeInstance && input.usage !== 'service') return refuse('unsupported', 'native_service_only');
            return { kind: 'pluginResolved', command: result };
        }
        return refuse(result.kind === 'failed' ? 'invalid' : result.kind, result.code);
    } catch (error) { preserveUnconfirmedNativeProcess(error); return input.signal?.aborted ? cancelled() : refuse('unavailable', 'native_adapter_failed'); }
}

export type ProjectImportCandidate = Readonly<{
    source: ProjectNativeRefV1; usage: ProjectDefinitionDetectionV1['entries'][number]['usage'];
    availability: 'available' | 'unavailable' | 'unresolved' | 'ambiguous'; code?: string; preselected: boolean;
    invocation?: Readonly<{ tool: string; args: readonly string[]; cwd: string; requestedVersion?: string }>;
    executionInputs?: readonly ProjectExecutionInputV1[];
}>;

/** The same contained raw-byte reader supplies passive admission and copied-target checks. */
export async function readProjectExecutionInputs(root: string, files: readonly string[], executablePath?: string): Promise<readonly ProjectExecutionInputV1[] | undefined> {
    return readExecutionInputs(root, files, executablePath);
}

async function readExecutionInputs(root: string, files: readonly string[], executablePath?: string,
    readBytes = readProjectDefinitionFileBytes): Promise<readonly ProjectExecutionInputV1[] | undefined> {
    const inputs: ProjectExecutionInputV1[] = [];
    const localExecutable = executablePath ? getPathRemainderWithinBase(executablePath, resolve(root)) : null;
    for (const file of [...new Set([...files, ...(localExecutable ? [localExecutable] : [])])].sort()) {
        const read = await readBytes(root, file);
        if (read.kind !== 'read') return undefined;
        inputs.push({ file: file.replaceAll('\\', '/'), hash: createHash('sha256').update(read.bytes).digest('hex') });
    }
    return inputs;
}

/** Native reference identity shared by passive imports and named Service discovery. */
export function projectNativeSourceKey(root: string, source: ProjectNativeRefV1): string {
    return JSON.stringify([source.kind, source.kind === 'native' ? source.tool : [source.adapter.pluginId, source.adapter.localId],
        relative(resolve(root), resolve(root, source.file.replaceAll('\\', '/'))).replaceAll('\\', '/'), source.target]);
}

/** Passive import projection. It never probes versions or invokes plugin effect callbacks. */
export async function inspectProjectImportCandidates(input: Readonly<{
    root: string; detection: ProjectDefinitionDetectionV1; io?: ProjectNativeCommandIo; signal?: AbortSignal;
}>): Promise<readonly ProjectImportCandidate[]> {
    return createProjectNativeInspection(input).inspectImportCandidates(input.detection);
}

/** One inspection observes each contained file and installed selection once.
 * The scope ends with this request; launch and subsequent inspections read afresh.
 */
export function createProjectNativeInspection(input: Readonly<{ root: string; io?: ProjectNativeCommandIo; signal?: AbortSignal }>) {
    const files = new Map<string, ReturnType<typeof readProjectDefinitionFileBytes>>();
    const packages = new Map<string, ReturnType<typeof readPackageScriptBasis>>();
    const definitions = new Map<string, Promise<ProjectDefinitionDetectionV1>>();
    const tools = new Map<string, ReturnType<ProjectNativeCommandIo['resolveTool']>>();
    const readBytes: typeof readProjectDefinitionFileBytes = (root, file) => {
        const key = JSON.stringify([root, file]);
        let read = files.get(key);
        if (!read) { read = readProjectDefinitionFileBytes(root, file); files.set(key, read); }
        return read;
    };
    const observation: NativeInspectionReads = {
        readBytes,
        packageScript(file) {
            let read = packages.get(file);
            if (!read) { read = readPackageScriptBasis({ root: input.root, file }, readBytes); packages.set(file, read); }
            return read;
        },
        definition(fact, format) {
            const key = JSON.stringify([fact.file, format]);
            let read = definitions.get(key);
            if (!read) { read = inspectProjectDefinitionFacts(input.root, [{ ...fact, format }]); definitions.set(key, read); }
            return read;
        },
    };
    const io: ProjectNativeCommandIo | undefined = input.io ? { resolveTool(tool, request) {
        const key = JSON.stringify([tool, request.cwd, request.version ?? null]);
        let read = tools.get(key);
        if (!read) { read = input.io!.resolveTool(tool, request); tools.set(key, read); }
        return read;
    } } : undefined;
    return {
        io,
        readExecutionInputs: (files: readonly string[], executablePath?: string) => readExecutionInputs(input.root, files, executablePath, readBytes),
        inspectImportCandidates: (detection: ProjectDefinitionDetectionV1, selection?: Readonly<{
            entries?: readonly ProjectDefinitionDetectionV1['entries'][number][]; executionInputs?: boolean;
        }>) => inspectImportCandidates({ ...input, io, detection, ...selection }, observation),
    };
}

async function inspectImportCandidates(input: Readonly<{
    root: string; detection: ProjectDefinitionDetectionV1; io?: ProjectNativeCommandIo; signal?: AbortSignal;
    entries?: readonly ProjectDefinitionDetectionV1['entries'][number][]; executionInputs?: boolean;
}>, observation: NativeInspectionReads): Promise<readonly ProjectImportCandidate[]> {
    const intents = new Map<string, ProjectDefinitionDetectionV1['entries'][number]>();
    const labelCounts = new Map<string, number>();
    const label = (entry: ProjectDefinitionDetectionV1['entries'][number]) => JSON.stringify([entry.usage, entry.source.target]);
    for (const entry of input.detection.entries) {
        const source = entry.source;
        const key = JSON.stringify([projectNativeSourceKey(input.root, source), entry.usage]);
        if (intents.has(key)) continue;
        intents.set(key, entry);
        labelCounts.set(label(entry), (labelCounts.get(label(entry)) ?? 0) + 1);
    }
    const candidates: ProjectImportCandidate[] = [];
    const selected = input.entries ? new Set(input.entries.map(entry => JSON.stringify([projectNativeSourceKey(input.root, entry.source), entry.usage]))) : null;
    for (const entry of intents.values()) {
        if (selected && !selected.has(JSON.stringify([projectNativeSourceKey(input.root, entry.source), entry.usage]))) continue;
        if (input.signal?.aborted) { candidates.push({ ...entry, availability: 'unresolved', code: 'native_resolution_cancelled', preselected: false }); continue; }
        if (entry.source.kind === 'pluginNative') {
            const executionInputs = input.executionInputs === false ? undefined : await readExecutionInputs(input.root, [entry.source.file], undefined, observation.readBytes);
            candidates.push({ ...entry, ...(executionInputs ? { executionInputs } : {}), availability: 'unresolved', code: 'native_adapter_availability_unresolved', preselected: false }); continue;
        }
        const intent = await selectNativeCommand({ root: input.root, source: entry.source, usage: entry.usage }, observation);
        let executionInputs = input.executionInputs !== false && intent.kind === 'selected' ? await readExecutionInputs(input.root, intent.reviewInputs.map(fact => fact.file), undefined, observation.readBytes) : undefined;
        // Passive previews are read in this checkout. Keep the exact launch/review
        // tuple in the resolver, and display its selected config relative to cwd.
        const configPath = resolve(input.root, entry.source.file.replaceAll('\\', '/'));
        const preview = intent.kind === 'selected' ? { invocation: { tool: intent.tool,
            args: intent.args.map((arg, index) => arg === configPath && index < intent.args.length - 1
                ? relative(intent.cwd, configPath) || '.' : arg), cwd: intent.cwd,
            ...(intent.packageManager?.version ? { requestedVersion: intent.packageManager.version } : {}) } } : {};
        const selectedFacts = () => ({ ...preview, ...(executionInputs ? { executionInputs } : {}) });
        if (!input.io) { candidates.push({ ...entry, ...selectedFacts(), availability: 'unresolved', code: 'native_tool_resolution_unavailable', preselected: false }); continue; }
        const result = intent.kind === 'refused' ? intent : await resolveSelectedNativeCommand(intent, input.io, input.signal);
        if (result.kind === 'resolved' && executionInputs) {
            executionInputs = await readExecutionInputs(input.root, executionInputs.map(fact => fact.file), result.command, observation.readBytes);
        }
        if (result.kind !== 'resolved') {
            const code = result.kind === 'refused' ? result.code : 'native_adapter_availability_unresolved';
            candidates.push({ ...entry, ...selectedFacts(), availability: code === 'native_tool_version_unresolved' || code === 'native_resolution_cancelled' ? 'unresolved' : 'unavailable', code, preselected: false });
        } else if ((labelCounts.get(label(entry)) ?? 0) > 1) {
            candidates.push({ ...entry, ...selectedFacts(), availability: 'ambiguous', code: 'native_import_name_ambiguous', preselected: false });
        } else candidates.push({ ...entry, ...selectedFacts(), availability: 'available', preselected: true });
    }
    return candidates;
}
