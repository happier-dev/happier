import { cp, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BrowserExtensionRecordV1, BrowserExtensionSourceV1 } from '@happier-dev/protocol';
import { extractArchivePayloadToDirectory } from '@happier-dev/release-runtime/archiveExtraction';

import { resolveAbsolutePathFromWorkingDirectory } from '../../../utils/path/expandHomeDirPath';
import { verifyStoreCrx3 } from './crx';
import { BrowserExtensionManifestError, readBrowserExtensionManifest } from './manifest';

export type AcquiredBrowserExtension = Omit<BrowserExtensionRecordV1, 'enabled'>;
export type BrowserExtensionAcquisitionResult =
    | Readonly<{ ok: true; extension: AcquiredBrowserExtension }>
    | Readonly<{ ok: false; errorCode: 'extension_acquisition_failed' | 'extension_manifest_unsupported' | 'extension_manifest_invalid'; error: string }>;

export type BrowserExtensionAcquisitionParams = Readonly<{
    source: BrowserExtensionSourceV1;
    /** The profile owner supplies the storage root on this execution Machine. */
    storageDirectory: string;
    /** Actual managed engine version, used by Google's compatible-version selection. */
    chromeVersion: string;
    signal?: AbortSignal;
    /** Trusted profile-owned installed package, supplied only for an update. */
    existingDirectory?: string;
}>;

function storeDownloadUrl(extensionId: string, chromeVersion: string): URL {
    const url = new URL('https://clients2.google.com/service/update2/crx');
    url.searchParams.set('response', 'redirect');
    url.searchParams.set('acceptformat', 'crx3');
    url.searchParams.set('prodversion', chromeVersion);
    url.searchParams.set('x', new URLSearchParams({ id: extensionId, installsource: 'ondemand', uc: '' }).toString());
    return url;
}

export async function acquireBrowserExtension(params: BrowserExtensionAcquisitionParams): Promise<BrowserExtensionAcquisitionResult> {
    let staging: string | undefined;
    let archivePath: string | undefined;
    try {
        let source = params.source;
        params.signal?.throwIfAborted();
        await mkdir(params.storageDirectory, { recursive: true });
        staging = await mkdtemp(join(params.storageDirectory, 'package-'));
        const directory = staging;
        let publicKey: Buffer | undefined;
        if (params.source.kind === 'webStore') {
            const response = await fetch(storeDownloadUrl(params.source.extensionId, params.chromeVersion), {
                credentials: 'omit', signal: params.signal,
            });
            if (!response.ok) {
                await response.body?.cancel();
                throw new Error(`Chrome Web Store download failed (HTTP ${response.status})`);
            }
            const crx = verifyStoreCrx3(Buffer.from(await response.arrayBuffer()), params.source.extensionId);
            publicKey = crx.publicKey;
            params.signal?.throwIfAborted();
            archivePath = `${directory}.zip`;
            await writeFile(archivePath, crx.archive);
            await extractArchivePayloadToDirectory({
                archiveName: 'extension.zip', archivePath, extractDir: directory,
                zipLinkPolicy: 'reject', signal: params.signal,
            });
            await rm(archivePath);
            archivePath = undefined;
        } else {
            const expandedDirectory = resolveAbsolutePathFromWorkingDirectory(params.source.directory);
            if (!expandedDirectory) throw new Error('Unpacked extension source must be a directory');
            const originalDirectory = resolve(expandedDirectory);
            if (!(await lstat(originalDirectory)).isDirectory()) throw new Error('Unpacked extension source must be a directory');
            source = { kind: 'unpacked', directory: originalDirectory };
            await cp(originalDirectory, directory, {
                // mkdtemp already created this empty, profile-owned destination.
                recursive: true, dereference: false, force: false,
                filter: async (entry) => {
                    params.signal?.throwIfAborted();
                    const stat = await lstat(entry);
                    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
                        throw new Error('Unpacked extensions cannot contain links or special files');
                    }
                    return true;
                },
            });
        }
        params.signal?.throwIfAborted();
        const metadata = await readBrowserExtensionManifest(directory, publicKey, params.existingDirectory);
        return { ok: true, extension: { ...metadata, directory, source } };
    } catch (error) {
        let message = error instanceof Error ? error.message : 'Extension acquisition failed';
        for (const incomplete of [archivePath, staging]) {
            if (!incomplete) continue;
            try {
                await rm(incomplete, { recursive: true, force: true });
            } catch {
                message += `; incomplete package could not be removed: ${incomplete}`;
            }
        }
        return { ok: false, errorCode: error instanceof BrowserExtensionManifestError ? error.code : 'extension_acquisition_failed', error: message };
    }
}
