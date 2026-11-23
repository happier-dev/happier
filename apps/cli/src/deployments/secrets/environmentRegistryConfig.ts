import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod/mini';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { normalizeConnectedAccountConfiguredOrigin } from '@happier-dev/protocol/connect/execute-configuration-action';

const credentialSchema = z.union([
    z.strictObject({ username: z.string().check(z.minLength(1), z.refine(value => !value.includes(':'))), password: z.string() }),
    z.strictObject({ auth: z.string().check(z.minLength(1)) }),
    z.strictObject({ identitytoken: z.string().check(z.minLength(1)) }),
    z.strictObject({ registrytoken: z.string().check(z.minLength(1)) }),
]);

function invalid(): never {
    throw new PluginError({ code: 'invalid_request', message: 'Registry credential configuration is invalid' });
}

type RegistryCredential = Readonly<{
    registryOrigin: string;
    credential: string;
}>;

/**
 * Docker CLI v27.5.1 AuthConfig/configfile contract: only native authentication
 * fields enter auths; helpers, contexts and other caller configuration never do.
 * https://github.com/docker/cli/blob/v27.5.1/cli/config/types/authconfig.go
 * https://github.com/docker/cli/blob/v27.5.1/cli/command/registry.go
 */
export function createEnvironmentRegistryConfigForHost(input: Readonly<{ baseDir: string }> &
    (RegistryCredential | Readonly<{ registries: readonly RegistryCredential[] }>)) {
    const registries = 'registries' in input ? input.registries : [input];
    const auths: Record<string, Readonly<{ auth: string } | { identitytoken: string } | { registrytoken: string }>> = Object.create(null);
    const redactionValues: string[] = [];
    for (const registry of registries) {
        let origin: string;
        let decoded: unknown;
        try {
            origin = normalizeConnectedAccountConfiguredOrigin(registry.registryOrigin).origin;
            decoded = JSON.parse(registry.credential);
        } catch { return invalid(); }
        const parsed = credentialSchema.safeParse(decoded);
        if (!parsed.success) return invalid();
        const credential = parsed.data;
        redactionValues.push(registry.credential);
        let auth: Readonly<{ auth: string } | { identitytoken: string } | { registrytoken: string }>;
        if ('username' in credential) {
            const combined = `${credential.username}:${credential.password}`;
            auth = { auth: Buffer.from(combined).toString('base64') };
            redactionValues.push(credential.username, credential.password, combined, auth.auth);
        } else if ('auth' in credential) {
            const bytes = Buffer.from(credential.auth, 'base64');
            try {
                if (bytes.toString('base64') !== credential.auth || !bytes.includes(0x3a)) return invalid();
                auth = { auth: credential.auth };
                const combined = bytes.toString('utf8');
                const separator = combined.indexOf(':');
                redactionValues.push(credential.auth, combined, combined.slice(0, separator), combined.slice(separator + 1));
            } finally { bytes.fill(0); }
        } else {
            auth = credential;
            redactionValues.push('identitytoken' in credential ? credential.identitytoken : credential.registrytoken);
        }
        const host = new URL(origin).host;
        // Docker's official index uses this native auth key; other registries use
        // the exact admitted host[:port], as Docker's own login/config owner does.
        const key = host === 'docker.io' || host === 'index.docker.io' ? 'https://index.docker.io/v1/' : host;
        if (auths[key] && !isDeepStrictEqual(auths[key], auth)) return invalid();
        auths[key] = auth;
    }
    // Config serialization escapes tokens. Register that exact representation
    // with the existing lease too, so a JSON diagnostic echo stays redacted.
    for (const value of [...redactionValues]) redactionValues.push(JSON.stringify(value).slice(1, -1));
    mkdirSync(input.baseDir, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(join(input.baseDir, 'registry-'));
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        rmSync(directory, { recursive: true, force: true });
        redactionValues.length = 0;
        disposed = true;
    };
    try {
        // Docker auto-detects the OS credential store when ContainsAuth is
        // false. An empty-host/empty-helper entry makes that check true, while
        // native helper selection ignores empty hostnames and helper values.
        // No auth material, helper executable or ambient config is introduced.
        const config = registries.length ? { auths } : { auths, credHelpers: { '': '' } };
        writeFileSync(join(directory, 'config.json'), JSON.stringify(config), { flag: 'wx', mode: 0o600 });
        privateConfigs.set(directory, config);
        return { env: { DOCKER_CONFIG: directory }, redactionValues, dispose() { privateConfigs.delete(directory); dispose(); } };
    } catch (error) { dispose(); throw error; }
}

/** Live private registry configs created above, keyed by directory. */
const privateConfigs = new Map<string, Readonly<Record<string, unknown>>>();

function readHostFile(path: string): string | undefined {
    try { return readFileSync(path, 'utf8'); } catch { return undefined; }
}

/**
 * Docker resolves its endpoint from the config directory (currentContext plus
 * contexts/meta), so a private registry DOCKER_CONFIG would otherwise drop the
 * admitted launch's context and fall back to the default socket. Carry only
 * those non-secret selection facts from the launch's own config directory;
 * auths, helpers and contexts/tls never enter. Docker keeps deciding precedence
 * (--host/--context, DOCKER_HOST/DOCKER_CONTEXT, currentContext) itself.
 * Docker CLI v29 cli/config/configfile/file.go, cli/context/store/metadatastore.go.
 */
export function carryNativeDockerContextSelectionForHost(directory: string, launchEnv: Readonly<Record<string, string>>,
    platform: NodeJS.Platform = process.platform) {
    const config = privateConfigs.get(directory);
    if (!config) return; // Not a registry config this owner created.
    const home = launchEnv[platform === 'win32' ? 'USERPROFILE' : 'HOME'] || homedir();
    const source = resolve(launchEnv.DOCKER_CONFIG || join(home, '.docker'));
    if (source === resolve(directory)) return;
    // Docker itself warns and continues on an unreadable config file.
    let currentContext: unknown;
    try { currentContext = (JSON.parse(readHostFile(join(source, 'config.json')) ?? '{}') as { currentContext?: unknown }).currentContext; }
    catch { currentContext = undefined; }
    if (typeof currentContext === 'string' && currentContext) {
        writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...config, currentContext }), { mode: 0o600 });
    }
    const metaRoot = join(source, 'contexts', 'meta');
    let entries: string[];
    try { entries = readdirSync(metaRoot); } catch { return; }
    for (const entry of entries) {
        const meta = readHostFile(join(metaRoot, entry, 'meta.json'));
        if (meta === undefined) continue;
        const target = join(directory, 'contexts', 'meta', entry);
        mkdirSync(target, { recursive: true, mode: 0o700 });
        writeFileSync(join(target, 'meta.json'), meta, { mode: 0o600 });
    }
}
