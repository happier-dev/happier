import type { ProjectDefinitionInspectRead, ProjectDefinitionInspectOutput, ProjectManifestInspectionSnapshot } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import type { ProjectDefinitionDetectionV1, ProjectManifestV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { resolveProjectDefinitionV1, type ProjectEffectiveDefinitionV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectDefinitionCompositionV1';

/** All query projections select from the same fresh discovery; they never decide readiness or execution. */
export function selectProjectDefinitionRead(definition: ProjectManifestInspectionSnapshot, detection: ProjectDefinitionDetectionV1,
    read: ProjectDefinitionInspectRead = { kind: 'scripts' },
    effectiveDefinition = resolveProjectDefinitionV1({ repositoryManifest: definition.document?.status === 'valid' ? definition.document.manifest : null })) {
    const manifest = effectiveDefinition.effectiveManifest ?? undefined;
    const compact = read.kind === 'overview' || read.kind === 'rail';
    const declaredSources = new Set(read.kind === 'scripts' && manifest ? [
        ...Object.values(manifest.scripts ?? {}).map(declaration => declaration.source),
        ...Object.values(manifest.services ?? {}).map(declaration => declaration.source),
        ...(manifest.workspace?.setup ?? []),
    ].map(createCanonicalJsonSigningInput) : []);
    const offers = read.kind === 'scripts' ? detection.entries.filter(entry => !declaredSources.has(createCanonicalJsonSigningInput(entry.source)))
        : detection.entries;
    const files = new Map<string, NonNullable<ProjectDefinitionInspectOutput['detectionSummary']>['files'][number]>();
    const groups = new Map<string, ProjectDefinitionDetectionV1['entries']>();
    let scripts = 0; let services = 0;
    for (const entry of read.kind === 'scripts' || read.kind === 'guidance' || compact && !manifest ? offers : []) {
        if (entry.usage === 'setup') continue;
        let file = files.get(entry.source.file);
        if (!file) { file = { file: entry.source.file, total: 0, scripts: 0, services: 0 }; files.set(entry.source.file, file); }
        file.total++;
        if (entry.usage === 'script') { file.scripts++; scripts++; } else { file.services++; services++; }
        const rows = groups.get(entry.source.file) ?? [];
        rows.push(entry); groups.set(entry.source.file, rows);
    }
    const entries = compact ? manifest ? [] : [...groups.values()].flat().slice(0, read.detectedRows)
        : read.kind === 'scripts' ? offers.filter(entry => entry.usage === 'script')
            : read.kind === 'imports' || read.kind === 'create' || read.kind === 'tools' ? detection.entries
                : read.kind === 'detail' ? [...read.sources]
            : read.kind === 'services' ? detection.entries.filter(entry => entry.usage === 'service') : [];
    const displayedFiles = new Set(entries.map(entry => entry.source.file));
    const detectionSummary = { total: scripts + services, scripts, services,
        sourceFiles: [...new Set([...files.keys()].map(file => file.split(/[\\/]/).pop() ?? file))],
        files: [...files.values()].filter(file => read.kind === 'scripts' || read.kind === 'guidance' || displayedFiles.has(file.file)),
    };
    const fullDetection = read.kind === 'create' || read.kind === 'tools';
    const projectedDetection: ProjectDefinitionDetectionV1 = { entries: read.kind === 'tools' ? [] : entries,
        toolchains: fullDetection ? detection.toolchains : [], devcontainers: fullDetection ? detection.devcontainers : [],
        coverage: detection.coverage, diagnostics: detection.diagnostics,
        ...(read.kind === 'applications' && detection.applications ? { applications: detection.applications } : {}),
        ...(read.kind === 'applications' && detection.rootFiles ? { rootFiles: detection.rootFiles } : {}),
        ...(read.kind === 'applications' && detection.applications && detection.rootFiles && detection.observedAtMs !== undefined
            ? { observedAtMs: detection.observedAtMs } : {}),
        ...(fullDetection && detection.tools ? { tools: detection.tools } : {}) };
    const document = definition.document;
    const statusOnly = read.kind === 'detail' || read.kind === 'tools' || read.kind === 'imports' || read.kind === 'applications';
    let projectedDefinition = definition;
    if (read.kind !== 'editor' && read.kind !== 'create' && document) {
        if (document.status === 'valid') {
            // Compact Scripts consumers render script/setup facts, never unrelated Services.
            const { services: _services, ...scriptManifest } = document.manifest;
            projectedDefinition = { basis: definition.basis, document: { status: document.status,
                manifest: statusOnly ? { version: document.manifest.version }
                    : read.kind === 'guidance' ? { version: document.manifest.version,
                        ...(document.manifest.scripts ? { scripts: document.manifest.scripts } : {}),
                        ...(document.manifest.services ? { services: document.manifest.services } : {}) }
                        : compact ? scriptManifest : document.manifest,
                diagnostics: statusOnly ? [] : document.diagnostics } };
        } else projectedDefinition = { basis: definition.basis,
            document: { status: document.status, diagnostics: document.diagnostics } };
    }
    let commandManifest: ProjectManifestV1 | undefined = manifest;
    if (manifest && read.kind !== 'create' && read.kind !== 'tools') {
        const usage = read.kind === 'execution' ? read.command?.usage : compact || read.kind === 'scripts' ? 'script' : read.kind === 'services' ? 'service' : undefined;
        const name = read.kind === 'execution' ? read.command?.name : undefined;
        const select = <T>(values: Record<string, T> | undefined, family: string) => usage === family
            ? Object.fromEntries(Object.entries(values ?? {}).filter(([key]) => name === undefined || key === name)) : {};
        commandManifest = { ...manifest, scripts: select(manifest.scripts, 'script'), services: select(manifest.services, 'service'),
            workspace: { ...manifest.workspace,
                setup: usage === 'setup' ? manifest.workspace?.setup : [], teardown: usage === 'setup' ? manifest.workspace?.teardown : [] } };
    }
    if (read.kind === 'editor' || read.kind === 'imports' || read.kind === 'detail' || read.kind === 'guidance') commandManifest = undefined;
    // The Scripts list shows each found reference's name and file; an opened row resolves
    // its own native candidate through `detail`, so the list resolves none.
    const candidateEntries = read.kind === 'scripts' ? [] : entries;
    const projectedEffective: ProjectEffectiveDefinitionV1 = { ...effectiveDefinition,
        effectiveManifest: manifest ? statusOnly ? { version: 1 }
            : compact ? { ...manifest, services: undefined } : manifest : null,
        origins: compact ? effectiveDefinition.origins.filter(origin => origin.path[0] !== 'services')
            : read.kind === 'editor' || read.kind === 'setup' || read.kind === 'scripts' ? effectiveDefinition.origins : [] };
    return { read, definition: projectedDefinition, effectiveDefinition: projectedEffective, ...(statusOnly ? { definitionScope: 'statusOnly' as const } : {}),
        detection: projectedDetection, detectionSummary, entries, candidateEntries, commandManifest,
        includeTools: read.kind === 'create' || read.kind === 'tools',
        includeInvocation: read.kind === 'create' || read.kind === 'detail' || read.kind === 'execution' || read.kind === 'overview' || read.kind === 'services',
        includeExecutionInputs: read.kind === 'execution',
        includeSetup: read.kind === 'scripts' || read.kind === 'overview' || read.kind === 'rail' || read.kind === 'services' || read.kind === 'setup',
    };
}
