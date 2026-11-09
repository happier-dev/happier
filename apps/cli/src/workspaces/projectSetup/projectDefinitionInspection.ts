import type { ProjectDefinitionDetectionV1, ProjectManifestV1, ProjectToolInspectionV1, ProjectToolRequirementV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { createProjectNativeInspection, readProjectExecutionInputs, resolveProjectToolchainSelection } from './projectNativeResolution';
import type { ProjectImportCandidate, ProjectNativeCommandIo } from './projectNativeResolution';

import { inspectProjectDefinitionFiles } from './nativeDefinitionInspection';
export { inspectProjectDefinitions, inspectProjectDefinitionFiles, inspectProjectDefinitionFacts } from './nativeDefinitionInspection';

export { readProjectDefinitionFile } from './nativeDefinitionFiles';
export { inspectProjectImportCandidates, resolveProjectNativeCommand, resolveProjectToolchainSelection, resolveProjectDevcontainerSelection } from './projectNativeResolution';

/** Host-installed facts only, not selected-toolchain satisfaction or a prerequisite health check. */
export async function inspectProjectToolFacts(input: Readonly<{
    root: string; detection: ProjectDefinitionDetectionV1; candidates: readonly ProjectImportCandidate[];
    io: ProjectNativeCommandIo; signal?: AbortSignal;
}>): Promise<ProjectToolInspectionV1[]> {
    const requirements: ProjectToolRequirementV1[] = [...(input.detection.tools ?? [])];
    for (const selection of input.detection.toolchains) if (selection.kind === 'toolchain' && selection.configPath) {
        requirements.push({ tool: selection.tool === 'nix_flake' ? 'nix' : selection.tool, file: selection.configPath });
    }
    for (const candidate of input.candidates) if (candidate.invocation) requirements.push({ tool: candidate.invocation.tool,
        file: candidate.source.file, ...(candidate.invocation.requestedVersion ? { requestedVersion: candidate.invocation.requestedVersion } : {}) });
    const facts: ProjectToolInspectionV1[] = [];
    const seen = new Set<string>();
    // Every requirement asks the same unversioned installed-tool question at
    // this root. Resolve the distinct tools once, retaining all file/version
    // requirements. Observations belong only to this inspection, never the next.
    const observations = new Map<string, Pick<ProjectToolInspectionV1, 'availability' | 'version'>>();
    for (const requirement of requirements) {
        const key = JSON.stringify(requirement);
        if (seen.has(key)) continue;
        seen.add(key);
        input.signal?.throwIfAborted();
        let observation = observations.get(requirement.tool);
        if (!observation) {
            try {
                const installed = await input.io.resolveTool(requirement.tool, { cwd: input.root, ...(input.signal ? { signal: input.signal } : {}) });
                input.signal?.throwIfAborted();
                observation = { availability: installed ? 'available' : 'unavailable', ...(installed?.version ? { version: installed.version } : {}) };
            } catch {
                input.signal?.throwIfAborted();
                observation = { availability: 'unresolved' };
            }
            observations.set(requirement.tool, observation);
        }
        facts.push({ ...requirement, ...observation });
    }
    return facts;
}

/** One passive projection for named commands, import offers and installed tools; transport does not reconstruct native semantics. */
export async function inspectProjectDefinitionExecutionFacts(input: Readonly<{
    root: string; manifest?: ProjectManifestV1; detection: ProjectDefinitionDetectionV1; io: ProjectNativeCommandIo; signal?: AbortSignal;
    entries?: readonly ProjectDefinitionDetectionV1['entries'][number][]; includeTools?: boolean; includeExecutionInputs?: boolean;
    includeInvocation?: boolean;
    command?: Readonly<{ usage: 'script' | 'service' | 'setup'; name: string }>;
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
        const selection = manifest.toolchain;
        if (input.includeTools !== false && selection?.kind === 'toolchain' && selection.configPath && !detection.toolchains.some(candidate => candidate.kind === 'toolchain' && candidate.tool === selection.tool && candidate.configPath === selection.configPath)) {
            const selected = await inspectProjectDefinitionFiles(root, [{ file: selection.configPath, format: selection.tool }]);
            detection.toolchains.push(...selected.toolchains);
            if (selected.tools) (detection.tools ??= []).push(...selected.tools);
            detection.diagnostics.push(...selected.diagnostics);
            if (selected.coverage === 'partial') detection.coverage = 'partial';
        }
    }
    const inspection = createProjectNativeInspection({ root, io, ...(signal ? { signal } : {}) });
    const importCandidates = await inspection.inspectImportCandidates(detection, { entries: input.entries, executionInputs: input.includeExecutionInputs });
    const commands: (Omit<ProjectImportCandidate, 'preselected'> & { name: string })[] = [];
    for (const entry of named) {
        if (input.command && (entry.name !== input.command.name || entry.usage !== input.command.usage)) continue;
        const [candidate] = await inspection.inspectImportCandidates({ ...detection, entries: [entry] }, { executionInputs: input.includeExecutionInputs });
        if (candidate) { const { preselected: _preselected, ...preview } = candidate; commands.push({ ...preview, name: entry.name }); }
    }
    const tools = input.includeTools === false ? [] : await inspectProjectToolFacts({ root, detection, candidates: [...importCandidates, ...commands.map(command => ({ ...command, preselected: false }))], io: inspection.io!, ...(signal ? { signal } : {}) });
    const toolchain = input.includeExecutionInputs === false ? undefined : await resolveProjectToolchainSelection({ root, selection: manifest?.toolchain ?? { kind: 'host' } });
    let toolchainExecutionInputs: Awaited<ReturnType<typeof readProjectExecutionInputs>>;
    if (toolchain?.kind === 'selected') {
        try {
            const installed = toolchain.selection.kind === 'toolchain'
                ? await inspection.io!.resolveTool(toolchain.selection.tool === 'nix_flake' ? 'nix' : toolchain.selection.tool,
                    { cwd: root, ...(signal ? { signal } : {}) }) : null;
            signal?.throwIfAborted();
            toolchainExecutionInputs = await inspection.readExecutionInputs(toolchain.file ? [toolchain.file] : [], installed?.executablePath);
        } catch { signal?.throwIfAborted(); }
    }
    signal?.throwIfAborted();
    const projectCandidate = <T extends ProjectImportCandidate | Omit<ProjectImportCandidate, 'preselected'>>(candidate: T) => {
        if (input.includeInvocation !== false) return candidate;
        const { invocation: _invocation, ...summary } = candidate;
        return summary;
    };
    return { importCandidates: importCandidates.map(projectCandidate), commands: commands.map(projectCandidate), tools,
        ...(toolchainExecutionInputs ? { toolchainExecutionInputs } : {}) };
}
