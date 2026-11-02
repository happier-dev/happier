import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { watch } from 'node:fs';
import { create as createTar } from 'tar';
import type { DeploymentImageV1 } from '@happier-dev/deployment-protocol';

type DockerImageFixture = Readonly<{ image: DeploymentImageV1; archive: string; nativeId: string;
    archiveDirectory: string; manifest: string; configuration: string }>;
export type OwnServerDockerInvocation = Readonly<{
    args: readonly string[];
    cwd: string;
    environmentKeys: readonly string[];
    dockerHostMatchesExpected?: boolean;
    files: readonly Readonly<{ path: string; content: string }>[];
}>;

/** A real executable substitutes Docker only; all host process and domain owners remain real. */
export async function createOwnServerDockerBoundary(directory: string, options?: Readonly<{ operatingSystem?: string; engineId?: string; expectedDockerHost?: string;
    runtimeInventoryFailure?: boolean;
    accounting?: Readonly<{ memoryBytes: number }>;
    nativeCaddy?: Readonly<Record<string, unknown>>; nativeCloudflare?: Readonly<Record<string, unknown>> }>) {
    await mkdir(directory, { recursive: true });
    const statePath = join(directory, 'docker-state.json');
    const invocationsPath = join(directory, 'docker-invocations.jsonl');
    const executablePath = join(directory, 'docker');
    const writeState = async (value: unknown) => {
        await writeFile(`${statePath}.next`, JSON.stringify(value));
        await rename(`${statePath}.next`, statePath);
    };
    await writeFile(statePath, JSON.stringify({ images: {}, tags: {}, containers: [], health: {}, imageHealth: {},
        engineId: options?.engineId ?? 's0-docker-engine', operatingSystem: options?.operatingSystem ?? 'Ubuntu 24.04.3 LTS',
        runtimeInventoryFailure: options?.runtimeInventoryFailure ?? false,
        ...(options?.accounting ? { accounting: options.accounting } : {}),
        ...(options?.nativeCaddy ? { nativeCaddy: options.nativeCaddy } : {}),
        ...(options?.nativeCloudflare ? { nativeCloudflare: options.nativeCloudflare } : {}),
        ...(options?.expectedDockerHost !== undefined ? { expectedDockerHost: options.expectedDockerHost } : {}) }));
    await writeFile(invocationsPath, '');
    const require = createRequire(import.meta.url);
    await writeFile(executablePath, `#!${process.execPath}\nconst tar = require(${JSON.stringify(require.resolve('tar'))});\nconst yaml = require(${JSON.stringify(require.resolve('yaml'))});\n` + String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const nativeArgs = process.argv.slice(2);
let rootOffset = 0;
let explicitHost;
let explicitContext;
while (rootOffset < nativeArgs.length) {
    const token = nativeArgs[rootOffset];
    const name = token.split('=')[0];
    if (['--host', '-H', '--context', '-c', '--config', '--tlscacert', '--tlscert', '--tlskey'].includes(name)) {
        const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : nativeArgs[++rootOffset];
        if (name === '--host' || name === '-H') explicitHost = value;
        if (name === '--context' || name === '-c') explicitContext = value;
        rootOffset++; continue;
    }
    if (/^--tls(?:verify)?(?:=|$)/.test(token)) { rootOffset++; continue; }
    break;
}
const args = nativeArgs.slice(rootOffset);
const statePath = path.join(__dirname, 'docker-state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const files = args.flatMap((arg, index) => arg === '--file' ? [{ path: args[index + 1],
    content: fs.readFileSync(args[index + 1] === '-' ? 0 : args[index + 1], 'utf8') }] : []);
const observedHost = explicitHost || (explicitContext && explicitContext !== 'default'
    ? state.contextEndpoints?.[explicitContext] : process.env.DOCKER_HOST);
fs.appendFileSync(path.join(__dirname, 'docker-invocations.jsonl'), JSON.stringify({ args: nativeArgs, cwd: process.cwd(),
    environmentKeys: Object.keys(process.env).sort(), files: files.map(file => file.path === '-'
        ? { path: '-', content: '[private native stdin omitted]' } : file),
    ...(state.expectedDockerHost !== undefined ? { dockerHostMatchesExpected: observedHost === state.expectedDockerHost } : {}) }) + '\n');
const write = value => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
const writeOperation = value => state.operationStdoutBase64 === undefined ? write(value)
    : process.stdout.write(Buffer.from(state.operationStdoutBase64, 'base64'));
