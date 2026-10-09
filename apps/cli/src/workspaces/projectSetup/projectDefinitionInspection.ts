import { readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { ProjectDefinitionDetectionV1, ProjectEnvironmentSelectionV1, ProjectManifestV1, ProjectNativeRefV1, ProjectToolInspectionV1, ProjectToolRequirementV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { inspectProjectImportCandidates, readProjectExecutionInputs, resolveProjectEnvironmentSelection } from './projectNativeResolution';
import type { ProjectImportCandidate, ProjectNativeCommandIo } from './projectNativeResolution';
import { collectNativePackageDirectories, isNativeDefinitionRecord, parseNativePackage } from './nativePackageScripts';
import { readProjectDefinitionFile, type ProjectDefinitionFileRead } from './nativeDefinitionFiles';

export { readProjectDefinitionFile } from './nativeDefinitionFiles';
export { inspectProjectImportCandidates, resolveProjectNativeCommand, resolveProjectEnvironmentSelection, resolveProjectDevcontainerSelection } from './projectNativeResolution';

const NATIVE_FILES = [
    'package.json', 'mise.toml', '.mise.toml', '.config/mise/config.toml',
    'Makefile', 'makefile', 'GNUmakefile', 'justfile', 'Justfile', '.justfile',
    'Taskfile.yml', 'Taskfile.yaml', 'Taskfile.dist.yml', 'Taskfile.dist.yaml',
    'turbo.json', 'compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml',
    'Procfile', 'devbox.json', 'devenv.nix', '.flox/env/manifest.toml', 'flake.nix',
    '.devcontainer/devcontainer.json', '.devcontainer.json',
] as const;
type NativeTool = Extract<ProjectNativeRefV1, { kind: 'native' }>['tool'];
function literalName(name: string): boolean { return name.length > 0 && !/[\n\r\0]/.test(name); }

export async function inspectProjectDefinitions(root: string): Promise<ProjectDefinitionDetectionV1> {
    const files = new Set<string>(NATIVE_FILES);
    for (const cwd of await collectNativePackageDirectories(root)) files.add(relative(root, join(cwd, 'package.json')).replaceAll('\\', '/'));
    for (const entry of await readdir(join(root, '.devcontainer'), { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) files.add(`.devcontainer/${entry.name}/devcontainer.json`);
    }
    return inspectProjectDefinitionFiles(root, [...files].map(file => ({ file })));
}

/** Selected references and discovery use the same parsers, including custom filenames. */
export async function inspectProjectDefinitionFiles(root: string, files: readonly Readonly<{ file: string; format?: NativeTool | 'nix_flake' | 'devcontainer' }>[]): Promise<ProjectDefinitionDetectionV1> {
    const definitions = await Promise.all(files.map(async definition => ({ ...definition, read: await readProjectDefinitionFile(root, definition.file) })));
    return inspectDefinitionReads(root, definitions);
}

/** Facts must come from the contained native-file boundary, never plugin-supplied paths or bytes. */
export async function inspectProjectDefinitionFacts(root: string, files: readonly Readonly<{ file: string; content: string; format: NativeTool | 'nix_flake' | 'devcontainer' }>[]): Promise<ProjectDefinitionDetectionV1> {
    return inspectDefinitionReads(root, files.map(definition => ({ ...definition, read: { kind: 'read', content: definition.content } })));
}

async function inspectDefinitionReads(root: string, files: readonly Readonly<{ file: string; format?: NativeTool | 'nix_flake' | 'devcontainer'; read: ProjectDefinitionFileRead }>[]): Promise<ProjectDefinitionDetectionV1> {
    const detection: ProjectDefinitionDetectionV1 = { entries: [], environments: [], devcontainers: [], coverage: 'complete', diagnostics: [] };
    const formatNames = { package_script: 'package.json', mise: 'mise.toml', make: 'Makefile', just: 'justfile', taskfile: 'Taskfile.yml', turbo: 'turbo.json', compose: 'compose.yml', procfile: 'Procfile', devbox: 'devbox.json', devenv: 'devenv.nix', flox: '.flox/env/manifest.toml', nix_flake: 'flake.nix', devcontainer: 'devcontainer.json' } as const;
    const diagnostic = (file: string, code: string) => {
        detection.coverage = 'partial';
        if (!detection.diagnostics.some((existing) => existing.file === file && existing.code === code)) detection.diagnostics.push({ file, code });
    };
    const add = (file: string, tool: NativeTool, target: string, usage: 'script' | 'service' = 'script') => {
        if (literalName(target)) detection.entries.push({ source: { kind: 'native', tool, file, target }, usage });
    };
    const environment = (file: string, tool: Extract<ProjectEnvironmentSelectionV1, { kind: 'toolchain' }>['tool']) => {
        detection.environments.push({ kind: 'toolchain', tool, configPath: file });
    };
    const named = (file: string, tool: NativeTool, value: unknown, usage: 'script' | 'service' = 'script') => {
        if (value === undefined) return;
        if (!isNativeDefinitionRecord(value)) { diagnostic(file, 'invalid_definition'); return; }
        for (const [target, definition] of Object.entries(value)) {
            if (definition !== null && (typeof definition === 'string' || Array.isArray(definition) || isNativeDefinitionRecord(definition))) add(file, tool, target, usage);
            else diagnostic(file, 'invalid_definition');
        }
    };
    // Native parsers read only declarations. They never invoke a tool, hook, shell or evaluator.
    for (const definition of files) {
        const file = definition.file;
        const format = definition.format ? formatNames[definition.format] : file;
        const read = definition.read;
        if (read.kind === 'absent') continue;
        if (read.kind === 'refused') { diagnostic(file, read.code); continue; }
        const content = read.content;
        try {
            if (format === 'package.json' || format.endsWith('/package.json')) {
                const pkg = parseNativePackage(content, join(root, dirname(file)));
                for (const target of Object.keys(pkg.scripts)) add(file, 'package_script', target);
            } else if (format.endsWith('mise.toml') || format === '.config/mise/config.toml') {
                const value: unknown = (await import('smol-toml')).parse(content);
                if (!isNativeDefinitionRecord(value)) throw new Error('invalid_definition');
                named(file, 'mise', value.tasks);
                environment(file, 'mise');
                if (isNativeDefinitionRecord(value.tools)) for (const [tool, selection] of Object.entries(value.tools)) {
                    const versions = Array.isArray(selection) ? selection : [selection];
                    for (const version of versions) {
                        const declared = typeof version === 'string' ? version : isNativeDefinitionRecord(version) && typeof version.version === 'string' ? version.version : undefined;
                        (detection.tools ??= []).push({ tool, file, ...(declared ? { requestedVersion: declared } : {}) });
                    }
                }
                if (isNativeDefinitionRecord(value.task_config) && value.task_config.includes !== undefined) diagnostic(file, 'unresolved_include');
            } else if (['Makefile', 'makefile', 'GNUmakefile'].includes(format)) {
                for (const line of content.split(/\r?\n/)) {
                    if (/^\s*(?:-?include|sinclude)\s/.test(line)) diagnostic(file, 'unresolved_include');
                    if (/^[\t#]/.test(line) || line.includes(':=') || line.includes('::=') || line.includes('?=') || line.includes('+=')) continue;
                    const match = line.match(/^([^\s:#][^:#]*):(?!=)/);
                    if (!match) continue;
                    for (const target of match[1].trim().split(/\s+/)) {
                        if (/[\$%*?=]/.test(target)) diagnostic(file, 'dynamic_definition');
                        else if (!target.startsWith('.')) add(file, 'make', target);
                    }
                }
            } else if (['justfile', 'Justfile', '.justfile'].includes(format)) {
                for (const line of content.split(/\r?\n/)) {
                    if (/^\s*(?:import|mod)\??\s/.test(line)) diagnostic(file, 'unresolved_include');
                    const match = line.match(/^@?([A-Za-z_][A-Za-z0-9_-]*)(?:\s+[^:=]+)?:([^=]|$)/);
                    if (match) add(file, 'just', match[1]);
                }
            } else if (/^Taskfile\.(?:dist\.)?ya?ml$/.test(format) || /^(?:docker-)?compose\.ya?ml$/.test(format)) {
                const value: unknown = (await import('yaml')).parse(content);
                if (!isNativeDefinitionRecord(value)) throw new Error('invalid_definition');
                if (format.startsWith('Taskfile')) {
                    named(file, 'taskfile', value.tasks);
                    if (value.includes !== undefined) diagnostic(file, 'unresolved_include');
                } else {
                    named(file, 'compose', value.services, 'service');
                    if (value.include !== undefined || (isNativeDefinitionRecord(value.services) && Object.values(value.services).some((service) => isNativeDefinitionRecord(service) && service.extends !== undefined))) diagnostic(file, 'unresolved_include');
                }
            } else if (format === 'Procfile') {
                for (const line of content.split(/\r?\n/)) {
                    if (!line.trim() || /^\s*#/.test(line)) continue;
                    const match = line.match(/^([A-Za-z0-9_-]+):\s*\S/);
                    if (match) add(file, 'procfile', match[1], 'service');
                    else diagnostic(file, 'invalid_definition');
                }
            } else if (format === 'turbo.json' || format === 'devbox.json' || format.endsWith('devcontainer.json') || format === '.devcontainer.json') {
                const value: unknown = format === 'devbox.json'
                    ? JSON.parse(content)
                    : (await import('json5')).default.parse(content);
                if (!isNativeDefinitionRecord(value)) throw new Error('invalid_definition');
                if (format === 'turbo.json') {
                    named(file, 'turbo', value.tasks ?? value.pipeline);
                    if (value.extends !== undefined) diagnostic(file, 'unresolved_include');
                } else if (format === 'devbox.json') {
                    environment(file, 'devbox');
                    if (isNativeDefinitionRecord(value.shell)) named(file, 'devbox', value.shell.scripts);
                    if (value.include !== undefined) diagnostic(file, 'unresolved_include');
                } else detection.devcontainers.push({ configPath: file });
            } else if (format === '.flox/env/manifest.toml') {
                const value: unknown = (await import('smol-toml')).parse(content);
                if (!isNativeDefinitionRecord(value)) throw new Error('invalid_definition');
                environment(file, 'flox');
                named(file, 'flox', value.services, 'service');
                named(file, 'flox', value.build);
                if (value.include !== undefined) diagnostic(file, 'unresolved_include');
            } else if (format === 'devenv.nix' || format === 'flake.nix') {
                environment(file, format === 'flake.nix' ? 'nix_flake' : 'devenv');
                if (format === 'devenv.nix') for (const target of staticDevenvScriptNames(content)) add(file, 'devenv', target);
                diagnostic(file, 'unevaluated_nix');
            }
        } catch { diagnostic(file, 'invalid_definition'); }
    }
    return detection;
}

/** Host-installed facts only, not selected-toolchain satisfaction or a prerequisite health check. */
export async function inspectProjectToolFacts(input: Readonly<{
    root: string; detection: ProjectDefinitionDetectionV1; candidates: readonly ProjectImportCandidate[];
    io: ProjectNativeCommandIo; signal?: AbortSignal;
}>): Promise<ProjectToolInspectionV1[]> {
    const requirements: ProjectToolRequirementV1[] = [...(input.detection.tools ?? [])];
    for (const selection of input.detection.environments) if (selection.kind === 'toolchain' && selection.configPath) {
        requirements.push({ tool: selection.tool === 'nix_flake' ? 'nix' : selection.tool, file: selection.configPath });
    }
    for (const candidate of input.candidates) if (candidate.invocation) requirements.push({ tool: candidate.invocation.tool,
        file: candidate.source.file, ...(candidate.invocation.requestedVersion ? { requestedVersion: candidate.invocation.requestedVersion } : {}) });
    const facts: ProjectToolInspectionV1[] = [];
    const seen = new Set<string>();
    for (const requirement of requirements) {
        const key = JSON.stringify(requirement);
        if (seen.has(key)) continue;
        seen.add(key);
        input.signal?.throwIfAborted();
        try {
            const installed = await input.io.resolveTool(requirement.tool, { cwd: input.root, ...(input.signal ? { signal: input.signal } : {}) });
            input.signal?.throwIfAborted();
            facts.push({ ...requirement, availability: installed ? 'available' : 'unavailable', ...(installed?.version ? { version: installed.version } : {}) });
        } catch {
            input.signal?.throwIfAborted();
            facts.push({ ...requirement, availability: 'unresolved' });
        }
    }
    return facts;
}

/** One passive projection for named commands, import offers and installed tools; transport does not reconstruct native semantics. */
export async function inspectProjectDefinitionExecutionFacts(input: Readonly<{
    root: string; manifest?: ProjectManifestV1; detection: ProjectDefinitionDetectionV1; io: ProjectNativeCommandIo; signal?: AbortSignal;
}>) {
    const { root, manifest, detection, io, signal } = input;
    const named: (ProjectDefinitionDetectionV1['entries'][number] & { name: string })[] = [];
    if (manifest) {
        for (const usage of ['script', 'service'] as const) for (const [name, entry] of Object.entries(usage === 'script' ? manifest.scripts ?? {} : manifest.services ?? {})) {
            if (entry.source.kind !== 'command') named.push({ name, source: entry.source, usage });
        }
        for (const phase of ['setup', 'teardown'] as const) manifest.workspace?.[phase]?.forEach((source, index) => {
            if (source.kind !== 'command') named.push({ name: `${phase}.${index}`, source, usage: 'setup' });
        });
        const selection = manifest.environment;
        if (selection?.kind === 'toolchain' && selection.configPath && !detection.environments.some(candidate => candidate.kind === 'toolchain' && candidate.tool === selection.tool && candidate.configPath === selection.configPath)) {
            const selected = await inspectProjectDefinitionFiles(root, [{ file: selection.configPath, format: selection.tool }]);
            detection.environments.push(...selected.environments);
            if (selected.tools) (detection.tools ??= []).push(...selected.tools);
            detection.diagnostics.push(...selected.diagnostics);
            if (selected.coverage === 'partial') detection.coverage = 'partial';
        }
    }
    const importCandidates = await inspectProjectImportCandidates({ root, detection, io, ...(signal ? { signal } : {}) });
    const commands: (Omit<ProjectImportCandidate, 'preselected'> & { name: string })[] = [];
    for (const entry of named) {
        const [candidate] = await inspectProjectImportCandidates({ root, detection: { ...detection, entries: [entry] }, io, ...(signal ? { signal } : {}) });
        if (candidate) { const { preselected: _preselected, ...preview } = candidate; commands.push({ ...preview, name: entry.name }); }
    }
    const tools = await inspectProjectToolFacts({ root, detection, candidates: [...importCandidates, ...commands.map(command => ({ ...command, preselected: false }))], io, ...(signal ? { signal } : {}) });
    const environment = await resolveProjectEnvironmentSelection({ root, selection: manifest?.environment ?? { kind: 'host' } });
    let environmentExecutionInputs: Awaited<ReturnType<typeof readProjectExecutionInputs>>;
    if (environment.kind === 'selected') {
        try {
            const installed = environment.selection.kind === 'toolchain'
                ? await io.resolveTool(environment.selection.tool === 'nix_flake' ? 'nix' : environment.selection.tool,
                    { cwd: root, ...(signal ? { signal } : {}) }) : null;
            signal?.throwIfAborted();
            environmentExecutionInputs = await readProjectExecutionInputs(root, environment.file ? [environment.file] : [], installed?.executablePath);
        } catch { signal?.throwIfAborted(); }
    }
    signal?.throwIfAborted();
    return { importCandidates, commands, tools, ...(environmentExecutionInputs ? { environmentExecutionInputs } : {}) };
}

/** Lex only enough Nix for literal dotted script attributes; string/comment bodies are never declarations. */
function staticDevenvScriptNames(content: string): string[] {
    const tokens: string[] = [];
    for (let index = 0; index < content.length;) {
        if (/\s/.test(content[index])) { index += 1; continue; }
        if (content[index] === '#') { const end = content.indexOf('\n', index); index = end < 0 ? content.length : end; continue; }
        if (content.startsWith('/*', index)) { const end = content.indexOf('*/', index + 2); index = end < 0 ? content.length : end + 2; continue; }
        if (content.startsWith("''", index)) { const end = content.indexOf("''", index + 2); tokens.push('<body>'); index = end < 0 ? content.length : end + 2; continue; }
        if (content[index] === '"') {
            let end = index + 1;
            while (end < content.length && (content[end] !== '"' || content[end - 1] === '\\')) end += 1;
            const value = content.slice(index + 1, end);
            tokens.push(value.includes('${') ? '<dynamic>' : value);
            index = end + 1; continue;
        }
        const name = content.slice(index).match(/^[A-Za-z_][A-Za-z0-9_'\-]*/)?.[0];
        if (name) { tokens.push(name); index += name.length; }
        else { tokens.push(content[index]); index += 1; }
    }
    const names = new Set<string>();
    const scriptAt = (index: number): boolean => {
        if (!literalName(tokens[index] ?? '') || tokens[index].startsWith('<')) return false;
        if (tokens[index + 1] === '.' && tokens[index + 2] === 'exec' && tokens[index + 3] === '=') return true;
        if (tokens[index + 1] !== '=' || tokens[index + 2] !== '{') return false;
        let depth = 1;
        for (let cursor = index + 3; cursor < tokens.length && depth > 0; cursor += 1) {
            if (depth === 1 && tokens[cursor] === 'exec' && tokens[cursor + 1] === '=') return true;
            if (tokens[cursor] === '{') depth += 1;
            if (tokens[cursor] === '}') depth -= 1;
        }
        return false;
    };
    for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index] !== 'scripts' || (index > 0 && !['{', ';'].includes(tokens[index - 1]))) continue;
        if (tokens[index + 1] === '.' && scriptAt(index + 2)) names.add(tokens[index + 2]);
        if (tokens[index + 1] === '=' && tokens[index + 2] === '{') {
            let depth = 1;
            for (let cursor = index + 3; cursor < tokens.length && depth > 0; cursor += 1) {
                if (depth === 1 && ['{', ';'].includes(tokens[cursor - 1]) && scriptAt(cursor)) names.add(tokens[cursor]);
                if (tokens[cursor] === '{') depth += 1;
                if (tokens[cursor] === '}') depth -= 1;
            }
        }
    }
    return [...names];
}
