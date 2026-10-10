import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ProjectDefinitionDetectionV1, ProjectDevcontainerSelectionV1, ProjectEnvironmentSelectionV1, ProjectExecutionInputV1, ProjectNativeRefV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import type { PluginProjectNativeCommandResultV1 } from '@happier-dev/plugin-sdk';
import { preserveUnconfirmedNativeProcess, type ProjectNativeAdapterProductionV1 } from '@/plugins/runtime/lifecycle/contributions/targetProjectNativeAdapters';
import { readProjectDefinitionFile, readProjectDefinitionFileBytes } from './nativeDefinitionFiles';
import { getPathRemainderWithinBase } from '@/session/handoff/paths/sessionHandoffPathNormalization';
import { inspectProjectDefinitionFacts } from './projectDefinitionInspection';
import { parseNativePackage, resolveNativePackageManager, type NativePackageManagerSelection } from './nativePackageScripts';

export type ProjectNativeRefusal = Readonly<{ kind: 'refused'; reason: 'missing' | 'outside_root' | 'invalid' | 'dynamic_unsupported' | 'unavailable' | 'unsupported' | 'cancelled'; code: string }>;
export type ProjectNativeFileFact = Readonly<{ file: string; content: string }>;
export type ProjectNativeCommandIo = Readonly<{
    /** Resolve an installed managed/system tool only. No installation or command execution. */
    resolveTool(tool: string, request: Readonly<{ cwd: string; version?: string; signal?: AbortSignal }>): Promise<Readonly<{ executablePath: string; args?: readonly string[]; version?: string; environmentOverlay?: Readonly<Record<string, string>> }> | null>;
}>;
export type ProjectNativeCommandResult = ProjectNativeRefusal | Readonly<{
    kind: 'resolved'; command: string; args: readonly string[]; cwd: string;
    reviewInputs: readonly ProjectNativeFileFact[];
    toolchain: Readonly<{ tool: string; version?: string }>;
    /** Semantic invocation before installed runtime prefixes and target-local launch environment. */
    reviewInvocation: Readonly<{ args: readonly string[]; environmentOverlay?: Readonly<Record<string, string>> }>;
    packageManager?: NativePackageManagerSelection;
    nativeCommandEnvironment?: ProjectEnvironmentSelectionV1;
    environmentOverlay?: Readonly<Record<string, string>>;
}> | Readonly<{ kind: 'pluginResolved'; command: Extract<PluginProjectNativeCommandResultV1, { kind: 'resolved' }> }>;

const refuse = (reason: ProjectNativeRefusal['reason'], code: string): ProjectNativeRefusal => ({ kind: 'refused', reason, code });
async function selectedFile(root: string, file: string): Promise<ProjectNativeFileFact | ProjectNativeRefusal> {
    const read = await readProjectDefinitionFile(root, file);
    if (read.kind === 'absent') return refuse('missing', 'native_configuration_missing');
    if (read.kind === 'refused') return refuse(read.code === 'outside_root' ? 'outside_root' : 'invalid', read.code);
    return { file: relative(resolve(root), resolve(root, file.replaceAll('\\', '/'))).replaceAll('\\', '/'), content: read.content };
}

/** Single package-script intent producer, shared by Services and native command previews. */
export async function resolveNativePackageScript(params: Readonly<{ root: string; file: string; target: string; inheritAncestors?: boolean }>): Promise<ProjectNativeRefusal | Readonly<{
    kind: 'selected'; cwd: string; args: readonly string[]; packageManager: NativePackageManagerSelection; reviewInputs: readonly ProjectNativeFileFact[];
}>> {
    const fact = await selectedFile(params.root, params.file);
    if ('kind' in fact) return fact;
    if (basename(fact.file) !== 'package.json') return refuse('unsupported', 'native_configuration_filename_unsupported');
    const cwd = dirname(resolve(params.root, fact.file));
    try {
        const pkg = parseNativePackage(fact.content, cwd);
        if (!Object.hasOwn(pkg.scripts, params.target)) return refuse('missing', 'native_target_missing');
        if (!params.target || /^-|[\0\r\n]/u.test(params.target)) return refuse('invalid', 'native_target_invalid');
        const packageManager = await resolveNativePackageManager(cwd, params.inheritAncestors ? undefined : resolve(params.root));
        if (packageManager.root === cwd && (pkg.packageManager !== undefined || packageManager.version !== undefined)
            && pkg.packageManager !== `${packageManager.manager}@${packageManager.version}`) return refuse('invalid', 'native_configuration_changed');
        const reviewInputs: ProjectNativeFileFact[] = [fact];
        if (packageManager.version && packageManager.root !== cwd && !params.inheritAncestors) {
            const managerFile = relative(resolve(params.root), resolve(packageManager.root, 'package.json')).replaceAll('\\', '/');
            const declaration = await selectedFile(params.root, managerFile);
            if ('kind' in declaration) return declaration;
            if (parseNativePackage(declaration.content, packageManager.root).packageManager !== `${packageManager.manager}@${packageManager.version}`) return refuse('invalid', 'native_configuration_changed');
            reviewInputs.push(declaration);
        }
        return { kind: 'selected', cwd, args: ['run', params.target], packageManager, reviewInputs };
    } catch { return refuse('invalid', 'invalid_definition'); }
}