const save = () => { fs.writeFileSync(statePath+'.next', JSON.stringify(state)); fs.renameSync(statePath+'.next', statePath); };
const imageFor = reference => state.images[state.tags[reference] || reference];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
// Genuine OS/Docker boundary substitute, pinned to compose-go2.9 native
// include/ResolveEnvironment and config escapeDollarSign semantics. This is
// not a host parser or an admission replacement; unsupported fixture syntax
// fails loudly rather than inventing another source language.
const parseEnvironment = filename => Object.fromEntries(fs.readFileSync(filename, 'utf8').split('\n').filter(Boolean).map(line => {
    const equal = line.indexOf('=');
    if (equal < 1) throw new Error('fixture_invalid_env_file');
    const name = line.slice(0, equal);
    let value = line.slice(equal + 1);
    if (value.startsWith('"')) {
        if (!value.endsWith('"')) throw new Error('fixture_invalid_env_file');
        value = value.slice(1, -1).replace(/\\([\\"$rn])/g, (_, escaped) => ({ r: '\r', n: '\n' }[escaped] ?? escaped));
    }
    return [name, value];
}));
const projectName = args[args.indexOf('--project-name') + 1];
const globalEnvFile = args.includes('--env-file') ? args[args.indexOf('--env-file') + 1] : undefined;
const nativeEnvironment = { ...(globalEnvFile ? parseEnvironment(globalEnvFile) : {}), ...process.env,
    ...(args.includes('--project-name') ? { COMPOSE_PROJECT_NAME: projectName } : {}) };
const interpolate = (value, environment = nativeEnvironment) => typeof value === 'string'
    ? value.replace(/\$\$|\$\{([A-Z_][A-Z0-9_]*)(?::\?[^}]*)?\}/g, (token, name) => {
        if (token === '$$') return '$';
        if (environment[name] === undefined) throw new Error('fixture_binding_unavailable:' + name);
        return environment[name];
    }) : Array.isArray(value) ? value.map(item => interpolate(item, environment))
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, environment)])) : value;
const resolveEnvironment = (model, environment) => {
    for (const service of Object.values(model.services || {})) {
        if (Array.isArray(service.environment)) service.environment = Object.fromEntries(service.environment.map(entry => {
            const equal = entry.indexOf('=');
            const name = equal < 0 ? entry : entry.slice(0, equal);
            return [name, equal < 0 ? environment[name] ?? null : entry.slice(equal + 1)];
        }));
    }
    for (const kind of ['secrets', 'configs']) for (const resource of Object.values(model[kind] || {})) {
        if (typeof resource.environment === 'string' && environment[resource.environment] !== undefined) {
            resource[kind === 'secrets' ? 'x-#value' : 'content'] = environment[resource.environment];
        }
    }
    return model;
};
const loadNativeModel = (file, noInterpolate = false) => {
    let model = yaml.parse(file.content);
    if (model.include) {
        if (model.include.length !== 1) throw new Error('fixture_single_include_required');
        const included = model.include[0];
        const environment = { ...parseEnvironment(included.env_file), ...nativeEnvironment };
        model = yaml.parse(fs.readFileSync(included.path, 'utf8'));
        model = resolveEnvironment(noInterpolate ? model : interpolate(model, environment), environment);
    } else model = resolveEnvironment(noInterpolate ? model : interpolate(model), nativeEnvironment);
    return model;
};
if (args[0] === 'system' && args[1] === 'dial-stdio') {
    // The production owner consumes Engine HTTP events over this native transport.
    // Mock only that native transport, retaining real HTTP framing and processes.
    let ready = false;
    let previous = state;
    const changed = () => {
        if (!ready) return;
        const current = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        for (const row of current.containers) {
            const service = row.Config.Labels['com.docker.compose.service'];
            if (previous.health[service] === current.health[service]) continue;
            const event = JSON.stringify({ Type: 'container', Action: 'health_status: '+(current.health[service] || 'healthy'), Actor: { ID: row.Id } })+'\n';
            write(Buffer.byteLength(event).toString(16)+'\r\n'+event+'\r\n');
        }
        previous = current;
    };
    const watcher = fs.watch(__dirname, (_, file) => { if (String(file) === 'docker-state.json') changed(); });
    process.stdin.once('data', () => {
        write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n');
        ready = true; changed();
    });
    process.stdin.on('end', () => { watcher.close(); process.exit(0); });
    process.stdin.resume();
} else if (args[0] === 'compose' && args[1] === 'version') write('2.39.4\n');
else if (args[0] === 'version') write('linux/amd64\n');
else if (args[0] === 'info') write(args.at(-1) === '{{json .}}'
    ? { ID: state.engineId, OperatingSystem: state.operatingSystem } : state.engineId+'\n');
