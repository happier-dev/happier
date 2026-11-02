import { randomBytes, randomInt, randomUUID } from 'node:crypto';

import type { DeploymentSecretBindingSourceV1 } from '@happier-dev/protocol';
import { SAVED_SECRET_RESOURCE_MAX_CONTENT_JSON_UTF8_BYTES_V1, SavedSecretResourceContentV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { DeploymentTemplateSecretProfileV1Schema, type DeploymentTemplateSecretProfileV1 } from '@happier-dev/protocol/registries';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { SharedSecretAudience } from '@happier-dev/plugin-sdk/secrets';

import type { StoredCredentials } from '@/persistence';
import { createSharedSavedSecretForOperation } from '@/settings/secrets/createSharedSavedSecretForOperation';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';

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

function generate(profile: DeploymentTemplateSecretProfileV1): string {
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
    }
}

export async function createDeploymentTemplateGeneratedSecretForHost(input: Readonly<{
    name: string;
    profile: DeploymentTemplateSecretProfileV1;
    audience: SharedSecretAudience;
    expectedScopeKey: string;
    signal: AbortSignal;
    readCredentials(): Promise<StoredCredentials | null>;
    operationContext?: SavedSecretOperationContextV1;
}>): Promise<Extract<DeploymentSecretBindingSourceV1, { kind: 'secret' }>> {
    input.signal.throwIfAborted();
    validateDeploymentTemplateGeneratedSecretProfileForHost(input);
    let value = generate(input.profile);
    try {
        const saved = await createSharedSavedSecretForOperation({ ...input, value,
            assertCurrent: () => input.signal.throwIfAborted() });
        return { kind: 'secret', ...saved };
    } finally {
        // Mutable entropy buffers are wiped above. JS strings cannot be erased;
        // drop our reference while existing P42 custody owns sealing/key cleanup.
        value = '';
    }
}