/** Resolve the actual contained config; does not produce or evaluate its environment. */
export async function resolveProjectEnvironmentSelection(params: Readonly<{ root: string; selection: ProjectEnvironmentSelectionV1 }>): Promise<ProjectNativeRefusal | Readonly<{
    kind: 'selected'; selection: ProjectEnvironmentSelectionV1; file?: string; content?: string; coverage: 'complete' | 'partial'; diagnostics: readonly Readonly<{ file: string; code: string }>[];
}>> {
    const selection = params.selection;
    if (selection.kind === 'host') return { kind: 'selected', selection, coverage: 'complete', diagnostics: [] };
    if (!selection.configPath) return refuse('missing', 'native_configuration_missing');
    const fact = await selectedFile(params.root, selection.configPath);
    if ('kind' in fact) return fact;
    const normalized = { ...selection, configPath: fact.file };
    if (selection.kind === 'pluginToolchain') return { kind: 'selected', selection: normalized, ...fact, coverage: 'complete', diagnostics: [] };
    const detection = await inspectProjectDefinitionFacts(params.root, [{ ...fact, format: selection.tool }]);
    if (!detection.environments.some(candidate => candidate.kind === 'toolchain' && candidate.tool === selection.tool)) return refuse('invalid', 'invalid_definition');
    return { kind: 'selected', selection: normalized, ...fact, coverage: detection.coverage, diagnostics: detection.diagnostics };
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
    packageManager?: NativePackageManagerSelection;
    nativeCommandEnvironment?: ProjectEnvironmentSelectionV1;
    environmentOverlay?: Readonly<Record<string, string>>;
}>;

