/** Native Compose owns parsing; the existing attachment owns runtime custody. */
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { DeploymentSourceMaterializationV1 } from '@happier-dev/plugin-sdk/services';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';
import type { HostDeploymentRuntimeProjectionV1 } from '@/deployments/secrets/deploymentExecEnvPort';
import { prepareNativeComposeNormalizationProfileForHost } from './nativeComposeEngine';
import { createProtectedLocalStateFileExclusive } from '@/utils/fs/protectedLocalState';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = (form: string): never => { throw new PluginError({ code: 'service_admission_unavailable',
    message: 'The native candidate runtime form is unavailable', details: { reason: 'native_runtime_form_unsupported', form } }); };
const nativeJson = (value: string): unknown => {
    try { return JSON.parse(value); }
    catch { return unavailable('native_json'); }
};

/** Actual normalized P41 phase model, source and command are closed over by its
 * candidate owner. No caller model/env/selector enters this callback.
 */
export function createNativeRuntimeProjectionForHost(input: Readonly<{
    source: DeploymentSourceMaterializationV1;
    composeArguments: readonly string[];
    io: ProjectNativeToolchainIo;
    assertCurrent(): Promise<void>;
}> & (Readonly<{ kind: 'source'; sourceFiles: readonly string[]; services: readonly string[] }>
    | Readonly<{ kind: 'configuration'; model: Readonly<Record<string, unknown>>; services: readonly string[];
        bindRuntimeEnvironment?: boolean }>
    | Readonly<{ kind: 'runtime'; model: Readonly<Record<string, unknown>>; services: readonly string[];
        commandArguments: readonly string[] }>
    | Readonly<{ kind: 'candidate'; model: Readonly<Record<string, unknown>>; service: string;
        commandArguments: readonly string[]; environmentOverrides?: Readonly<Record<string, string>> }>)): HostDeploymentRuntimeProjectionV1 {
    return {
        source: input.source,
        async prepare(runtime) {
            await input.assertCurrent();
            await runtime.assertCurrent();
            if (input.kind === 'source') {
                // --no-interpolate still resolves bare service/resource env in
                // native LoadModel. Remove attachment-named parent lookups before
                // that first source read, so a host DOCKER_HOST cannot overwrite
                // a bare application DOCKER_HOST before phase projection.
                const files = await runtime.files([]);
                const profile = await prepareNativeComposeNormalizationProfileForHost({ command: runtime.host.command,
                    prefix: runtime.host.prefix, cwd: runtime.host.cwd, env: runtime.host.env,
                    applicationEnvironmentNames: runtime.environmentNames });
                return { nativePrefix: profile.prefix, prefixArguments: profile.addedArguments, env: profile.env,
                    args: [input.composeArguments[0]!, ...profile.addedComposeArguments, ...input.composeArguments.slice(1),
                        '--env-file', files.emptyEnvironmentFile,
                        ...input.sourceFiles.flatMap(file => ['--file', file]), 'config', '--format', 'json',
                        '--no-interpolate', '--no-env-resolution', '--no-normalize', ...input.services] };
            }
            if (!record(input.model.services)) return unavailable('service');
            // Clone structure, not a re-parser/interpolator. Values remain the
            // native source expressions until native include performs lookup.
            const model: Record<string, unknown> = structuredClone(input.model);
            const services = input.kind === 'candidate' ? [input.service] : input.services;
            const bindRuntimeEnvironment = input.kind === 'runtime'
                || input.kind === 'configuration' && input.bindRuntimeEnvironment === true;
            const run = async (request: Readonly<{ args: readonly string[]; env: Readonly<Record<string, string>>;
                prefixArguments?: readonly string[]; nativePrefix?: readonly string[]; stdin?: Uint8Array }>) => {
                await input.assertCurrent();
                await runtime.assertCurrent();
                const launch = await runtime.admitNormalization(request);
                try {
                    const output = await input.io.run({ command: launch.command, args: launch.args, cwd: launch.cwd,
                        env: launch.env, ...(launch.stdin ? { stdin: launch.stdin } : {}),
                        ...(runtime.signal ? { signal: runtime.signal } : {}) });
                    if (output.exitCode !== 0) return unavailable('native_config');
                    await input.assertCurrent();
                    await runtime.assertCurrent();
                    return output.stdout;
                } finally { await launch.release(); }
            };
            if (input.kind === 'candidate') {
                const selectedService = input.model.services[input.service];
                if (!record(selectedService)) return unavailable('service');
                const service = structuredClone(selectedService);
                if (input.environmentOverrides) {
                    const originalEnvironment = service.environment ?? {};
                    if (!record(originalEnvironment)) return unavailable('service_environment');
                    service.environment = { ...originalEnvironment, ...input.environmentOverrides };
                }
                // The admitted native factory has already refused dependencies
                // without exact P41 running/configuration proof. Match native
                // --no-deps without choosing or starting an incumbent here.
                delete service.depends_on;
                model.services = { [input.service]: service };
            }
            if (!record(model.services)) return unavailable('service');
            const serviceEnvironmentNames = new Map<string, ReadonlySet<string>>();
            if (bindRuntimeEnvironment) {
                // Discovery has only constant non-secret lookup placeholders;
                // actual binding values stay in the selected AM-9 file. Native
                // Compose supplies explicit + env_file keys; discard all values.
                const bytes = Buffer.from(JSON.stringify(model));
                runtime.retainBytes(bytes);
                const emptyEnvironmentFile = await runtime.emptyEnvironmentFile();
                const profile = await prepareNativeComposeNormalizationProfileForHost({ command: runtime.host.command,
                    prefix: runtime.host.prefix, cwd: runtime.host.cwd, env: runtime.host.env,
                    applicationEnvironmentNames: runtime.environmentNames, discoveryLookup: true });
                const inventory = nativeJson(await run({ nativePrefix: profile.prefix, prefixArguments: profile.addedArguments,
                    args: [input.composeArguments[0]!, ...profile.addedComposeArguments, ...input.composeArguments.slice(1),
                        '--env-file', emptyEnvironmentFile,
                        // Image/build are deliberately absent until reviewed pins
                        // are selected. This query discovers environment keys only.
                        '--file', '-', 'config', '--format', 'json', '--no-consistency', ...services],
                    env: profile.env, stdin: bytes }));
                if (!record(inventory) || !record(inventory.services)) return unavailable('native_environment_keys');
                for (const [name, service] of Object.entries(inventory.services)) {
                    if (!record(service) || service.environment !== undefined && !record(service.environment))
                        return unavailable('native_environment_keys');
                    serviceEnvironmentNames.set(name, new Set(Object.keys(service.environment ?? {})));
                    // Discard native file values: this pass supplies names only.
                    delete service.environment;
                }
            }
            const bareNames: string[] = [];
            for (const [name, service] of Object.entries(model.services)) {
                if (!record(service)) return unavailable('service');
                if (record(service.environment)) service.environment = Object.entries(service.environment).map(([name, value]) => {
                    if (value === null) { bareNames.push(name); return name; }
                    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return unavailable('service_environment');
                    return `${name}=${String(value)}`;
                });
                if (bindRuntimeEnvironment) {
                    const environment = service.environment ?? [];
                    if (!Array.isArray(environment)) return unavailable('service_environment');
                    // Happier bindings are explicit service environment entries.
                    // Native last-key precedence also supplies env_file lookup;
                    // only expressions/names enter this unresolved model.
                    service.environment = [...environment,
                        ...runtime.environmentNames.filter(key => serviceEnvironmentNames.get(name)?.has(key))
                            .map(key => `${key}=\${${key}}`)];
                }
            }
            const slots: { kind: 'secrets' | 'configs'; key: string; name: string }[] = [];
            for (const kind of ['secrets', 'configs'] as const) {
                const declared = new Set(Object.values(model.services).flatMap(service => record(service) && Array.isArray(service[kind])
                    ? service[kind].flatMap(value => typeof value === 'string' ? [value]
                        : record(value) && typeof value.source === 'string' ? [value.source] : []) : []));
                const resources = record(model[kind]) ? model[kind] : {};
                const selected = Object.fromEntries(Object.entries(resources).filter(([name]) => declared.has(name)));
                model[kind] = selected;
                for (const [key, resource] of Object.entries(selected)) {
                    if (!record(resource)) return unavailable(kind);
                    if (typeof resource.environment !== 'string') continue;
                    slots.push({ kind, key, name: resource.environment });
                }
            }
            const unresolved = Buffer.from(JSON.stringify(model));
            runtime.retainBytes(unresolved);
            // Native parser owns variable/default/required discovery; no second
            // TypeScript expression scanner. No attachment values enter this query.
            const variables = nativeJson(await run({ args: [...input.composeArguments, '--file', '-',
                'config', '--variables', '--format', 'json', ...services], stdin: unresolved,
                env: { ...runtime.host.env, COMPOSE_DISABLE_ENV_FILE: '1' } }));
            if (!record(variables)) return unavailable('native_variables');
            const referenced = new Set([...Object.keys(variables), ...bareNames, ...slots.map(slot => slot.name)]);
            const selectedNames = runtime.environmentNames.filter(name => referenced.has(name));
            const files = await runtime.files(selectedNames);
            // The wrapper contains paths only; the phase file contains unresolved
            // source projection, never a resolved secret-bearing model.
            await createProtectedLocalStateFileExclusive(files.projectionFile, JSON.stringify(model));
            await createProtectedLocalStateFileExclusive(files.includeFile, JSON.stringify({ include: [{ path: files.projectionFile,
                project_directory: input.source.rootPath, env_file: files.interpolationFile }] }));
            const profile = await prepareNativeComposeNormalizationProfileForHost({ command: runtime.host.command,
                prefix: runtime.host.prefix, cwd: runtime.host.cwd, env: runtime.host.env, applicationEnvironmentNames: selectedNames });
            const normalizationArguments = [input.composeArguments[0]!, ...profile.addedComposeArguments,
                ...input.composeArguments.slice(1)];
            const normalization = { nativePrefix: profile.prefix, prefixArguments: profile.addedArguments,
                args: [...normalizationArguments, '--env-file', files.emptyEnvironmentFile,
                    '--file', files.includeFile, 'config', '--format', 'json', '--no-consistency', ...services], env: profile.env };
            if (input.kind === 'configuration') return normalization;
            const normalized = Buffer.from(await run(normalization));
            runtime.retainBytes(normalized);
            const resolved = nativeJson(normalized.toString('utf8'));
            if (!record(resolved) || !record(resolved.services)
                || Object.keys(resolved.services).length !== services.length
                || services.some(service => !record(resolved.services) || !record(resolved.services[service])))
                return unavailable('native_service_projection');
            if (slots.length) {
                // compose-go 2.9 loader/environment.go61-103 resolves include
                // environment resource slots before ToModel. Its native x-#value
                // and content carry values without a bind file or host env.
                // Ordinary ToProject MarshalJSON hides these values, hence the
                // second read-only native model query, not a second parser.
                const raw = nativeJson(await run({ ...normalization,
                    args: [...normalizationArguments, '--env-file', files.emptyEnvironmentFile,
                        '--file', files.includeFile, 'config', '--no-interpolate', '--no-env-resolution',
                        '--no-normalize', '--no-consistency', '--format', 'json', ...services] }));
                if (!record(raw)) return unavailable('native_resource_projection');
                for (const slot of slots) {
                    const resources = raw[slot.kind];
                    const targets = resolved[slot.kind];
                    if (!record(resources) || !record(targets)) return unavailable('native_resource_projection');
                    const native = resources[slot.key];
                    const target = targets[slot.key];
                    if (!record(native) || !record(target)) return unavailable('native_resource_projection');
                    const value = native[slot.kind === 'secrets' ? 'x-#value' : 'content'];
                    if (typeof value !== 'string') return unavailable(`${slot.kind}_environment_unbound`);
                    if (value === '' && slot.kind === 'configs') {
                        // Native injectConfigs skips empty env values, while
                        // create.go986 already skipped their bind mount. Keep
                        // that absence instead of inventing a zero-byte mount.
                        for (const service of Object.values(resolved.services)) {
                            if (!record(service) || !Array.isArray(service.configs)) continue;
                            service.configs = service.configs.filter(config => typeof config === 'string'
                                ? config !== slot.key : !record(config) || config.source !== slot.key);
                        }
                        delete targets[slot.key];
                        continue;
                    }
                    if (value === '') {
                        // Same global env-file has only this private empty
                        // lookup. Native injection still creates its own tar
                        // with declared uid/gid/mode; no live bind file exists.
                        target.environment = await runtime.emptyValueAlias([
                            ...Object.keys(runtime.host.env), ...runtime.environmentNames, ...referenced]);
                        continue;
                    }
                    // --no-interpolate does not apply config's dollar escape.
                    // Encode once for the native reload, never interpret it.
                    target[slot.kind === 'secrets' ? 'x-#value' : 'content'] = value.replaceAll('$', () => '$$');
                    if (slot.kind === 'configs') delete target.environment;
                }
            }
            const effect = slots.length ? Buffer.from(JSON.stringify(resolved)) : normalized;
            if (effect !== normalized) runtime.retainBytes(effect);
            // Native config already escaped normal fields for a reload.
            return { args: [...input.composeArguments, '--env-file', files.emptyEnvironmentFile,
                    '--file', '-', ...input.commandArguments],
                env: runtime.host.env, stdin: effect };
        },
    };
}
