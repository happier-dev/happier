import { hostname } from 'node:os';
import { parseNativeDockerEngineInfo, type NativeDockerEngineFacts } from '@happier-dev/cli-common/machineSetup';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { LocalServiceNativePrerequisiteV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';
import { join, resolve } from 'node:path';
import * as nativeFs from 'node:fs/promises';
import { machineNativeEffectAdmission } from './machineNativeEffectAdmission';
import { readObservedDockerEngineIds } from './dockerEngineObservation';

export type NativeComposeEngineFacts = NativeDockerEngineFacts;

export class NativeComposePrerequisiteError extends PluginError {
    constructor(cause: LocalServiceNativePrerequisiteV1['cause']) {
        const prerequisite: LocalServiceNativePrerequisiteV1 = { tool: 'docker', machineName: hostname(), cause };
        super({ code: 'native_tool_unavailable', message: 'Docker is unavailable on this machine', details: { prerequisite } });
    }
}

function dockerFailureCause(stderr: string, code?: unknown): LocalServiceNativePrerequisiteV1['cause'] {
    // Permission precedes Docker's generic "daemon is not running" advice on Windows.
    if (code === 'EACCES' || code === 'EPERM' || /permission denied|access is denied|operation not permitted/iu.test(stderr)) return 'permission_denied';
    if (code === 'ENOENT') return 'not_installed';
    if (code === 'ECONNREFUSED' || /cannot connect to the docker daemon|connection refused|no such file or directory|the system cannot find the file specified/iu.test(stderr)) return 'not_running';
    return 'unavailable';
}

type EngineReadInput = Readonly<{
    io: Pick<ProjectNativeToolchainIo, 'run'>;
    command: string;
    prefix: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
    signal?: AbortSignal;
}>;

/** One current native read supplies both admission identity and target disclosure. */
export async function readNativeComposeEngine(input: EngineReadInput): Promise<NativeComposeEngineFacts> {
    const assertNotCancelled = () => {
        if (input.signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    };
    assertNotCancelled();
    let output: Awaited<ReturnType<ProjectNativeToolchainIo['run']>>;
    try {
        output = await input.io.run({ command: input.command, args: [...input.prefix, 'info', '--format', '{{json .}}'],
            cwd: input.cwd, env: input.env, ...(input.signal ? { signal: input.signal } : {}) });
    } catch (error) {
        const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
        // Unsettled probe-process custody is not a native prerequisite refusal.
        if (code === 'plugin_exec_termination_incomplete') throw error;
        assertNotCancelled();
        throw new NativeComposePrerequisiteError(dockerFailureCause('', code));
    }
    assertNotCancelled();
    if (output.exitCode !== 0) throw new NativeComposePrerequisiteError(dockerFailureCause(output.stderr ?? ''));
    const facts = parseNativeDockerEngineInfo(output.stdout);
    if (!facts) throw new NativeComposePrerequisiteError('unavailable');
    return facts;
}

/** Existing workspace prerequisite consumes the same read without deployment policy. */
export async function assertNativeComposeAvailable(input: EngineReadInput): Promise<string> {
    return (await readNativeComposeEngine(input)).id;
}

type NormalizationProfile = Readonly<{
    command: string;
    prefix: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
}>;

function unavailable(cause: string): never {
    throw new PluginError({ code: 'service_admission_unavailable', message: 'The admitted Docker normalization profile is unavailable',
        details: { reason: 'native_normalization_profile_unrepresentable', cause } });
}

export async function prepareNativeComposeNormalizationProfileForHost(input: NormalizationProfile & Readonly<{
    applicationEnvironmentNames: readonly string[];
    /** Native key discovery receives constants only, never binding values. */
    discoveryLookup?: true;
    platform?: NodeJS.Platform;
}>): Promise<NormalizationProfile & Readonly<{ addedArguments: readonly string[]; addedComposeArguments: readonly string[] }>> {
    const platform = input.platform ?? process.platform;
    const canonical = (name: string) => platform === 'win32' ? name.toUpperCase() : name;
    const applicationNames = new Set(input.applicationEnvironmentNames.map(canonical));
    const original = new Map<string, string>();
    for (const [name, value] of Object.entries(input.env)) {
        const key = canonical(name);
        original.set(key, value);
    }
    const value = (name: string) => original.get(name);
    const collides = (name: string) => applicationNames.has(name) && original.has(name);
    const homeName = platform === 'win32' ? 'USERPROFILE' : 'HOME';
    // Observe only the flags relevant to an actual collision. Unknown unrelated
    // prefix bytes remain the granted native owner's concern, not our allowlist.
    const flags: Readonly<Record<string, Readonly<{ short?: string; boolean?: true; environment?: readonly string[] }>>> = {
        host: { short: 'H', environment: ['DOCKER_HOST'] }, context: { short: 'c', environment: ['DOCKER_CONTEXT'] },
        config: { environment: ['DOCKER_CONFIG', homeName] }, tls: { boolean: true, environment: ['DOCKER_TLS'] },
        tlsverify: { boolean: true, environment: ['DOCKER_TLS_VERIFY'] },
        tlscacert: { environment: ['DOCKER_CERT_PATH'] }, tlscert: { environment: ['DOCKER_CERT_PATH'] },
        tlskey: { environment: ['DOCKER_CERT_PATH'] },
    };
    const composeControls = {
        parallel: { environment: 'COMPOSE_PARALLEL_LIMIT', nativeDefault: '-1' },
        compatibility: { environment: 'COMPOSE_COMPATIBILITY' },
    } as const;
    const explicit = new Map<string, string>();
    const contextIndices = new Set<number>();
    for (const [name, definition] of Object.entries(flags)) {
        for (let index = 0; index < input.prefix.length; index++) {
            const token = input.prefix[index]!;
            if (token === `--${name}` || definition.short && token === `-${definition.short}`) {
                const assigned = definition.boolean ? 'true' : input.prefix[index + 1];
                if (assigned !== undefined) explicit.set(name, assigned);
                if (name === 'context') { contextIndices.add(index); contextIndices.add(index + 1); }
            } else if (token.startsWith(`--${name}=`)) {
                explicit.set(name, token.slice(name.length + 3));
                if (name === 'context') contextIndices.add(index);
            }
            else if (definition.short && token.startsWith(`-${definition.short}`) && token.length > 2) {
                explicit.set(name, token.slice(2).replace(/^=/u, ''));
                if (name === 'context') contextIndices.add(index);
            }
        }
    }
    // Preserve owned bytes/order separately from added native flags. The Exec
    // owner validates every added flag before combining the two exactly once.
    let prefix = [...input.prefix];
    const addedArguments: string[] = [];
    const append = (name: string, selected: string) => {
        if (!explicit.has(name)) {
            // Docker's pflag BoolVar has NoOptDefVal: a separate "true" is a
            // positional command, not the boolean value. Preserve native syntax.
            addedArguments.push(...(flags[name]?.boolean ? [`--${name}=${selected}`] : [`--${name}`, selected]));
            explicit.set(name, selected);
        }
    };
    const hostHome = value(platform === 'win32' ? 'USERPROFILE' : 'HOME');
    const initialConfig = value('DOCKER_CONFIG') || (hostHome ? join(hostHome, '.docker') : undefined);
    const configDirectoryChanges = !!value('DOCKER_CONFIG') ? collides('DOCKER_CONFIG') : !!hostHome && collides(homeName);
    // No existence check: fresh rootful Docker legitimately has no .docker yet.
    // No HOME collision => native config discovery stays exactly as before.
    if (configDirectoryChanges && !explicit.has('config')) {
        if (!initialConfig) unavailable('native_config_directory_unobservable');
        append('config', initialConfig);
    }
    const explicitContext = explicit.get('context');
    const explicitHost = explicit.get('host');
    const host = value('DOCKER_HOST');
    const context = value('DOCKER_CONTEXT');
    let defaultContext: boolean;
    if (explicitContext) {
        defaultContext = explicitContext === 'default';
        // CLI28.4 default context derives its endpoint from DOCKER_HOST. Native
        // --host H with no context selects that SAME default endpoint/TLS path;
        // remove only the owned redundant default-context flag in this helper.
        // Actual effect/observation retain the untouched original tuple.
        if (defaultContext && host && collides('DOCKER_HOST')) {
            // A repeated native string flag is last-wins. Earlier context
            // values were already overridden, not another effective selector.
            prefix = prefix.filter((_, index) => !contextIndices.has(index));
            explicit.delete('context');
            append('host', host);
        }
    } else if (explicitHost) defaultContext = true;
    else if (host) { if (collides('DOCKER_HOST')) append('host', host); defaultContext = true; }
    else if (context) { if (collides('DOCKER_CONTEXT')) append('context', context); defaultContext = context === 'default'; }
    else defaultContext = true; // Existing native config selects its own context.
    // No app-valued bytes are used here. TLS environment booleans are enabled by
    // ANY nonempty value (including "0"); --tlsverify=false still enables TLS.
    const nativeBool = (name: string) => ['1', 't', 'true'].includes(explicit.get(name)?.toLowerCase() ?? '');
    const verify = explicit.has('tlsverify') ? nativeBool('tlsverify') : !!value('DOCKER_TLS_VERIFY');
    const tls = explicit.has('tlsverify') || verify
        || (explicit.has('tls') ? nativeBool('tls') : !!value('DOCKER_TLS'));
    if (defaultContext && tls) {
        if (collides('DOCKER_TLS_VERIFY') && !explicit.has('tlsverify') && verify) append('tlsverify', 'true');
        if (collides('DOCKER_TLS') && !explicit.has('tls') && !explicit.has('tlsverify')) append('tls', 'true');
        const certificateDirectoryChanges = !!value('DOCKER_CERT_PATH') ? collides('DOCKER_CERT_PATH') : configDirectoryChanges;
        const certificates = value('DOCKER_CERT_PATH') || initialConfig;
        if (certificateDirectoryChanges && !certificates) unavailable('native_tls_directory_unobservable');
        if (certificateDirectoryChanges) append('tlscacert', join(certificates!, 'ca.pem'));
        // Docker drops missing default client cert/key, but preserves explicit
        // flags. Freeze the SAME absent/present fact, not another fallback path.
        for (const [flag, file] of [['tlscert', 'cert.pem'], ['tlskey', 'key.pem']] as const) {
            if (!certificateDirectoryChanges || explicit.has(flag)) continue;
            const path = join(certificates!, file);
            let selected = path;
            try { await nativeFs.stat(resolve(input.cwd, path)); }
            catch (error) {
                if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') selected = '';
            }
            append(flag, selected);
        }
    }
    const addedComposeArguments: string[] = [];
    const parallelName = composeControls.parallel.environment;
    if (applicationNames.has(parallelName) && (input.discoveryLookup || original.has(parallelName))) {
        const parallel = value(parallelName);
        // Compose2.39.4 compose.go522 uses decimal Atoi for the environment;
        // pflag's integer flag instead accepts base prefixes. Preserve decimal
        // semantics without rounding host values through a JavaScript number.
        if (parallel !== undefined && !/^[+-]?[0-9]+$/u.test(parallel)) unavailable('native_parallel_limit_invalid');
        addedComposeArguments.push('--parallel', parallel === undefined ? composeControls.parallel.nativeDefault : BigInt(parallel).toString());
    }
    // Preserve the predecessor projection's compatibility flag outside discovery.
    // Discovery cannot pin env-only compatibility with this flag: config.go93
    // additionally disables normalization, so its owned placeholder is removed.
    if (!input.discoveryLookup && collides(composeControls.compatibility.environment)
        && ['1', 't', 'T', 'TRUE', 'true', 'True'].includes(value(composeControls.compatibility.environment) ?? '')) {
        addedComposeArguments.push('--compatibility');
    }
    // Only endpoint/config/TLS and the Compose controls above are owned by the
    // helper. API preferences/plugin internals are NOT an application-name ban;
    // real helper failures settle normally, and the actual effect/observation
    // retain every original authorized host control unchanged.
    const env: Record<string, string> = Object.create(null);
    for (const [name, selected] of Object.entries(input.env)) {
        const key = canonical(name);
        if (applicationNames.has(key)) continue;
        env[name] = selected;
    }
    if (input.discoveryLookup) {
        for (const name of input.applicationEnvironmentNames) env[name] = '__HAPPIER_BINDING__';
        const ownedNames = new Set([...Object.values(flags).flatMap(flag => flag.environment ?? []),
            ...Object.values(composeControls).map(control => control.environment)].map(canonical));
        for (const name of Object.keys(env)) {
            if (applicationNames.has(canonical(name)) && ownedNames.has(canonical(name))) delete env[name];
        }
    }
    return { command: input.command, cwd: input.cwd, prefix, env, addedArguments, addedComposeArguments };
}

export async function readNativeDockerEffectEngines(input: EngineReadInput): Promise<Readonly<{
    dockerEngineIds: readonly string[]; allNative?: true;
}>> {
    input.signal?.throwIfAborted();
    const ids = new Set([...readObservedDockerEngineIds(), ...machineNativeEffectAdmission.readObservedDockerEngineIds()]);
    try {
        // Empty in-process custody is not proof of an observable empty inventory.
        // The canonical probe supplies availability and one observed identity.
        if (!ids.size) ids.add((await readNativeComposeEngine(input)).id);
        input.signal?.throwIfAborted();
        return { dockerEngineIds: [...ids] };
    } catch (error) {
        if (input.signal?.aborted || error && typeof error === 'object' && 'code' in error
            && error.code === 'plugin_exec_termination_incomplete') throw error;
        // Installing or repairing Docker must remain possible before its identity
        // is readable. The native owner serializes this effect against the Machine.
        return { dockerEngineIds: [], allNative: true };
    }
}