/** The same static argv intent supplies preview and launch; availability is a separate installed fact. */
async function selectNativeCommand(input: Readonly<{
    root: string; source: Extract<ProjectNativeRefV1, { kind: 'native' }>; usage: 'script' | 'service' | 'setup';
}>): Promise<NativeCommandIntent | ProjectNativeRefusal> {
    const source = input.source;
    const fact = await selectedFile(input.root, source.file);
    if ('kind' in fact) return fact;
    if (!source.target || /^-|[\0\r\n]/u.test(source.target)) return refuse('invalid', 'native_target_invalid');
    if ((source.tool === 'compose' || source.tool === 'procfile') && input.usage !== 'service') return refuse('unsupported', 'native_service_only');
    let cwd = dirname(resolve(input.root, source.file.replaceAll('\\', '/')));
    let args: readonly string[];
    let tool: string = source.tool;
    let packageManager: NativePackageManagerSelection | undefined;
    let nativeCommandEnvironment: ProjectEnvironmentSelectionV1 | undefined;
    let environmentOverlay: Readonly<Record<string, string>> | undefined;
    let reviewInputs: readonly ProjectNativeFileFact[] = [fact];
    if (source.tool === 'package_script') {
        const selected = await resolveNativePackageScript({ root: input.root, file: source.file, target: source.target });
        if (selected.kind === 'refused') return selected;
        ({ cwd, args, packageManager, reviewInputs } = selected);
        tool = packageManager.manager;
    } else {
        const detection = await inspectProjectDefinitionFacts(input.root, [{ ...fact, format: source.tool }]);
        const entry = detection.entries.find(candidate => candidate.source.target === source.target && (source.tool !== 'flox' || (candidate.usage === 'service') === (input.usage === 'service')));
        if (!entry) return refuse(detection.coverage === 'partial' ? 'dynamic_unsupported' : 'missing', detection.diagnostics[0]?.code ?? 'native_target_missing');
        const literalDevenv = source.tool === 'devenv' && detection.diagnostics.every(diagnostic => diagnostic.code === 'unevaluated_nix');
        if (detection.coverage === 'partial' && !literalDevenv) return refuse('dynamic_unsupported', detection.diagnostics[0]?.code ?? 'dynamic_definition');
        const absoluteFile = resolve(input.root, source.file.replaceAll('\\', '/'));
        // Primary invocation contracts: GNU make -f; just --justfile; Task --taskfile;
        // mise run + explicit MISE_OVERRIDE_CONFIG_FILENAMES; Docker compose --file up;
        // Devbox run --config (directory); Flox build/services start --dir (environment root).
        switch (source.tool) {
            case 'make': args = ['-f', absoluteFile, source.target]; break;
            case 'just': args = ['--justfile', absoluteFile, source.target]; break;
            case 'taskfile': tool = 'task'; args = ['--taskfile', absoluteFile, source.target]; break;
            case 'mise':
                cwd = resolve(input.root);
                args = ['run', source.target];
                nativeCommandEnvironment = { kind: 'toolchain', tool: 'mise', configPath: fact.file };
                environmentOverlay = { MISE_OVERRIDE_CONFIG_FILENAMES: absoluteFile };
                break;
            case 'turbo':
                if (basename(absoluteFile) !== 'turbo.json') return refuse('unsupported', 'native_configuration_filename_unsupported');
                args = ['run', source.target]; break;
            case 'compose': tool = 'docker'; args = ['compose', '--file', absoluteFile, 'up', source.target]; break;
            case 'devbox':
                if (basename(absoluteFile) !== 'devbox.json') return refuse('unsupported', 'native_configuration_filename_unsupported');
                args = ['run', '--config', cwd, source.target];
                nativeCommandEnvironment = { kind: 'toolchain', tool: 'devbox', configPath: fact.file }; break;
            case 'flox':
                if (!source.file.replaceAll('\\', '/').endsWith('.flox/env/manifest.toml')) return refuse('unsupported', 'native_configuration_filename_unsupported');
                cwd = dirname(dirname(dirname(absoluteFile)));
                args = input.usage === 'service' ? ['services', 'start', '--dir', cwd, source.target] : ['build', '--dir', cwd, source.target];
                nativeCommandEnvironment = { kind: 'toolchain', tool: 'flox', configPath: fact.file }; break;
            case 'procfile': return refuse('unsupported', 'procfile_runner_not_selected');
            case 'devenv':
                if (basename(absoluteFile) !== 'devenv.nix') return refuse('unsupported', 'native_configuration_filename_unsupported');
                // scripts.<name>.exec produces an executable inside the native shell.
                // This is an argv preview only: Nix evaluation remains an admitted effect.
                args = ['shell', '--', source.target];
                nativeCommandEnvironment = { kind: 'toolchain', tool: 'devenv', configPath: fact.file }; break;
        }
    }
    return { kind: 'selected', tool, args, cwd, reviewInputs, ...(packageManager ? { packageManager } : {}),
        ...(nativeCommandEnvironment ? { nativeCommandEnvironment } : {}), ...(environmentOverlay ? { environmentOverlay } : {}) };
}

async function resolveSelectedNativeCommand(intent: NativeCommandIntent, io: ProjectNativeCommandIo, signal?: AbortSignal): Promise<ProjectNativeRefusal | Extract<ProjectNativeCommandResult, { kind: 'resolved' }>> {
    const { tool, cwd, packageManager, reviewInputs, nativeCommandEnvironment } = intent;
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
        args = [...(executable.args ?? []), ...args];
        if (executable.environmentOverlay) environmentOverlay = { ...executable.environmentOverlay, ...environmentOverlay };
        return { kind: 'resolved', command: executable.executablePath, args, cwd, reviewInputs, toolchain: { tool, ...(executable.version ? { version: executable.version } : {}) },
            reviewInvocation: { args: intent.args, ...(intent.environmentOverlay ? { environmentOverlay: intent.environmentOverlay } : {}) },
            ...(packageManager ? { packageManager } : {}), ...(nativeCommandEnvironment ? { nativeCommandEnvironment } : {}), ...(environmentOverlay ? { environmentOverlay } : {}) };
    } catch { return signal?.aborted ? cancelled() : refuse('unavailable', 'native_tool_unavailable'); }
}

