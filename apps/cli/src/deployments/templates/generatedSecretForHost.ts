import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';

import type { DeploymentSecretBindingSourceV1 } from '@happier-dev/protocol';
import {
    SAVED_SECRET_RESOURCE_MAX_CONTENT_JSON_UTF8_BYTES_V1,
    SavedSecretResourceContentV1Schema,
} from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { DeploymentTemplateSecretProfileV1Schema, type DeploymentTemplateSecretProfileV1 } from '@happier-dev/protocol/registries';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { SharedSecretAudience } from '@happier-dev/plugin-sdk/secrets';

import type { StoredCredentials } from '@/persistence';
import { createSharedSavedSecretForOperation } from '@/settings/secrets/createSharedSavedSecretForOperation';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';

const jwtHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
function jwtSigningInput(profile: Extract<DeploymentTemplateSecretProfileV1, { kind: 'jwt-hs256' }>): string {
    return jwtHeader + '.' + Buffer.from(JSON.stringify(profile.payload)).toString('base64url');
}

function encodedLength(profile: DeploymentTemplateSecretProfileV1): number {
    switch (profile.kind) {
        case 'base64url-32-bytes': return 43;
        case 'hex-32-bytes': return 64;
        case 'uuid-v4': return 36;
        case 'lowercase-username': return 16;
        case 'alphanumeric-characters':
        case 'lowercase-alphanumeric-characters': return profile.characters;
        case 'hex-bytes': return profile.bytes * 2;
        case 'base64-bytes': return 4 * Math.ceil(profile.bytes / 3);
        case 'hex-characters': return profile.parts.reduce((length, part) => length + (typeof part === 'string' ? part.length : part), 0);
        case 'jwt-hs256': return jwtSigningInput(profile).length + 1 + 43;
    }
}

/** Pure preview admission; no entropy or Saved Secret effects. */
export function validateDeploymentTemplateGeneratedSecretProfileForHost(input: Readonly<{
    name: string; profile: DeploymentTemplateSecretProfileV1;
}>): void {
    const parsed = DeploymentTemplateSecretProfileV1Schema.safeParse(input.profile);
    if (!parsed.success) throw new PluginError({ code: 'invalid_parameters', message: 'Invalid template secret profile' });
    const length = encodedLength(parsed.data);
    // Every profile emits ASCII without JSON escapes. Reuse the actual storage
    // envelope quota before allocating, including the supplied label's JSON cost.
    const content = { v: 1 as const, name: input.name, kind: 'other' as const, value: '' };
    const metadataBytes = Buffer.byteLength(JSON.stringify(content), 'utf8');
    if (length > SAVED_SECRET_RESOURCE_MAX_CONTENT_JSON_UTF8_BYTES_V1 - metadataBytes) {
        throw new PluginError({ code: 'invalid_parameters', message: 'Template secret exceeds Saved Secret storage limits' });
    }
    // The schema also owns field limits (including the narrower string budget).
    // This placeholder is bounded above by the canonical envelope quota.
    if (!SavedSecretResourceContentV1Schema.safeParse({ ...content, value: 'x'.repeat(length) }).success) {
        throw new PluginError({ code: 'invalid_parameters', message: 'Template secret exceeds Saved Secret storage limits' });
    }
}

function encodedRandomBytes(bytes: number, encoding: 'hex' | 'base64' | 'base64url'): string {
    const entropy = randomBytes(bytes);
    try { return entropy.toString(encoding); }
    finally { entropy.fill(0); }
}

function randomCharacters(characters: number, alphabet: string): string {
    const entropy = Buffer.alloc(characters);
    try {
        for (let index = 0; index < characters; index += 1) entropy[index] = alphabet.charCodeAt(randomInt(alphabet.length));
        return entropy.toString('ascii');
    } finally { entropy.fill(0); }
}

function generate(profile: DeploymentTemplateSecretProfileV1, resolveGeneratedSecret?: (key: string) => string | undefined): string {
    switch (profile.kind) {
        case 'base64url-32-bytes': return encodedRandomBytes(32, 'base64url');
        case 'hex-32-bytes': return encodedRandomBytes(32, 'hex');
        case 'uuid-v4': return randomUUID();
        // Host profile policy, not a claim about Faker's username size/punctuation.
        case 'lowercase-username': return randomCharacters(16, 'abcdefghijklmnopqrstuvwxyz0123456789');
        case 'alphanumeric-characters': return randomCharacters(profile.characters, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
        case 'lowercase-alphanumeric-characters': return randomCharacters(profile.characters, 'abcdefghijklmnopqrstuvwxyz0123456789');
        case 'hex-bytes': return encodedRandomBytes(profile.bytes, 'hex');
        case 'base64-bytes': return encodedRandomBytes(profile.bytes, 'base64');
        case 'hex-characters': return profile.parts.map(part => typeof part === 'string' ? part
            : encodedRandomBytes(Math.ceil(part / 2), 'hex').slice(0, part)).join('');
        case 'jwt-hs256': {
            const secret = resolveGeneratedSecret?.(profile.secretKey);
            if (secret === undefined) throw new PluginError({ code: 'invalid_parameters', message: 'JWT signing dependency unavailable' });
            const signingInput = jwtSigningInput(profile);
            return signingInput + '.' + createHmac('sha256', secret).update(signingInput).digest('base64url');
        }
    }
}

type GeneratedSecretInput = Readonly<{
    name: string;
    profile: DeploymentTemplateSecretProfileV1;
    audience: SharedSecretAudience;
    expectedScopeKey: string;
    signal: AbortSignal;
    readCredentials(): Promise<StoredCredentials | null>;
    operationContext?: SavedSecretOperationContextV1;
}>;

async function createGeneratedSecret(input: GeneratedSecretInput, resolveGeneratedSecret?: (key: string) => string | undefined, retain?: (value: string) => void): Promise<Extract<DeploymentSecretBindingSourceV1, { kind: 'secret' }>> {
    input.signal.throwIfAborted();
    validateDeploymentTemplateGeneratedSecretProfileForHost(input);
    let value = generate(input.profile, resolveGeneratedSecret);
    try {
        const saved = await createSharedSavedSecretForOperation({ ...input, value,
            assertCurrent: () => input.signal.throwIfAborted() });
        retain?.(value);
        return { kind: 'secret', ...saved };
    } finally {
        // Mutable entropy buffers are wiped above. JS strings cannot be erased;
        // drop our reference while existing P42 custody owns sealing/key cleanup.
        value = '';
    }
}

/** One admitted installation owns these transient values; only Saved Secret refs escape. */
export async function withDeploymentTemplateGeneratedSecretsForHost<T>(run: (create: (input: GeneratedSecretInput & { key: string; phase: 'build' | 'runtime' }) =>
    ReturnType<typeof createGeneratedSecret>) => Promise<T>): Promise<T> {
    const values = new Map<string, string>();
    try {
        return await run(input => createGeneratedSecret(input, key => values.get(`${input.phase}:${key}`),
            value => { values.set(`${input.phase}:${input.key}`, value); }));
    } finally { values.clear(); }
}

export async function createDeploymentTemplateGeneratedSecretForHost(input: GeneratedSecretInput): Promise<Extract<DeploymentSecretBindingSourceV1, { kind: 'secret' }>> {
    return createGeneratedSecret(input);
}