else if (args[0] === 'container' && args[1] === 'ls' && args.includes('label=dev.happier.machine-setup.recipe=caddy@1')) {
    write(state.nativeCaddy ? JSON.stringify(state.nativeCaddy.Id)+'\n' : '');
} else if (args[0] === 'container' && args[1] === 'inspect' && args.at(-1) === state.nativeCaddy?.Id) {
    write([state.nativeCaddy]);
} else if (args[0] === 'container' && args[1] === 'ls' && args.some(arg => arg.startsWith('name=^/happier-cloudflared-'))) {
    write(state.nativeCloudflare ? JSON.stringify(state.nativeCloudflare.Id)+'\n' : '');
} else if (args[0] === 'container' && args[1] === 'inspect' && args.at(-1) === state.nativeCloudflare?.Id) {
    write([state.nativeCloudflare]);
} else if (args[0] === 'container' && args[1] === 'stop' && args.at(-1) === state.nativeCloudflare?.Id) {
    state.nativeCloudflare.State.Running = false; save();
} else if (args[0] === 'container' && args[1] === 'rm' && args.at(-1) === state.nativeCloudflare?.Id) {
    delete state.nativeCloudflare; save();
}
else if (args[0] === 'image' && args[1] === 'ls') {
    const reference = args.at(-1);
    if (args.length !== 6 || !args.includes('--all') || !args.includes('--quiet') || !args.includes('--no-trunc')
        || reference.startsWith('-')) throw new Error('fixture_requires_exact_image_alias');
    if (state.imageAliasInventoryUnavailable) { process.stderr.write('native inventory unavailable\n'); process.exitCode = 1; }
    else write((imageFor(reference)?.nativeId || '')+'\n');
} else if (args[0] === 'container' && args[1] === 'ls' && args.includes('--all') && args.includes('--quiet')) {
    const ancestor = args[args.indexOf('--filter')+1];
    if (!ancestor?.startsWith('ancestor=')) throw new Error('fixture_unknown_container_filter');
    write(state.containers.filter(row => row.Image === ancestor.slice('ancestor='.length)).map(row => row.Id).join('\n'));
} else if (args[0] === 'image' && args[1] === 'rm') {
    if (args.length !== 4 || args[2] !== '--no-prune') throw new Error('fixture_unsafe_image_removal');
    const reference = args[3];
    const image = imageFor(reference);
    const id = image?.nativeId;
    const row = state.pruneImages?.[id];
    const aliases = image ? [...new Set([...(row?.repoTags || []), ...(row?.repoDigests || []),
        ...Object.keys(state.tags).filter(alias => imageFor(alias)?.nativeId === id)])] : [];
    if (!image || state.containers.some(container => container.Image === id)
        || reference === id && aliases.length) {
        process.stderr.write('native image is referenced\n'); process.exitCode = 1;
    } else {
        if (reference !== id) {
            delete state.tags[reference];
            if (row) { row.repoTags = row.repoTags.filter(alias => alias !== reference); row.repoDigests = row.repoDigests.filter(alias => alias !== reference); }
        }
        if (reference === id || aliases.every(alias => alias === reference)) {
            for (const [alias, fixture] of Object.entries(state.images)) if (fixture.nativeId === id) delete state.images[alias];
            if (state.pruneImages) delete state.pruneImages[id];
        }
        save(); write((reference === id ? 'Deleted: ' : 'Untagged: ')+reference+'\n');
        if (state.loseImageRemovalAcknowledgement) process.kill(process.pid, 'SIGKILL');
        if (state.holdImageRemovalReplies) { process.stdin.resume(); setInterval(() => {}, 1000); }
    }
}
else if (args[0] === 'image' && args[1] === 'inspect') {
    if (typeof state.imageInspectionOutput === 'string') { write(state.imageInspectionOutput); process.exit(0); }
    const reference = args.at(-1);
    const image = imageFor(reference);
    if (!image) throw new Error('fixture_image_unavailable');
    write([{ Id: image.nativeId, Descriptor: { digest: image.image.manifestDigest, mediaType: 'application/vnd.oci.image.manifest.v1+json' },
        RepoTags: [...new Set([...(state.pruneImages?.[image.nativeId]?.repoTags || []),
            ...Object.keys(state.tags).filter(alias => !alias.includes('@') && imageFor(alias)?.nativeId === image.nativeId)])],
        RepoDigests: [...new Set([...(state.pruneImages?.[image.nativeId]?.repoDigests || ['example/s0@' + image.image.manifestDigest]),
            ...Object.keys(state.tags).filter(alias => alias.includes('@') && imageFor(alias)?.nativeId === image.nativeId)])] }]);
} else if (args[0] === 'buildx' && args[1] === 'imagetools' && args[2] === 'inspect') {
    const image = imageFor(args.at(-1));
    if (!image) throw new Error('fixture_image_unavailable');
    if (args.includes('--raw')) write(state.registryManifests?.[args.at(-1)] ?? image.manifest);
    else if (args[args.indexOf('--format') + 1] === '{{json .Image}}') write(image.configuration);
    else throw new Error('fixture_unexpected_image_inspection');
} else if (args[0] === 'image' && args[1] === 'save') {
    const image = imageFor(args.at(-1));
    if (!image) throw new Error('fixture_image_unavailable');
    fs.copyFileSync(image.archive, args[args.indexOf('--output') + 1]);
} else if (args[0] === 'image' && args[1] === 'load') {
    const archive = args[args.indexOf('--input') + 1];
    const unpacked = fs.mkdtempSync(path.join(__dirname, 'load-'));
    try {
        tar.x({ cwd: unpacked, file: archive, sync: true });
        const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'manifest.json'), 'utf8'));
        for (const entry of manifest) {
            const configuration = fs.readFileSync(path.join(unpacked, entry.Config));
            const image = imageFor('sha256:' + hash(configuration));
            if (!image) throw new Error('fixture_unregistered_build_image');
            for (const tag of entry.RepoTags || []) state.tags[tag] = image.image.registryReference;
        }
        save();
    } finally { fs.rmSync(unpacked, { recursive: true, force: true }); }
} else if (args[0] === 'image' && args[1] === 'tag') {
    if (!imageFor(args[2])) throw new Error('fixture_image_unavailable');
    state.tags[args[3]] = state.tags[args[2]] || args[2]; save();
} else if (args[0] === 'compose' && args.includes('config')) {
    if (files.length !== 1) throw new Error('fixture_compose_file_required');
    if (args.includes('--variables')) {
        const variables = {};
        files[0].content.replace(/\$\$|\$\{([A-Z_][A-Z0-9_]*)(?::\?[^}]*)?\}/g, (token, name) => {
            if (name) variables[name] = { required: token.includes(':?') };
            return token;
        });
        write(variables);
    } else {
    const model = loadNativeModel(files[0], args.includes('--no-interpolate'));
    // Real Compose 5.6 rejects the image-free intermediate review model unless
    // this read-only query explicitly skips full project consistency.
    const incomplete = Object.values(model.services || {}).some(service => !service.image && !service.build);
    if (incomplete && (!args.includes('--no-consistency') || state.runtimeInventoryFailure)) {
        process.stderr.write('service has neither an image nor a build context specified: invalid compose project\n');
        if (state.runtimeInventoryFailure) process.stderr.write('private-runtime-config-sentinel\n');
        process.exit(1);
    }
    const projectDirectory = args[args.indexOf('--project-directory') + 1] || path.dirname(files[0].path);
    // Compose's config contract resolves build paths independently of model
    // normalization. Buildx later runs from the host's empty build directory.
    for (const definition of Object.values(model.services || {})) {
        if (typeof definition.build === 'string') definition.build = { context: path.resolve(projectDirectory, definition.build) };
        else if (definition.build?.context) definition.build.context = path.resolve(projectDirectory, definition.build.context);
    }
    if (!args.includes('--no-interpolate')) {
        // Native config selects the requested services and their dependency
        // closure. The unresolved source inventory still contains every service.
        const requested = args.slice(args.indexOf('config') + 1).filter(arg => Object.hasOwn(model.services || {}, arg));
        if (requested.length) {
            const selected = new Set();
            const include = service => {
                if (selected.has(service)) return;
                if (!model.services[service]) throw new Error('fixture_service_unavailable');
                selected.add(service);
                const dependencies = model.services[service].depends_on || {};
                for (const dependency of Array.isArray(dependencies) ? dependencies : Object.keys(dependencies)) include(dependency);
            };
            requested.forEach(include);
            model.services = Object.fromEntries(Object.entries(model.services).filter(([service]) => selected.has(service)));
        }
        // Native typed MarshalJSON intentionally conceals environment slot
        // values; the private raw ToModel query is required to preserve them.
        for (const resource of Object.values(model.secrets || {})) delete resource['x-#value'];
        for (const resource of Object.values(model.configs || {})) if (resource.environment) delete resource.content;
    }
    write(args.includes('--no-interpolate') ? model : JSON.stringify(model).replaceAll('$', () => '$$'));
    }
} else if (args[0] === 'buildx' && args[1] === 'bake') {
    if (files.length !== 1) throw new Error('fixture_bake_projection_required');
    const projection = JSON.parse(files[0].content);
    const requested = args.filter(arg => /^[a-z][a-z0-9_-]*-native$/.test(arg));
    const services = requested.length ? requested.map(target => target.slice(0, -7)) : Object.keys(projection.services);
    const target = Object.fromEntries(services.map(service => {
        const definition = projection.services[service];
        if (!definition?.build) throw new Error('fixture_build_service_required');
        const build = typeof definition.build === 'string' ? { context: definition.build } : definition.build;
        const context = path.resolve(build.context);
        const dockerfile = path.resolve(context, build.dockerfile || 'Dockerfile');
        // Docker is the substituted system. The real host must supply an
        // exported immutable source tree and its existing build instructions.
        if (!fs.statSync(dockerfile).isFile()) throw new Error('fixture_dockerfile_unavailable');
        return [service + '-native', { context, dockerfile, tags: build.tags?.length ? build.tags : [definition.image],
            args: build.args || {}, secret: [] }];
    }));
    if (args.includes('--print')) write({ target });
    else {
        const settings = args.flatMap((arg, index) => arg === '--set' ? [args[index + 1]] : []);
        if (!settings.includes('*.platform=linux/amd64')) throw new Error('fixture_build_platform_unavailable');
        const metadata = {};
        for (const service of services) {
            const name = service + '-native';
            const output = settings.find(setting => setting.startsWith(name + '.output=type=docker,dest='));
            const reference = settings.find(setting => setting.startsWith(name + '.tags='))?.slice((name + '.tags=').length);
            const image = imageFor(state.buildImages?.[service]);
            if (!output || !reference || !image) throw new Error('fixture_build_output_unavailable');
            const archive = output.slice((name + '.output=type=docker,dest=').length);
            const configurationFile = image.image.configDigest.slice('sha256:'.length) + '.json';
            fs.writeFileSync(path.join(image.archiveDirectory, 'manifest.json'), JSON.stringify([
                { Config: configurationFile, RepoTags: [reference], Layers: [] }]));
            tar.c({ cwd: image.archiveDirectory, file: archive, sync: true }, [configurationFile, 'manifest.json']);
            metadata[name] = { 'containerimage.config.digest': image.image.configDigest,
                'containerimage.digest': image.image.manifestDigest, 'containerimage.descriptor': {
                    digest: image.image.manifestDigest, mediaType: 'application/vnd.oci.image.manifest.v1+json' } };
        }
        fs.writeFileSync(args[args.indexOf('--metadata-file') + 1], JSON.stringify(metadata));
    }
} else if (args[0] === 'compose' && args.includes('up')) {
    if (!args.includes('--no-build') || args[args.indexOf('--pull') + 1] !== 'never') throw new Error('fixture_unpinned_activation');
    const model = loadNativeModel(files[0]);
    const project = args[args.indexOf('--project-name') + 1];
    state.containers = [...state.containers.filter(row => row.Config.Labels['com.docker.compose.project'] !== project),
        ...Object.entries(model.services).flatMap(([service, definition]) => {
        const image = imageFor(definition.image);
        if (!image || definition.build !== undefined || definition.pull_policy !== 'never') throw new Error('fixture_unpinned_image');
        return Array.from({ length: definition.deploy?.replicas ?? 1 }, (_, replica) => {
            const id = hash(project + '/' + service + '/' + definition.image + (replica ? '/'+replica : ''));
            const previous = state.containers.find(row => row.Id === id);
            return { Id: id, Name: '/' + project + '-' + service + '-' + (replica + 1), Image: image.nativeId,
            Config: { Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': service,
                'com.docker.compose.project.working_dir': args[args.indexOf('--project-directory') + 1],
                'com.docker.compose.container-number': String(replica+1) },
                Env: Object.entries(definition.environment || {}).map(([name, value]) => name + '=' + value),
                StopTimeout: definition.stop_grace_period === undefined ? undefined
                    : Number(String(definition.stop_grace_period).replace(/s$/, '')) },
            HostConfig: { RestartPolicy: { Name: definition.restart || 'no', MaximumRetryCount: 0 },
                Memory: 0, CpuShares: 0 },
            State: { Status: 'running', ExitCode: 0,
                Health: definition.healthcheck?.disable ? undefined
                    : { Status: state.imageHealth[image.image.configDigest] || state.health[service] || 'healthy' } },
            Mounts: (definition.volumes || []).filter(mount => mount.type === 'volume').map(mount => ({
                Type: 'volume', Name: model.volumes[mount.source].name, Destination: mount.target, RW: mount.read_only !== true })),
            RestartCount: previous?.RestartCount ?? 0, NetworkSettings: { Ports: Object.fromEntries(
                [...new Set((definition.ports || []).map(port => String(port.target) + '/' + (port.protocol || 'tcp')))]
                    .map(key => [key, definition.ports.filter(port => String(port.target) + '/' + (port.protocol || 'tcp') === key)
                        .map(port => ({ HostIp: port.host_ip || '0.0.0.0', HostPort: String(port.published) }))])),
                Networks: { [project + '_default']: {} } } };
        });
    })]; save();
    if (state.holdActivationReply) {
        state.holdingActivationReply = true; save();
        let released = false;
        const release = () => {
            if (released || JSON.parse(fs.readFileSync(statePath, 'utf8')).holdActivationReply) return;
            released = true; watcher.close();
        };
        const watcher = fs.watch(__dirname, (_, file) => { if (String(file) === 'docker-state.json') release(); });
        release();
    }
    if (state.stageOutputEnvironmentKey) {
        const value = Object.values(model.services).map(service => service.environment?.[state.stageOutputEnvironmentKey])
            .find(value => typeof value === 'string' && value.length > 0);
        if (!value) throw new Error('fixture_stage_environment_missing');
        // Retain only this fixture's diagnostic sentinel for the later native
        // cleanup response; this does not inject an undeclared app variable.
        state.stageOutputValue = value; save();
        const split = Math.floor(value.length / 2);
        process.stdout.write('native rollout '+value.slice(0, split));
        setImmediate(() => {
            process.stdout.write(value.slice(split)+' PORT=3000\n');
            process.stderr.write('native diagnostic '+value.slice(0, split));
            setImmediate(() => process.stderr.write(value.slice(split)+' PORT=3000\n'));
        });
    }
} else if (args[0] === 'run' || args[0] === 'create') {
    if (args[0] === 'run' && !args.includes('--rm') || args[args.indexOf('--pull') + 1] !== 'never') throw new Error('fixture_unsafe_operation_container');
    const mounts = args.flatMap((arg, index) => arg === '--mount' ? [Object.fromEntries(args[index + 1].split(',').map(field => {
        const equals = field.indexOf('='); return equals < 0 ? [field, true] : [field.slice(0, equals), field.slice(equals + 1)];
    }))] : []);
    for (const mount of mounts) {
        if (mount.readonly !== true) throw new Error('fixture_writable_backup_mount');
        if (mount.type === 'bind' && !fs.statSync(mount.source).isFile()) throw new Error('fixture_missing_bind_source');
    }
    const environment = Object.fromEntries(args.flatMap((arg, index) => arg === '--env' ? [args[index + 1]] : []).map(entry => {
        const equal = entry.indexOf('='); return equal < 0 ? [entry, process.env[entry]] : [entry.slice(0, equal), entry.slice(equal + 1)];
    }));
    const image = args.find(arg => imageFor(arg));
    if (!image) throw new Error('fixture_missing_operation_image');
    const password = mounts.find(mount => mount.type === 'bind' && mount.target === environment.RESTIC_PASSWORD_FILE);
    if (!password) throw new Error('fixture_missing_operation_credentials');
    const output = { passwordReadable: fs.readFileSync(password.source, 'utf8').startsWith('repository-'),
        accessPresent: environment.AWS_ACCESS_KEY_ID?.startsWith('access-') === true,
        secretPresent: environment.AWS_SECRET_ACCESS_KEY?.startsWith('secret-') === true,
        readOnlyData: mounts.some(mount => mount.type === 'volume' && mount.readonly === true && mount['volume-nocopy'] === true) };
    const name = args[args.indexOf('--name') + 1];
    const id = hash(name);
    const row = { Id: id, Name: '/' + name, Image: imageFor(image).nativeId,
        Config: { Labels: { 'happier.operation': name } }, Mounts: [],
        State: { Status: args[0] === 'create' ? 'created' : 'running', ExitCode: 0 } };
    const finish = () => {
        const current = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (!current.containers.some(value => value.Id === id)) current.containers.push(row);
        current.operationOutputs = { ...current.operationOutputs, [id]: output };
        if (args[0] === 'run') current.containers = current.containers.filter(value => value.Id !== id);
        fs.writeFileSync(statePath + '.next', JSON.stringify(current)); fs.renameSync(statePath + '.next', statePath);
        if (args[0] === 'create') write(id + '\n'); else writeOperation(output);
    };
    if (state.holdOperationConstruction) {
        state.pendingOperation = { kind: args[0], row, output }; save();
        let completed = false;
        const release = () => {
            if (completed || JSON.parse(fs.readFileSync(statePath, 'utf8')).holdOperationConstruction) return;
            completed = true; watcher.close(); finish();
        };
        const watcher = fs.watch(__dirname, (_, file) => { if (String(file) === 'docker-state.json') release(); });
        release();
    } else finish();
} else if (args[0] === 'start') {
    if (!args.includes('--attach') || !args.includes('--interactive')) throw new Error('fixture_unattached_operation_start');
    const row = state.containers.find(row => row.Id === args.at(-1));
    if (!row || !state.operationOutputs?.[row.Id]) throw new Error('fixture_missing_created_operation');
    row.State.Status = 'exited'; save(); writeOperation(state.operationOutputs[row.Id]);
} else if (args[0] === 'compose' && (args.includes('exec') || args.includes('run'))) {
    const mode = args.includes('exec') ? 'exec' : 'run';
    const offset = args.indexOf(mode);
    const shell = mode === 'exec' && args[offset + 1] === '-it' && args[offset + 3] === '/bin/sh'
        && args.length === offset + 4;
    if (!shell && (!args.includes('-T') || args.includes('-it') || mode === 'run'
        && (!args.includes('--rm') || !args.includes('--no-deps') || !args.includes('--no-build')
            || args[args.indexOf('--pull') + 1] !== 'never'))) throw new Error('fixture_unsafe_finite_command');
    const outcome = state.commandOutcome || {};
    const runModel = mode === 'run' ? loadNativeModel(files[0]) : undefined;
    const commandService = mode === 'run' ? runModel?.services?.[args[offset + 7]] : undefined;
    state.commands = [...(state.commands || []), { mode, args: args.slice(offset), running: !!outcome.hold,
        ...(commandService ? { imageConfigDigest: imageFor(commandService.image)?.image.configDigest,
            environmentMatchesExpected: Object.entries(outcome.expectedServiceValues?.environment || {})
                .every(([name, value]) => commandService.environment?.[name] === value) } : {}) }]; save();
    const complete = () => {
    if (outcome.expectedRunImageConfigDigest) {
        const service = args[offset + 7];
        const nativeImage = imageFor(runModel?.services?.[service]?.image);
        write(JSON.stringify({ candidateImageMatches: nativeImage?.image.configDigest === outcome.expectedRunImageConfigDigest }));
    }
    if (outcome.expectedServiceValues) {
        const service = runModel?.services?.[args[offset + 7]];
        const expected = outcome.expectedServiceValues;
        write(JSON.stringify({ environmentMatchesExpected: Object.entries(expected.environment || {}).every(([name, value]) => service?.environment?.[name] === value)
                && (expected.absentEnvironmentKeys || []).every(name => !Object.hasOwn(service?.environment || {}, name)),
            labelsMatchExpected: Object.entries(expected.labels || {}).every(([name, value]) => service?.labels?.[name] === value) }));
    }
    // Only this fixture's Docker client dies: the native command's exit ACK
    // never arrives, so client-tree settlement cannot prove native completion.
    if (outcome.loseExitAcknowledgement) { process.kill(process.pid, 'SIGTERM'); return; }
    if (!outcome.hold) {
        const current = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        const command = current.commands.at(-1);
        if (command) { command.running = false; command.completed = true; command.exitCode = outcome.exitCode || 0; }
        fs.writeFileSync(statePath + '.next', JSON.stringify(current)); fs.renameSync(statePath + '.next', statePath);
    }
    if (outcome.environmentKey) {
        const project = args[args.indexOf('--project-name') + 1];
        const service = args[offset + (mode === 'exec' ? 2 : 7)];
        const container = state.containers.find(row => row.Config.Labels['com.docker.compose.project'] === project
            && row.Config.Labels['com.docker.compose.service'] === service && row.State.Status === 'running');
        const value = mode === 'exec' ? container?.Config.Env.find(entry => entry.startsWith(outcome.environmentKey + '='))
            ?.slice(outcome.environmentKey.length + 1) : runModel?.services?.[service]?.environment?.[outcome.environmentKey];
        write(outcome.expectedEnvironmentValue === undefined ? value || '' : JSON.stringify({
            matchesExpected: (value ?? '') === outcome.expectedEnvironmentValue, present: value !== undefined }));
    }
    if (outcome.stdout) write(outcome.stdout);
    if (outcome.resource) {
        const { kind, source, expectedValue } = outcome.resource;
        const service = args[offset + 7];
        const reference = runModel?.services?.[service]?.[kind]?.find(item => typeof item === 'string' ? item === source : item.source === source);
        const resource = reference ? runModel?.[kind]?.[source] : undefined;
        let value;
        if (resource) {
            if (resource.file !== undefined) throw new Error('fixture_resource_requires_native_injection');
            value = resource[kind === 'secrets' ? 'x-#value' : 'content'];
            if (resource.environment && (kind === 'configs' || !value)) {
                if (!Object.hasOwn(nativeEnvironment, resource.environment)) throw new Error('fixture_resource_environment_unavailable');
                value = nativeEnvironment[resource.environment];
            }
        }
        write(JSON.stringify({ exists: !!reference, matchesExpected: value === expectedValue,
            ...(reference && typeof reference === 'object' ? { uid: reference.uid, gid: reference.gid, mode: reference.mode } : {}) }));
    }
    if (outcome.stderr) process.stderr.write(outcome.stderr);
    if (outcome.hold) { process.stdin.resume(); setInterval(() => {}, 1000); }
    else process.exitCode = outcome.exitCode || 0;
    };
    if (state.holdCommandReplies && !outcome.hold) {
        let emitted = false;
        const release = () => {
            if (emitted || JSON.parse(fs.readFileSync(statePath, 'utf8')).holdCommandReplies) return;
            emitted = true; watcher.close(); complete();
        };
        const watcher = fs.watch(__dirname, (_, file) => { if (String(file) === 'docker-state.json') release(); });
        release();
    } else complete();
} else if (args[0] === 'ps') {
    const filters = args.flatMap((arg, index) => arg === '--filter' ? [args[index + 1]] : []);
    write(state.containers.filter(row => (args.includes('--all') || row.State.Status === 'running') && filters.every(filter => {
        if (filter.startsWith('volume=')) return row.Mounts.some(mount => mount.Name === filter.slice('volume='.length));
        if (filter.startsWith('id=')) return row.Id === filter.slice('id='.length);
        const label = filter.slice('label='.length);
        const separator = label.indexOf('=');
        return separator < 0 ? Object.hasOwn(row.Config.Labels, label)
            : row.Config.Labels[label.slice(0, separator)] === label.slice(separator + 1);
    })).map(row => row.Id).join('\n'));
} else if (args[0] === 'stats') {
    for (const row of state.containers.filter(row => args.includes(row.Id) && row.State.Status === 'running')) {
        write(JSON.stringify({ ID: row.Id, CPUPerc: '--', MemUsage: state.accounting ? state.accounting.memoryBytes+'B / --' : '-- / --' })+'\n');
    }
} else if (args[0] === 'inspect' && args[1] === '--type' && args[2] === 'container') {
    const emit = () => {
        const current = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        write(current.containers.filter(row => args.includes(row.Id)).map(row => ({ ...row,
            State: { ...row.State, Health: !row.State.Health || current.health[row.Config.Labels['com.docker.compose.service']] === 'not_reported' ? undefined : { Status: Object.values(current.images).find(image => image.nativeId === row.Image)
                && current.imageHealth[Object.values(current.images).find(image => image.nativeId === row.Image).image.configDigest]
                || current.health[row.Config.Labels['com.docker.compose.service']] || 'healthy' } } })));
    };
    if (state.holdNextContainerInspection) {
        // Consume one reply only: concurrent read-only cold selection must
        // still receive its genuine Docker evidence while supervision waits.
        state.holdNextContainerInspection = false;
        state.holdingContainerInspection = true;
        save();
        let emitted = false;
        const release = () => {
            if (emitted || JSON.parse(fs.readFileSync(statePath, 'utf8')).holdingContainerInspection) return;
            emitted = true; watcher.close(); emit();
        };
        const watcher = fs.watch(__dirname, (_, file) => { if (String(file) === 'docker-state.json') release(); });
        release();
    } else emit();
} else if (args[0] === 'logs') {
    const emit = () => {
        const current = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        const output = current.logs && current.logs[args.at(-1)];
        if (output) { process.stdout.write(output.stdout); process.stderr.write(output.stderr); }
        else write('s0 deployment diagnostic\n');
    };
    if (state.holdLogs) {
        let emitted = false;
        const release = () => {
            if (emitted || JSON.parse(fs.readFileSync(statePath, 'utf8')).holdLogs) return;
            emitted = true; watcher.close(); emit();
        };
        const watcher = fs.watch(__dirname, (_, file) => { if (String(file) === 'docker-state.json') release(); });
        // The controller can release after the invocation is recorded but
        // before this watcher exists. Recheck after installing the watch.
        release();
    } else emit();
} else if (args[0] === 'container' && args[1] === 'stop') {
    if (args.includes('--timeout')) throw new Error('fixture_competing_stop_timeout');
    for (const row of state.containers) if (args.includes(row.Id)) row.State.Status = 'exited';
    save();
} else if (args[0] === 'container' && args[1] === 'rm') {
    if (args.includes('--volumes')) throw new Error('fixture_volume_removal_denied');
    if (!args.includes('--force') && state.containers.some(row => args.includes(row.Id) && row.State.Status === 'running')) {
        process.exitCode = 1; return;
    }
    if (state.stageOutputEnvironmentKey) {
        const value = state.stageOutputValue;
        if (!value) throw new Error('fixture_stage_environment_missing');
        const split = Math.floor(value.length / 2);
        process.stdout.write('native cleanup '+value.slice(0, split));
        setImmediate(() => {
            process.stdout.write(value.slice(split)+' PORT=3000\n');
            process.stderr.write('native diagnostic '+value.slice(0, split));
            setImmediate(() => process.stderr.write(value.slice(split)+' PORT=3000\n'));
        });
    }
    state.containers = state.containers.filter(row => !args.includes(row.Id)); save();
}
else throw new Error('fixture_unexpected_docker_command:' + JSON.stringify(args));
`);
    await chmod(executablePath, 0o755);

    async function registerImage(service: string, revision: string, options?: Readonly<{ volumes: readonly string[] }>): Promise<DeploymentImageV1> {
        const imageDirectory = join(directory, `image-${service}-${revision}`);
        await mkdir(imageDirectory);
        const config = Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux',
            config: { Labels: { 's0.revision': revision, 's0.service': service },
                ...(options ? { Volumes: Object.fromEntries(options.volumes.map(target => [target, {}])) } : {}) },
            rootfs: { type: 'layers', diff_ids: [] } }));
        const configHex = createHash('sha256').update(config).digest('hex');
        const configFile = `${configHex}.json`;
        const manifestBytes = Buffer.from(JSON.stringify({ schemaVersion: 2,
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
            config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: `sha256:${configHex}`, size: config.byteLength }, layers: [] }));
        const manifestHex = createHash('sha256').update(manifestBytes).digest('hex');
        const reference = `example/s0-${service}@sha256:${manifestHex}`;
        const image: DeploymentImageV1 = { service, platform: 'linux/amd64', configDigest: `sha256:${configHex}`,
            manifestDigest: `sha256:${manifestHex}`, registryReference: reference };
        await writeFile(join(imageDirectory, configFile), config);
        await writeFile(join(imageDirectory, 'manifest.json'), JSON.stringify([{ Config: configFile, RepoTags: [], Layers: [] }]));
        const archive = join(directory, `image-${service}-${revision}.tar`);
        await createTar({ cwd: imageDirectory, file: archive }, [configFile, 'manifest.json']);
        const fixture = { image, archive, archiveDirectory: imageDirectory, nativeId: `sha256:${createHash('sha256').update(`native-store:${service}:${revision}`).digest('hex')}`,
            manifest: manifestBytes.toString('utf8'), configuration: config.toString('utf8') };
        const state = JSON.parse(await readFile(statePath, 'utf8')) as { images: Record<string, DockerImageFixture> };
        state.images[reference] = fixture;
        state.images[image.configDigest] = fixture;
        state.images[fixture.nativeId] = fixture;
        await writeState(state);
        return image;
    }

    return {
        executablePath,
        registerImage,
        async setImageContainerReference(nativeId: string, stateKind: 'running' | 'exited' | null) {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as { containers: Array<{ Id: string; Image: string;
                State: { Status: string }; Config: { Labels: Record<string, string>; Env: string[] } }> };
            const id = `prune-container-${nativeId.slice('sha256:'.length)}`;
            state.containers = state.containers.filter(container => container.Id !== id);
            if (stateKind) state.containers.push({ Id: id, Image: nativeId, State: { Status: stateKind }, Config: { Labels: {}, Env: [] } });
            await writeState(state);
        },
        async setPruneEngineId(engineId: string) {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
            state.engineId = engineId; await writeState(state);
        },
        async setImageInspectionOutput(output: string | null) {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
            if (output === null) delete state.imageInspectionOutput;
            else state.imageInspectionOutput = output;
            await writeState(state);
        },
        async holdImageRemovalReplies(hold: boolean) {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
            state.holdImageRemovalReplies = hold; await writeState(state);
        },
        async holdActivationReply(hold: boolean) {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
            state.holdActivationReply = hold; await writeState(state);
        },
        async waitForActivationReplyHeld() {
            await new Promise<void>((resolve, reject) => {
                const check = async () => {
                    try {
                        const state = JSON.parse(await readFile(statePath, 'utf8')) as { holdingActivationReply?: boolean };
                        if (state.holdingActivationReply) { watcher.close(); resolve(); }
                    } catch (error) { watcher.close(); reject(error); }
                };
                const watcher = watch(directory, (_, file) => { if (String(file) === 'docker-state.json') void check(); });
                watcher.on('error', reject);
                void check();
            });
        },
        async loseImageRemovalAcknowledgement(lose: boolean) {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
            state.loseImageRemovalAcknowledgement = lose; await writeState(state);
        },
        async setImageAliasInventoryUnavailable(unavailable: boolean) {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
            state.imageAliasInventoryUnavailable = unavailable; await writeState(state);
        },
        async readPruneReference(reference: string): Promise<string | null> {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as { tags: Record<string, string>; images: Record<string, DockerImageFixture> };
            return state.images[state.tags[reference] || reference]?.nativeId ?? null;
        },
        async readPruneImageIds(): Promise<readonly string[]> {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as { images: Record<string, DockerImageFixture> };
            return [...new Set(Object.values(state.images).map(image => image.nativeId))];
        },
        /** Recorded public registry/OS bytes, consumed by real image proof. */
        async registerRecordedImage(service: string, rootReference: string,
            record: Readonly<{ index: string; manifest: string; config: string }>) {
            const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
            if (!rootReference.endsWith(`@${digest(record.index)}`)) throw new Error('fixture_registry_index_mismatch');
            const manifestDigest = digest(record.manifest);
            const manifest = JSON.parse(record.manifest) as { config: { digest: string } };
            if (manifest.config.digest !== digest(record.config)) throw new Error('fixture_registry_config_mismatch');
            const repository = rootReference.slice(0, rootReference.lastIndexOf('@'));
            const image = { service, platform: 'linux/amd64', indexDigest: digest(record.index), manifestDigest,
                configDigest: manifest.config.digest, registryReference: `${repository}@${manifestDigest}` };
            const archiveDirectory = join(directory, `image-${service}-recorded`);
            await mkdir(archiveDirectory);
            const file = image.configDigest.slice(7) + '.json';
            await writeFile(join(archiveDirectory, file), record.config);
            await writeFile(join(archiveDirectory, 'manifest.json'), JSON.stringify([{ Config: file, RepoTags: [], Layers: [] }]));
            const archive = join(directory, `image-${service}-recorded.tar`);
            await createTar({ cwd: archiveDirectory, file: archive }, [file, 'manifest.json']);
            const nativeId = image.configDigest;
            const fixture = { image, nativeId, archiveDirectory, archive, manifest: record.manifest, configuration: record.config };
            const state = JSON.parse(await readFile(statePath, 'utf8')) as { images: Record<string, DockerImageFixture>;
                registryManifests?: Record<string, string> };
            for (const name of [image.registryReference, image.configDigest, rootReference]) state.images[name] = fixture;
            state.registryManifests = { ...state.registryManifests, [rootReference]: record.index,
                [image.registryReference]: record.manifest };
            await writeState(state);
        },
        /** Only external Docker state changes; receipt/native identity logic remains production. */
        async setImagePruneState(reference: string, facts: Readonly<{ repoTags: readonly string[]; repoDigests: readonly string[] }>): Promise<string> {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as { images: Record<string, DockerImageFixture>;
                tags: Record<string, string>; pruneImages?: Record<string, { repoTags: string[]; repoDigests: string[] }> };
            const image = state.images[state.tags[reference] || reference];
            if (!image) throw new Error('fixture_image_unavailable');
            state.pruneImages ??= {};
            for (const alias of [...(state.pruneImages[image.nativeId]?.repoTags ?? []), ...(state.pruneImages[image.nativeId]?.repoDigests ?? [])]) {
                if (state.images[state.tags[alias]]?.nativeId === image.nativeId) delete state.tags[alias];
            }
            state.pruneImages[image.nativeId] = { repoTags: [...facts.repoTags], repoDigests: [...facts.repoDigests] };
            for (const alias of [...facts.repoTags, ...facts.repoDigests]) state.tags[alias] = image.nativeId;
            await writeState(state);
            return image.nativeId;
        },
        /** Deterministic Docker build output; host source/build/receipt logic stays real. */
        async registerBuildResult(service: string, revision: string) {
            const image = await registerImage(service, revision);
            const state = JSON.parse(await readFile(statePath, 'utf8')) as { buildImages?: Record<string, string> };
            state.buildImages = { ...state.buildImages, [service]: image.registryReference! };
            await writeState(state);
            return image;
        },
        async setNativeRestartCount(service: string, restartCount: number) {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as { containers: Array<{
                Config: { Labels: Record<string, string> }; RestartCount: number;
            }> };
            for (const row of state.containers) if (row.Config.Labels['com.docker.compose.service'] === service) row.RestartCount = restartCount;
            await writeState(state);
        },
        async setStageOutputEnvironmentKey(name: string) {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
            state.stageOutputEnvironmentKey = name;
            await writeState(state);
        },
        async setOperationStdout(bytes: Uint8Array) {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
            state.operationStdoutBase64 = Buffer.from(bytes).toString('base64');
            await writeState(state);
        },
        async holdRuntimeLogReads(hold: boolean) {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
            state.holdLogs = hold;
            await writeState(state);
        },
        async holdNextContainerInspection(hold: boolean) {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
            state.holdNextContainerInspection = hold;
            state.holdingContainerInspection = false;
            await writeState(state);
        },
        async isContainerInspectionHeld() {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
            return state.holdingContainerInspection === true;
        },
        async setCommandOutcome(outcome: Readonly<{ stdout?: string; stderr?: string; exitCode?: number; environmentKey?: string; hold?: boolean;
            loseExitAcknowledgement?: boolean;
            expectedEnvironmentValue?: string;
            expectedRunImageConfigDigest?: string;
            expectedServiceValues?: Readonly<{ environment?: Readonly<Record<string, string>>; labels?: Readonly<Record<string, string>>;
                absentEnvironmentKeys?: readonly string[] }>;
            resource?: Readonly<{ kind: 'secrets' | 'configs'; source: string; expectedValue?: string }> }>) {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
            state.commandOutcome = outcome;
            await writeState(state);
        },
        /** Test verifier reads actual finite native-boundary evidence, not an admission stub. */
        async readCommandConfigurations(): Promise<readonly Readonly<{ imageConfigDigest?: string; environmentMatchesExpected?: boolean }>[]> {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as { commands?: readonly {
                mode: string; imageConfigDigest?: string; environmentMatchesExpected?: boolean;
            }[] };
            return (state.commands ?? []).filter(command => command.mode === 'run').map(command => ({
                imageConfigDigest: command.imageConfigDigest, environmentMatchesExpected: command.environmentMatchesExpected,
            }));
        },
        /** Test verifier reads actual finite native-boundary evidence, not an admission stub. */
        async readCompletedCommand(argv: readonly string[]): Promise<number | null> {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as { commands?: readonly {
                mode: string; args: readonly string[]; running: boolean; completed?: boolean; exitCode?: number;
            }[] };
            const command = state.commands?.find(row => row.mode === 'run' && row.completed && !row.running
                && row.args.length === 8 + argv.length && argv.every((arg, index) => row.args[index + 8] === arg));
            return typeof command?.exitCode === 'number' ? command.exitCode : null;
        },
        async holdCommandReplies(hold: boolean) {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
            state.holdCommandReplies = hold;
            await writeState(state);
        },
        async stopCurrentContainers() {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as { containers: Array<{ State: { Status: string } }> };
            for (const row of state.containers) row.State.Status = 'exited';
            await writeState(state);
        },
        async holdOperationConstruction() {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
            state.holdOperationConstruction = true;
            delete state.pendingOperation;
            await writeState(state);
        },
        async waitForOperationConstruction(): Promise<'run' | 'create'> {
            return new Promise((resolve, reject) => {
                const watcher = watch(directory, (_event, file) => { if (String(file) === 'docker-state.json') void read(); });
                const read = async () => {
                    try {
                        const state = JSON.parse(await readFile(statePath, 'utf8')) as { pendingOperation?: { kind: 'run' | 'create' } };
                        if (state.pendingOperation) { watcher.close(); resolve(state.pendingOperation.kind); }
                    } catch (error) { watcher.close(); reject(error); }
                };
                void read();
            });
        },
        async releaseOperationConstruction() {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as { holdOperationConstruction?: boolean;
                containers: Array<{ Id: string }>; pendingOperation?: { row: { Id: string }; output: unknown };
                operationOutputs?: Record<string, unknown> };
            const pending = state.pendingOperation;
            if (!pending) throw new Error('Expected a held native constructor');
            // Docker Engine commits independently of a cancelled local CLI.
            state.containers.push(pending.row);
            state.operationOutputs = { ...state.operationOutputs, [pending.row.Id]: pending.output };
            state.holdOperationConstruction = false;
            await writeState(state);
        },
        async readOperationContainerIds(): Promise<readonly string[]> {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as { containers: Array<{ Id: string; Config: { Labels: Record<string, string> } }> };
            return state.containers.filter(row => row.Config.Labels['happier.operation']).map(row => row.Id);
        },
        async failImageHealth(configDigest: string) {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as { imageHealth: Record<string, string> };
            state.imageHealth[configDigest] = 'unhealthy';
            await writeState(state);
        },
        async readRunningImageConfig(service: string): Promise<string | null> {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as {
                containers: readonly { Image: string; Config: { Labels: Readonly<Record<string, string>> } }[];
                images: Readonly<Record<string, DockerImageFixture>>;
            };
            const row = state.containers.find(container => container.Config.Labels['com.docker.compose.service'] === service);
            return row ? Object.values(state.images).find(image => image.nativeId === row.Image)?.image.configDigest ?? null : null;
        },
        /** Verifier memory only; ordinary inspect/log readers keep their real host projection. */
        async readRuntimeEnvironment(service: string): Promise<Readonly<Record<string, string>>> {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as { containers: readonly {
                Config: { Labels: Readonly<Record<string, string>>; Env: readonly string[] };
            }[] };
            const row = state.containers.find(container => container.Config.Labels['com.docker.compose.service'] === service);
            if (!row) throw new Error('fixture_native_service_missing');
            return Object.fromEntries(row.Config.Env.map(entry => {
                const equals = entry.indexOf('=');
                return [entry.slice(0, equals), entry.slice(equals + 1)];
            }));
        },
        /** Post-detach native output, including one secret split across stdout/stderr. */
        async emitRuntimeLogFromEnvironment(service: string, name: string): Promise<void> {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as { containers: readonly {
                Id: string; Config: { Labels: Readonly<Record<string, string>>; Env: readonly string[] };
            }[]; logs?: Record<string, { stdout: string; stderr: string }> };
            const row = state.containers.find(container => container.Config.Labels['com.docker.compose.service'] === service);
            const value = row?.Config.Env.find(entry => entry.startsWith(`${name}=`))?.slice(name.length + 1);
            if (!row || !value) throw new Error('fixture_native_environment_missing');
            const midpoint = Math.floor(value.length / 2);
            state.logs ??= {};
            state.logs[row.Id] = { stdout: value.slice(0, midpoint), stderr: `${value.slice(midpoint)} PORT=3000\n` };
            await writeState(state);
        },
        async readInvocations(): Promise<readonly OwnServerDockerInvocation[]> {
            return (await readFile(invocationsPath, 'utf8')).trim().split('\n').filter(Boolean)
                .map(line => JSON.parse(line) as OwnServerDockerInvocation);
        },
        async changeNativeHealth(service: string, health: 'healthy' | 'unhealthy' | 'not_reported') {
            const state = JSON.parse(await readFile(statePath, 'utf8')) as { health: Record<string, string> };
            state.health[service] = health;
            await writeState(state);
        },
    };
}
