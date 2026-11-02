import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
        return { env: { DOCKER_CONFIG: directory }, redactionValues, dispose };
    } catch (error) { dispose(); throw error; }
}