/** Passive built-in intent and installed-tool facts; no plugin production callback. */
export async function inspectProjectNativeCommand(input: Readonly<{
    root: string; source: Extract<ProjectNativeRefV1, { kind: 'native' }>; usage: 'script' | 'service' | 'setup'; io: ProjectNativeCommandIo; signal?: AbortSignal;
}>): Promise<ProjectNativeRefusal | Extract<ProjectNativeCommandResult, { kind: 'resolved' }>> {
    if (input.signal?.aborted) return refuse('cancelled', 'native_resolution_cancelled');
    const intent = await selectNativeCommand(input);
    return intent.kind === 'refused' ? intent : resolveSelectedNativeCommand(intent, input.io, input.signal);
}

/** Plugin resolution may execute native effects and belongs to admitted execution. */
export async function resolveProjectNativeCommand(input: Readonly<{
    root: string; source: ProjectNativeRefV1; usage: 'script' | 'service' | 'setup'; io: ProjectNativeCommandIo; signal?: AbortSignal;
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
    const inputs: ProjectExecutionInputV1[] = [];
    const localExecutable = executablePath ? getPathRemainderWithinBase(executablePath, resolve(root)) : null;
    for (const file of [...new Set([...files, ...(localExecutable ? [localExecutable] : [])])].sort()) {
        const read = await readProjectDefinitionFileBytes(root, file);
        if (read.kind !== 'read') return undefined;
        inputs.push({ file: file.replaceAll('\\', '/'), hash: createHash('sha256').update(read.bytes).digest('hex') });
    }
    return inputs;
}

/** Passive import projection. It never probes versions or invokes plugin effect callbacks. */
export async function inspectProjectImportCandidates(input: Readonly<{
    root: string; detection: ProjectDefinitionDetectionV1; io?: ProjectNativeCommandIo; signal?: AbortSignal;
}>): Promise<readonly ProjectImportCandidate[]> {
    const intents = new Map<string, ProjectDefinitionDetectionV1['entries'][number]>();
    const labelCounts = new Map<string, number>();
    const label = (entry: ProjectDefinitionDetectionV1['entries'][number]) => JSON.stringify([entry.usage, entry.source.target]);
    for (const entry of input.detection.entries) {
        const source = entry.source;
        const key = JSON.stringify([source.kind, source.kind === 'native' ? source.tool : [source.adapter.pluginId, source.adapter.localId],
            relative(resolve(input.root), resolve(input.root, source.file.replaceAll('\\', '/'))).replaceAll('\\', '/'), source.target, entry.usage]);
        if (intents.has(key)) continue;
        intents.set(key, entry);
        labelCounts.set(label(entry), (labelCounts.get(label(entry)) ?? 0) + 1);
    }
    const candidates: ProjectImportCandidate[] = [];
    for (const entry of intents.values()) {
        if (input.signal?.aborted) { candidates.push({ ...entry, availability: 'unresolved', code: 'native_resolution_cancelled', preselected: false }); continue; }
        if (entry.source.kind === 'pluginNative') {
            const executionInputs = await readProjectExecutionInputs(input.root, [entry.source.file]);
            candidates.push({ ...entry, ...(executionInputs ? { executionInputs } : {}), availability: 'unresolved', code: 'native_adapter_availability_unresolved', preselected: false }); continue;
        }
        const intent = await selectNativeCommand({ root: input.root, source: entry.source, usage: entry.usage });
        let executionInputs = intent.kind === 'selected' ? await readProjectExecutionInputs(input.root, intent.reviewInputs.map(fact => fact.file)) : undefined;
        const preview = intent.kind === 'selected' ? { invocation: { tool: intent.tool, args: intent.args, cwd: intent.cwd,
            ...(intent.packageManager?.version ? { requestedVersion: intent.packageManager.version } : {}) } } : {};
        const selectedFacts = () => ({ ...preview, ...(executionInputs ? { executionInputs } : {}) });
        if (!input.io) { candidates.push({ ...entry, ...selectedFacts(), availability: 'unresolved', code: 'native_tool_resolution_unavailable', preselected: false }); continue; }
        const result = intent.kind === 'refused' ? intent : await resolveSelectedNativeCommand(intent, input.io, input.signal);
        if (result.kind === 'resolved' && executionInputs) {
            executionInputs = await readProjectExecutionInputs(input.root, executionInputs.map(fact => fact.file), result.command);
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
