import { createPublicKey } from 'node:crypto';
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserExtensionRecordV1Schema } from '@happier-dev/protocol';

import { acquireBrowserExtension } from './acquisition';
import { verifyStoreCrx3 } from './crx';

const extensionId = 'eimadpbcbfnmbkopoojfekhnkhdbieeh';
// Captured 2026-11-02 from clients2.google.com/service/update2/crx with
// id=eimadpbcbfnmbkopoojfekhnkhdbieeh, acceptformat=crx3, prodversion=150.0.0.0.
// SHA256 864a7301c6841b34066c3537c12eab1c17a2f4cc8f27c5f05ece2b11b2615586.
// Raw production signatures are retained; the test never substitutes a publisher key.
const fixture = new URL('./fixtures/darkreader.crx', import.meta.url);
// Same licensed package with its final signed ZIP byte flipped.
const tamperedFixture = new URL('./fixtures/darkreader-tampered.crx', import.meta.url);
const temporary: string[] = [];
async function root() {
    const directory = await mkdtemp(join(tmpdir(), 'happier-extension-'));
    temporary.push(directory);
    return directory;
}
afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('browser extension acquisition', () => {
    it('verifies an actual Web Store developer and production publisher proof', async () => {
        const verified = verifyStoreCrx3(await readFile(fixture), extensionId);
        expect(verified.extensionId).toBe(extensionId);
        expect(createPublicKey({ key: verified.publicKey, type: 'spki', format: 'der' }).type).toBe('public');
        expect(verified.archive.subarray(0, 2).toString()).toBe('PK');
    });

    it('refuses another requested identity and tampered signed ZIP bytes', async () => {
        const bytes = await readFile(fixture);
        expect(() => verifyStoreCrx3(bytes, 'a'.repeat(32))).toThrow();
        const tampered = await readFile(tamperedFixture);
        expect(() => verifyStoreCrx3(tampered, extensionId)).toThrow();
    });

    it('refuses truncated, unsupported and malformed CRX envelopes', async () => {
        const bytes = await readFile(fixture);
        const unsupported = Buffer.from(bytes);
        unsupported.writeUInt32LE(2, 4);
        const oversizedHeader = Buffer.from(bytes);
        oversizedHeader.writeUInt32LE(bytes.length, 8);
        const malformedHeader = Buffer.from(bytes);
        // A protobuf tag cannot use wire type 7; the signed payload remains exact.
        malformedHeader[12] = 0x17;
        for (const invalid of [Buffer.alloc(0), bytes.subarray(0, 11), unsupported, oversizedHeader, malformedHeader]) {
            expect(() => verifyStoreCrx3(invalid, extensionId)).toThrow();
        }
    });

    it('refuses missing developer or publisher proof and corrupted proof signatures', async () => {
        const bytes = await readFile(fixture);
        // This real fixture has an ECDSA publisher proof. Remove it from the unsigned
        // outer header without changing the signed developer message or ZIP.
        const size = bytes.readUInt32LE(8);
        const header = bytes.subarray(12, 12 + size);
        const publisherStart = header.indexOf(Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'));
        expect(publisherStart).toBeGreaterThan(0);
        const tampered = Buffer.from(bytes);
        // Corrupt only the publisher signature; both the developer proof and pinned
        // publisher SPKI hash remain valid, catching a verifier that merely hashes keys.
        const signatureField = publisherStart + 2 + header[publisherStart + 1];
        expect(header[signatureField]).toBe(0x12);
        tampered[12 + signatureField + 2] ^= 1;
        expect(() => verifyStoreCrx3(tampered, extensionId)).toThrow();
        // Strip field 3 using the protobuf wire envelope, leaving all other bytes exact.
        let offset = 0;
        const kept: Buffer[] = [];
        const withoutDeveloper: Buffer[] = [];
        const varint = () => {
            let value = 0;
            let factor = 1;
            for (;;) {
                const byte = header[offset++];
                value += (byte & 127) * factor;
                if (!(byte & 128)) return value;
                factor *= 128;
            }
        };
        while (offset < header.length) {
            const start = offset;
            const key = varint();
            expect(key % 8).toBe(2);
            const length = varint();
            offset += length;
            if (Math.floor(key / 8) === 2) {
                // The captured RSA proof ends with its signature. Only that
                // unsigned outer proof changes; publisher and signed payload stay exact.
                const brokenDeveloperProof = Buffer.from(bytes);
                brokenDeveloperProof[12 + offset - 1] ^= 1;
                expect(() => verifyStoreCrx3(brokenDeveloperProof, extensionId)).toThrow();
            }
            if (Math.floor(key / 8) !== 3) kept.push(header.subarray(start, offset));
            if (Math.floor(key / 8) !== 2) withoutDeveloper.push(header.subarray(start, offset));
        }
        for (const fields of [kept, withoutDeveloper]) {
            const strippedHeader = Buffer.concat(fields);
            const prefix = Buffer.from(bytes.subarray(0, 12));
            prefix.writeUInt32LE(strippedHeader.length, 8);
            expect(() => verifyStoreCrx3(Buffer.concat([prefix, strippedHeader, bytes.subarray(12 + size)]), extensionId)).toThrow();
        }
    });

    it('downloads verified Store content and retains the developer key in its owned manifest', async () => {
        const bytes = await readFile(fixture);
        const fetcher = vi.fn(async () => new Response(Uint8Array.from(bytes)));
        vi.stubGlobal('fetch', fetcher);
        const result = await acquireBrowserExtension({ source: { kind: 'webStore', extensionId }, storageDirectory: await root(), chromeVersion: '127.0.6533.88' });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.extension.id).toBe(extensionId);
        const manifest = JSON.parse(await readFile(join(result.extension.directory, 'manifest.json'), 'utf8'));
        expect(manifest.key).toBe(verifyStoreCrx3(bytes, extensionId).publicKey.toString('base64'));
        expect(result.extension.name).toBeTruthy();
        expect(BrowserExtensionRecordV1Schema.safeParse({ ...result.extension, enabled: true }).success).toBe(true);
        expect(fetcher.mock.calls).toHaveLength(1);
    });

    it.each(['http', 'identity', 'signature'] as const)(
        'cleans the owned package and publishes no record after a Store %s failure', async (failure) => {
            const bytes = await readFile(failure === 'signature' ? tamperedFixture : fixture);
            vi.stubGlobal('fetch', vi.fn(async () => failure === 'http'
                ? new Response(null, { status: 503 })
                : new Response(Uint8Array.from(bytes))));
            const directory = await root();
            const result = await acquireBrowserExtension({
                source: { kind: 'webStore', extensionId: failure === 'identity' ? 'a'.repeat(32) : extensionId },
                storageDirectory: directory, chromeVersion: '127.0.6533.88',
            });
            expect(result).toMatchObject({ ok: false, errorCode: 'extension_acquisition_failed' });
            expect(await readdir(directory)).toEqual([]);
        },
    );

    it('settles an aborted acquisition without downloading or creating package state', async () => {
        const controller = new AbortController();
        controller.abort();
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        const directory = await root();
        const result = await acquireBrowserExtension({ source: { kind: 'webStore', extensionId },
            storageDirectory: directory, chromeVersion: '127.0.6533.88', signal: controller.signal });
        expect(result).toMatchObject({ ok: false, errorCode: 'extension_acquisition_failed' });
        expect(await readdir(directory)).toEqual([]);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('copies unpacked content, retains identity on reimport, and leaves the source untouched', async () => {
        const directory = await root();
        const source = join(directory, 'source');
        await mkdir(source);
        const original = { manifest_version: 3, name: 'Local', version: '1.0', permissions: ['storage'], host_permissions: ['https://example.com/*'], action: { default_popup: 'popup.html' }, options_ui: { page: 'options.html' } };
        await writeFile(join(source, 'manifest.json'), JSON.stringify(original));
        await writeFile(join(source, 'popup.html'), 'popup');
        const result = await acquireBrowserExtension({ source: { kind: 'unpacked', directory: source }, storageDirectory: join(directory, 'owned'), chromeVersion: '127.0.6533.88' });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.extension).toMatchObject({ name: 'Local', permissions: ['storage'], hostPermissions: ['https://example.com/*'], actionPopup: 'popup.html', optionsPage: 'options.html' });
        expect(result.extension.id).toMatch(/^[a-p]{32}$/);
        expect(BrowserExtensionRecordV1Schema.safeParse({ ...result.extension, enabled: true }).success).toBe(true);
        expect(JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))).toEqual(original);
        const again = await acquireBrowserExtension({ source: { kind: 'unpacked', directory: source }, existingDirectory: result.extension.directory, storageDirectory: join(directory, 'owned'), chromeVersion: '127.0.6533.88' });
        expect(again.ok && again.extension.id).toBe(result.extension.id);
        expect((await lstat(join(result.extension.directory, 'popup.html'))).isFile()).toBe(true);
        await rm(result.extension.directory, { recursive: true });
        if (again.ok) await rm(again.extension.directory, { recursive: true });
        expect(await readdir(join(directory, 'owned'))).toEqual([]);
    });

    it('retains the absolute original source for a relative unpacked import', async () => {
        const directory = await root();
        const source = join(directory, 'source');
        await mkdir(source);
        await writeFile(join(source, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Local', version: '1.0' }));
        const result = await acquireBrowserExtension({ source: { kind: 'unpacked', directory: relative(process.cwd(), source) }, storageDirectory: join(directory, 'owned'), chromeVersion: '127.0.6533.88' });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.extension.source).toEqual({ kind: 'unpacked', directory: source });
    });

    it('can preserve an identity in an owned copy of a read-only unpacked manifest', async () => {
        const directory = await root();
        const source = join(directory, 'source');
        await mkdir(source);
        const manifestPath = join(source, 'manifest.json');
        await writeFile(manifestPath, JSON.stringify({ manifest_version: 3, name: 'Read only', version: '1.0' }));
        await chmod(manifestPath, 0o444);
        const result = await acquireBrowserExtension({ source: { kind: 'unpacked', directory: source }, storageDirectory: join(directory, 'owned'), chromeVersion: '127.0.6533.88' });
        expect(result.ok).toBe(true);
        expect(JSON.parse(await readFile(manifestPath, 'utf8'))).not.toHaveProperty('key');
    });

    it('refuses a replacement unpacked key that changes an installed identity', async () => {
        const directory = await root();
        const source = join(directory, 'source');
        await mkdir(source);
        const manifest = { manifest_version: 3, name: 'Local', version: '1.0' };
        await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
        const first = await acquireBrowserExtension({ source: { kind: 'unpacked', directory: source }, storageDirectory: join(directory, 'owned'), chromeVersion: '127.0.6533.88' });
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        const key = verifyStoreCrx3(await readFile(fixture), extensionId).publicKey.toString('base64');
        await writeFile(join(source, 'manifest.json'), JSON.stringify({ ...manifest, key }));
        const changed = await acquireBrowserExtension({ source: { kind: 'unpacked', directory: source }, existingDirectory: first.extension.directory, storageDirectory: join(directory, 'owned'), chromeVersion: '127.0.6533.88' });
        expect(changed).toMatchObject({ ok: false, errorCode: 'extension_manifest_invalid' });
    });

    it('refuses symlinks in unpacked sources and cleans failed acquisitions', async () => {
        if (process.platform === 'win32') return; // Symlink creation requires a privileged Windows runner.
        const directory = await root();
        const source = join(directory, 'source');
        await mkdir(source);
        await writeFile(join(source, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Local', version: '1.0' }));
        await symlink('../outside', join(source, 'escape'));
        const result = await acquireBrowserExtension({ source: { kind: 'unpacked', directory: source }, storageDirectory: join(directory, 'owned'), chromeVersion: '127.0.6533.88' });
        expect(result.ok).toBe(false);
        expect(await readdir(join(directory, 'owned'))).toEqual([]);
    });

    it.each(['../outside.html', 'https://example.com/popup', '//example.com/popup', 'C:\\outside.html', '%2e%2e/outside.html', 'folder%2f..%2f..%2foutside.html'])(
        'refuses an unsafe manifest extension page %s', async (page) => {
            const directory = await root();
            const source = join(directory, 'source');
            await mkdir(source);
            await writeFile(join(source, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Local', version: '1.0', action: { default_popup: page } }));
            const result = await acquireBrowserExtension({ source: { kind: 'unpacked', directory: source }, storageDirectory: join(directory, 'owned'), chromeVersion: '127.0.6533.88' });
            expect(result).toMatchObject({ ok: false, errorCode: 'extension_manifest_invalid' });
        },
    );

    it('projects localized name, manifest grants and canonical page paths from the copied manifest', async () => {
        const directory = await root();
        const source = join(directory, 'source');
        await mkdir(join(source, '_locales', 'en'), { recursive: true });
        await writeFile(join(source, '_locales', 'en', 'messages.json'), JSON.stringify({ title: { message: 'Localized' } }));
        const key = verifyStoreCrx3(await readFile(fixture), extensionId).publicKey.toString('base64');
        await writeFile(join(source, 'manifest.json'), JSON.stringify({ manifest_version: 3, key, name: '__MSG_title__', default_locale: 'en', version: '1.0', permissions: ['storage'], host_permissions: ['https://example.com/*', '<all_urls>'], content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }, { matches: ['https://injected.example/*', 'https://example.com/*'], css: ['style.css'] }], action: { default_popup: './popup.html?open=1' }, options_page: '/options.html' }));
        const result = await acquireBrowserExtension({ source: { kind: 'unpacked', directory: source }, storageDirectory: join(directory, 'owned'), chromeVersion: '127.0.6533.88' });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.extension).toMatchObject({ id: extensionId, name: 'Localized', permissions: ['storage'], hostPermissions: ['https://example.com/*', '<all_urls>', 'https://injected.example/*'], actionPopup: 'popup.html?open=1', optionsPage: 'options.html' });
    });

    it.each([
        { contentScripts: {} },
        { contentScripts: [null] },
        { contentScripts: [{}] },
        { contentScripts: [{ matches: 'https://example.com/*' }] },
        { contentScripts: [{ matches: [7] }] },
    ])(
        'refuses malformed content script access declarations $contentScripts', async ({ contentScripts }) => {
            const directory = await root();
            const source = join(directory, 'source');
            await mkdir(source);
            await writeFile(join(source, 'manifest.json'), JSON.stringify({ manifest_version: 3,
                name: 'Invalid content script', version: '1.0', content_scripts: contentScripts }));
            const result = await acquireBrowserExtension({ source: { kind: 'unpacked', directory: source },
                storageDirectory: join(directory, 'owned'), chromeVersion: '127.0.6533.88' });
            expect(result).toMatchObject({ ok: false, errorCode: 'extension_manifest_invalid' });
            expect(await readdir(join(directory, 'owned'))).toEqual([]);
        },
    );

    it('refuses unsupported manifest versions before publishing an installed record', async () => {
        const directory = await root();
        const source = join(directory, 'source');
        await mkdir(source);
        await writeFile(join(source, 'manifest.json'), JSON.stringify({ manifest_version: 2, name: 'Legacy', version: '1.0' }));
        const result = await acquireBrowserExtension({ source: { kind: 'unpacked', directory: source }, storageDirectory: join(directory, 'owned'), chromeVersion: '127.0.6533.88' });
        expect(result).toMatchObject({ ok: false, errorCode: 'extension_manifest_unsupported' });
    });
});
