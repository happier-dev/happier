import { parse } from 'dotenv';
import { EnvVarRequirementSchema, type EnvVarRequirement } from '@happier-dev/protocol/profiles/environmentVariables';
import type { ProjectEnvironmentImportV1 } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';
import { currentWorkspaceSource, runWithWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { readProjectDefinitionFile, type ProjectDefinitionFileRead } from './nativeDefinitionFiles';

const runtimeFiles = ['.env', '.env.development', '.env.local', '.env.development.local'] as const;
export type ProjectDotenvDiagnostic = Readonly<{ file: string; name?: string; code: string }>;
export type ProjectDotenvResult = Readonly<{ kind: 'ready'; environment: Readonly<Record<string, string>>;
    originalEnvironment: ProcessEnvInput; sources: readonly Readonly<{ name: string; file: string }>[] }>
    | Readonly<{ kind: 'refused'; code: 'project_environment_binding_unavailable'; diagnostics: readonly ProjectDotenvDiagnostic[] }>;
export type ProjectDotenvEnvironmentResult = ProjectDotenvResult;

/** Standard dotenv decoding; the record scan supplies safe diagnostics that dotenv's permissive parser omits. */
export function parseProjectDotenv(content: string) {
    const records: string[] = [];
    const diagnostics: Array<Readonly<{ line: number; code: 'malformed_dotenv' }>> = [];
    const lines = content.replace(/\r\n?/g, '\n').split('\n');
    for (let index = 0; index < lines.length; index++) {
        const start = index;
        let record = lines[index]!;
        if (/^\s*(?:#.*)?$/.test(record) && !record.includes('\0')) continue;
        const assignment = /^\s*(?:export\s+)?([\w.-]+)(?:[ \t]*=[ \t]*|:[ \t]+)(.*)$/.exec(record);
        if (!assignment || record.includes('\0')) { diagnostics.push({ line: start + 1, code: 'malformed_dotenv' }); continue; }
        const value = assignment[2]!;
        const quote = value[0];
        if (quote === '"' || quote === "'" || quote === '`') {
            let closing = -1;
            let body = value.slice(1);
            let position = 0;
            while (true) {
                for (; position < body.length; position++) {
                    if (body[position] === '\\' && body[position + 1] === quote) {
                        // dotenv may backtrack the final escaped quote into the closing delimiter.
                        if (/^\s*(?:#.*)?$/.test(body.slice(position + 2))) { closing = position + 1; break; }
                        position++;
                    }
                    else if (body[position] === quote) { closing = position; break; }
                }
                if (closing !== -1 || index + 1 >= lines.length) break;
                body += `\n${lines[++index]}`;
                record += `\n${lines[index]}`;
            }
            if (closing === -1 || !/^\s*(?:#.*)?$/.test(body.slice(closing + 1)) || record.includes('\0')) {
                diagnostics.push({ line: start + 1, code: 'malformed_dotenv' }); continue;
            }
        }
        records.push(record);
    }
    return { values: parse(records.join('\n')), diagnostics };
}

/** One private, lazy snapshot per demanded preparation; no watcher or persistent cache. */
export function createProjectDotenvPreparation(root: string, upstreamEnvironment: ProcessEnvInput = {}) {
    const source = currentWorkspaceSource();
    const capturedUpstreamEnvironment = Object.freeze({ ...upstreamEnvironment });
    let snapshot: Promise<Readonly<{ values: Record<string, string>; files: Record<string, string>; diagnostics: ProjectDotenvDiagnostic[] }>> | undefined;
    const readSnapshot = async () => {
        const values: Record<string, string> = Object.create(null);
        const files: Record<string, string> = Object.create(null);
        const diagnostics: ProjectDotenvDiagnostic[] = [];
        for (const file of runtimeFiles) {
            const read = await runWithWorkspaceSource(source, () => readProjectDefinitionFile(root, file));
            if (read.kind === 'absent') continue;
            if (read.kind === 'refused') { diagnostics.push({ file, code: read.code }); continue; }
            const parsed = parseProjectDotenv(read.content);
            if (parsed.diagnostics.length) diagnostics.push({ file, code: 'malformed_dotenv' });
            for (const [name, value] of Object.entries(parsed.values)) { values[name] = value; files[name] = file; }
        }
        return { values, files, diagnostics };
    };
    return Object.freeze({ async read(declaredNames: readonly string[], originalEnvironment: ProcessEnvInput = capturedUpstreamEnvironment): Promise<ProjectDotenvResult> {
        const original = Object.freeze({ ...originalEnvironment });
        if (declaredNames.length === 0) return { kind: 'ready', environment: {}, originalEnvironment: original, sources: [] };
        const selected = await (snapshot ??= readSnapshot());
        if (selected.diagnostics.length) return { kind: 'refused', code: 'project_environment_binding_unavailable', diagnostics: selected.diagnostics };
        const resolveValue = (name: string, visiting: ReadonlySet<string>): string | undefined => {
            if (!Object.hasOwn(selected.values, name) || visiting.has(name)) return undefined;
            const next = new Set(visiting).add(name);
            let unresolved = false;
            const value = selected.values[name]!.replace(/\$\{([^}]*)\}/g, (_match, reference: string) => {
                const resolved = /^[\w.-]+$/.test(reference) ? resolveValue(reference, next) : undefined;
                if (resolved === undefined) unresolved = true;
                return resolved ?? '';
            });
            return unresolved ? undefined : value;
        };
        const environment: Record<string, string> = {};
        const sources: Array<Readonly<{ name: string; file: string }>> = [];
        for (const name of new Set(declaredNames)) {
            if (!Object.hasOwn(selected.values, name)) continue;
            const value = resolveValue(name, new Set());
            if (value === undefined) return { kind: 'refused', code: 'project_environment_binding_unavailable',
                diagnostics: [{ file: selected.files[name]!, name, code: 'unresolved_dotenv_reference' }] };
            environment[name] = value;
            sources.push({ name, file: selected.files[name]! });
        }
        return { kind: 'ready', environment: Object.freeze(environment), originalEnvironment: original, sources };
    } });
}
export type ProjectDotenvPreparation = ReturnType<typeof createProjectDotenvPreparation>;

export function readProjectDotenvEnvironment(input: Readonly<{ root: string; declaredNames: readonly string[]; originalEnvironment?: ProcessEnvInput }>): Promise<ProjectDotenvResult> {
    return createProjectDotenvPreparation(input.root).read(input.declaredNames, input.originalEnvironment);
}

/** Example literals never become runtime values or leave this owner. */
export async function inspectProjectEnvironmentImport(root: string): Promise<ProjectEnvironmentImportV1 | Exclude<ProjectDefinitionFileRead, { kind: 'read' }>> {
    const file = '.env.example' as const;
    const read = await readProjectDefinitionFile(root, file);
    if (read.kind !== 'read') return read;
    const parsed = parseProjectDotenv(read.content);
    const requirements: EnvVarRequirement[] = [];
    for (const name of Object.keys(parsed.values)) {
        const requirement = EnvVarRequirementSchema.safeParse({ name, kind: 'config', required: false });
        if (requirement.success) requirements.push(requirement.data);
    }
    return { kind: 'environment' as const, file, requirements, diagnostics: parsed.diagnostics };
}
