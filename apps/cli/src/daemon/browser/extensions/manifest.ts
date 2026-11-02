import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserExtensionRecordV1 } from '@happier-dev/protocol';

import { extensionIdFromPublicKey } from './crx';

export class BrowserExtensionManifestError extends Error {
    constructor(readonly code: 'extension_manifest_unsupported' | 'extension_manifest_invalid', message: string) {
        super(message);
        this.name = 'BrowserExtensionManifestError';
    }
}

type ManifestMetadata = Pick<BrowserExtensionRecordV1,
    'id' | 'name' | 'version' | 'permissions' | 'hostPermissions' | 'actionPopup' | 'optionsPage'>;

function object(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
}

function requiredString(value: unknown, name: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Extension manifest requires ${name}`);
    return value;
}

function strings(value: unknown, name: string): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === 'string' && entry.length > 0)) {
        throw new Error(`Extension manifest has invalid ${name}`);
    }
    return value;
}

function contentScriptMatches(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error('Extension manifest has invalid content_scripts');
    return value.flatMap((entry: unknown) => {
        const script = object(entry);
        if (!script || script.matches === undefined) {
            throw new Error('Extension content scripts require matches');
        }
        return strings(script.matches, 'content_scripts.matches');
    });
}

/** Normalize manifest resource URLs once, before any installed record is published. */
function page(value: unknown): string | undefined {
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string' || /[\\\u0000-\u001f]/u.test(value)
        || /^[a-z][a-z\d+.-]*:/iu.test(value) || value.startsWith('//')) {
        throw new Error('Extension page must be a local extension resource');
    }
    const path = decodeURIComponent(value.split(/[?#]/u, 1)[0]);
    if (path.split('/').some((segment) => segment === '..') || /[\\\u0000-\u001f]/u.test(path)) {
        throw new Error('Extension page cannot traverse outside its package');
    }
    const url = new URL(value, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/');
    if (url.protocol !== 'chrome-extension:' || url.hostname !== 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        || url.username || url.password || url.port) {
        throw new Error('Extension page must be a local extension resource');
    }
    return url.pathname.replace(/^\/+/, '') + url.search + url.hash;
}

async function nameFromManifest(manifest: Record<string, unknown>, directory: string): Promise<string> {
    const name = requiredString(manifest.name, 'name');
    const token = /^__MSG_(.+)__$/u.exec(name)?.[1];
    if (!token) return name;
    const locale = requiredString(manifest.default_locale, 'default_locale');
    // Locale is one Chrome package path component, never an external file locator.
    if (!/^[a-z\d_@-]+$/iu.test(locale)) throw new Error('Extension locale is invalid');
    const messages = object(JSON.parse(await readFile(join(directory, '_locales', locale, 'messages.json'), 'utf8')));
    const entry = messages && Object.entries(messages).find(([key]) => key.toLowerCase() === token.toLowerCase())?.[1];
    return requiredString(object(entry)?.message, 'localized name');
}

async function readManifest(directory: string, verifiedDeveloperKey?: Buffer, existingDirectory?: string): Promise<ManifestMetadata> {
    const manifest = object(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
    if (!manifest) throw new Error('Extension manifest must be an object');
    if (manifest.manifest_version !== 3) {
        throw new BrowserExtensionManifestError('extension_manifest_unsupported', 'Only Chrome manifest version 3 is supported');
    }
    const name = await nameFromManifest(manifest, directory);
    const version = requiredString(manifest.version, 'version');
    const permissions = strings(manifest.permissions, 'permissions');
    // Chrome warns for both direct host access and static content-script injection.
    // Publish one effective grant list for install, update review and Store consumers.
    const hostPermissions = [...new Set([
        ...strings(manifest.host_permissions, 'host_permissions'),
        ...contentScriptMatches(manifest.content_scripts),
    ])];
    const action = object(manifest.action);
    const actionPopup = page(action?.default_popup);
    const optionsPage = page(object(manifest.options_ui)?.page ?? manifest.options_page);
    const existing = existingDirectory
        ? object(JSON.parse(await readFile(join(existingDirectory, 'manifest.json'), 'utf8')))
        : undefined;
    const retainedKey = existingDirectory
        ? Buffer.from(requiredString(existing?.key, 'installed key'), 'base64')
        : undefined;
    let key = verifiedDeveloperKey;
    if (!key) {
        if (manifest.key !== undefined) {
            key = Buffer.from(requiredString(manifest.key, 'key'), 'base64');
            createPublicKey({ key, format: 'der', type: 'spki' });
        } else if (retainedKey) {
            key = retainedKey;
        } else {
            key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' });
        }
    }
    if (retainedKey && extensionIdFromPublicKey(key) !== extensionIdFromPublicKey(retainedKey)) {
        throw new Error('Extension source key changes its installed identity');
    }
    const encodedKey = key.toString('base64');
    if (manifest.key !== encodedKey) {
        // Write only the Machine/profile-owned copy; the supplied unpacked folder is never edited.
        await chmod(join(directory, 'manifest.json'), 0o600);
        await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...manifest, key: encodedKey }, null, 2));
    }
    return {
        id: extensionIdFromPublicKey(key), name, version, permissions, hostPermissions,
        ...(actionPopup ? { actionPopup } : {}),
        ...(optionsPage ? { optionsPage } : {}),
    };
}

export async function readBrowserExtensionManifest(directory: string, verifiedDeveloperKey?: Buffer, existingDirectory?: string): Promise<ManifestMetadata> {
    try {
        return await readManifest(directory, verifiedDeveloperKey, existingDirectory);
    } catch (error) {
        if (error instanceof BrowserExtensionManifestError) throw error;
        throw new BrowserExtensionManifestError('extension_manifest_invalid',
            error instanceof Error ? error.message : 'Extension manifest is invalid');
    }
}
