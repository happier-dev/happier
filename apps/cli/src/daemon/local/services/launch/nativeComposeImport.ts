import { readFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { ManagedServiceNativeLifecycleV1 } from '@happier-dev/plugin-sdk/managed-services';
import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { normalizeStoredComposeDefinitionInput, parseNativeComposeSource } from '@/workspaces/projectSetup/nativeComposeSource';

type Source = Extract<Awaited<ReturnType<NonNullable<ManagedServiceNativeLifecycleV1['composeSource']>>>, { kind: 'ready' }>['source'];
export type NativeComposeDefinitionCapture = Readonly<{
    origin: Readonly<{ projectName: string; dockerEndpoint: string; workingDirectory: string }>;
    configFiles: readonly string[]; containerIds: readonly string[];
    document: string; services: readonly string[]; profiles: readonly string[]; availableProfiles: readonly string[];
    variables: readonly Readonly<{ name: string; phase: 'runtime'; required: boolean; hasDefault: boolean }>[];
}>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function unavailable(): never { throw new PluginError({ code: 'compose_source_unavailable', message: 'The native Compose source is unavailable' }); }
const absolute = (value: string) => posix.isAbsolute(value) || win32.isAbsolute(value);

/** Import mode of the native Compose boundary. No values or default bytes escape this host capture. */
export async function captureNativeComposeDefinition(input: Readonly<{
    exec: ExecService; source: Source; profiles: readonly string[]; options?: PluginCancellationOptions;
}>): Promise<NativeComposeDefinitionCapture> {
    const { source, exec, options } = input;
    options?.signal?.throwIfAborted();
    if (!absolute(source.workingDirectory) || !source.configFiles.length || source.configFiles.some(file => !absolute(file))) unavailable();
    // Future profiles must be explicitly supplied, including the deliberate empty set.
    if (!Array.isArray(input.profiles) || input.profiles.some(profile => typeof profile !== 'string' || !profile || profile.includes('\0'))) unavailable();
    const profiles = [...new Set(input.profiles)];
    const prefix = ['compose', '--project-name', source.projectName, '--project-directory', source.workingDirectory,
        ...profiles.flatMap(profile => ['--profile', profile])];
    const base = [...prefix, ...source.configFiles.flatMap(file => ['--file', file])];
    const run = async (args: readonly string[], stdin?: Uint8Array): Promise<Record<string, unknown>> => {
        // Exec.run owns host launch authorization and physical process settlement.
        // Preserve its exact Docker endpoint/environment; never substitute ambient env.
        const output = await exec.run({ executable: { kind: 'systemTool', id: 'docker' }, args, cwd: source.workingDirectory,
            // Native falls back to COMPOSE_PROFILES for an empty flag list.
            // This one control pins the explicit future selection, including [].
            env: { COMPOSE_PROFILES: profiles.join(',') }, ...(stdin ? { stdin } : {}) }, options);
        options?.signal?.throwIfAborted();
        if (output.termination.requestedBy.kind !== 'none' || output.termination.observed.kind !== 'exit'
            || output.termination.observed.exitCode !== 0 || output.stdoutTruncated) unavailable();
        try { const parsed: unknown = JSON.parse(new TextDecoder().decode(output.stdout)); return record(parsed) ? parsed : unavailable(); }
        catch { return unavailable(); }
    };
    const model = await run([...base, 'config', '--format', 'json', '--no-interpolate', '--no-env-resolution']);
    if (!record(model.services)) unavailable();
    const variables = await run([...base, 'config', '--variables', '--format', 'json']);
    const rows = new Map<string, { name: string; phase: 'runtime'; required: boolean; hasDefault: boolean }>();
    for (const [name, value] of Object.entries(variables)) {
        if (!/^[a-z_][a-z0-9_]*$/iu.test(name) || !record(value)
            || typeof (value.Required ?? value.required) !== 'boolean') unavailable();
        const fallback = value.DefaultValue ?? value.defaultValue;
        rows.set(name, { name, phase: 'runtime', required: (value.Required ?? value.required) === true,
            hasDefault: typeof fallback === 'string' && fallback.length > 0 });
    }
    // Reuse the runtime projection's native key query: only env_file references
    // enter it, so unrelated required expressions need no binding at import.
    // Compose still owns env_file parsing and precedence; discard its values.
    const keyProjection = { services: Object.fromEntries(Object.entries(model.services).map(([name, service]) => {
        if (!record(service)) unavailable();
        return [name, service.env_file === undefined ? {} : { env_file: service.env_file }];
    })) };
    const inventory = await run([...prefix, '--file', '-', 'config', '--format', 'json', '--no-consistency'],
        Buffer.from(JSON.stringify(keyProjection)));
    if (!record(inventory.services)) unavailable();
    const placeholder = (name: string, required: boolean) => `\${${name}${required ? ':?required' : ''}}`;
    // This erases expression operands, not a second variable/default decision.
    // The native --variables result above is the authority for each identity/fact.
    const valueFreeString = (value: string): string => {
        let result = '';
        for (let index = 0; index < value.length;) {
            if (value[index] !== '$') { result += value[index++]; continue; }
            if (value[index + 1] === '$') { result += '$$'; index += 2; continue; }
            const braced = value[index + 1] === '{';
            const name = /^[a-z_][a-z0-9_]*/iu.exec(value.slice(index + (braced ? 2 : 1)))?.[0];
            if (!name) { result += value[index++]; continue; }
            const row = rows.get(name);
            if (!row) unavailable();
            let end = index + (braced ? 2 : 1) + name.length;
            if (braced) {
                const operandStart = end;
                const operator = /^:?[?+\-]/u.exec(value.slice(end))?.[0];
                // Compose's JSON variable facts encode both no default and an
                // explicitly empty default as ''. Retain that syntax fact while
                // erasing the operand; native discovery still owns the names.
                row.hasDefault ||= operator?.includes('-') === true || operator?.includes('+') === true;
                row.required ||= operator?.includes('?') === true;
                let depth = 1;
                while (end < value.length && depth > 0) {
                    if (value[end] === '{') depth++;
                    if (value[end] === '}') depth--;
                    end++;
                }
                if (depth !== 0) unavailable();
                valueFreeString(value.slice(operandStart, end - 1));
            }
            result += placeholder(name, row.required); index = end;
        }
        return result;
    };
    const valueFree = (value: unknown): unknown => typeof value === 'string' ? valueFreeString(value)
        : Array.isArray(value) ? value.map(valueFree)
            : record(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, valueFree(child)])) : value;
    // Use the sole stored-source policy on original sidecar references before
    // native merge can erase include/extends. Native output owns resolved binds.
    for (const file of source.configFiles) {
        const original = await parseNativeComposeSource(await readFile(file, 'utf8'));
        const policy = structuredClone(original);
        if (record(policy.services)) for (const service of Object.values(policy.services)) if (record(service)) {
            delete service.env_file; delete service.volumes;
        }
        await normalizeStoredComposeDefinitionInput({ from: 'compose', document: JSON.stringify(policy), profiles, services: Object.keys(model.services) });
        // Source syntax retains empty defaults in service environment entries;
        // their entire value is replaced below, so gather those facts first.
        valueFree(original);
    }
    const availableProfiles = new Set<string>();
    for (const [serviceName, service] of Object.entries(model.services)) {
        const keys = inventory.services[serviceName];
        if (!record(service) || !record(keys) || keys.environment !== undefined && !record(keys.environment)) unavailable();
        if (Array.isArray(service.profiles)) for (const profile of service.profiles) if (typeof profile === 'string') availableProfiles.add(profile);
        const originalEnvironment = record(service.environment) ? service.environment : {};
        const names = new Set([...Object.keys(originalEnvironment), ...Object.keys(keys.environment ?? {})]);
        service.environment = Object.fromEntries([...names].map(name => {
            if (!/^[a-z_][a-z0-9_]*$/iu.test(name)) unavailable();
            const required = Object.hasOwn(originalEnvironment, name) ? originalEnvironment[name] !== null
                : record(keys.environment) && keys.environment[name] !== null;
            const existing = rows.get(name);
            rows.set(name, { name, phase: 'runtime', required: required || (existing?.required ?? false),
                hasDefault: existing?.hasDefault === true || originalEnvironment[name] != null || record(keys.environment) && keys.environment[name] != null });
            return [name, placeholder(name, required)];
        }));
        delete service.env_file;
    }
    for (const kind of ['configs', 'secrets'] as const) {
        const resources = model[kind];
        if (!record(resources)) continue;
        for (const resource of Object.values(resources)) {
            if (!record(resource) || typeof resource.environment !== 'string') continue;
            const name = resource.environment;
            if (!/^[a-z_][a-z0-9_]*$/iu.test(name)) unavailable();
            const existing = rows.get(name);
            rows.set(name, { name, phase: 'runtime', required: true, hasDefault: existing?.hasDefault ?? false });
            // Native LoadModel can acquire environment-backed resources even
            // with --no-interpolate. Keep their reference, never acquired bytes.
            delete resource.content;
            delete resource['x-#value'];
        }
    }
    model.name = source.projectName;
    const document = JSON.stringify(valueFree(model));
    const services = Object.keys(model.services);
    await normalizeStoredComposeDefinitionInput({ from: 'compose', document, profiles, services });
    options?.signal?.throwIfAborted();
    return { origin: { projectName: source.projectName, dockerEndpoint: source.engineId, workingDirectory: source.workingDirectory },
        configFiles: [...source.configFiles], containerIds: [...source.containerIds].sort(), document, services, profiles,
        availableProfiles: [...availableProfiles].sort(), variables: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
