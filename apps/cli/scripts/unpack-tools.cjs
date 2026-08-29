#!/usr/bin/env node

/**
 * Unpacks platform-specific binaries from compressed archives.
 * This script extracts the necessary tools for the current platform.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const tar = require('tar');
const os = require('os');
const crypto = require('crypto');

const TOOL_ARCHIVE_MANIFEST = [
    { tool: 'difftastic', platformDir: 'arm64-darwin', archiveName: 'difftastic-arm64-darwin.tar.gz', archiveType: 'tar.gz', binaryName: 'difft', version: '0', licenseName: 'difftastic-LICENSE' },
    { tool: 'difftastic', platformDir: 'x64-darwin', archiveName: 'difftastic-x64-darwin.tar.gz', archiveType: 'tar.gz', binaryName: 'difft', version: '0', licenseName: 'difftastic-LICENSE' },
    { tool: 'difftastic', platformDir: 'arm64-linux', archiveName: 'difftastic-arm64-linux.tar.gz', archiveType: 'tar.gz', binaryName: 'difft', version: '0', licenseName: 'difftastic-LICENSE' },
    { tool: 'difftastic', platformDir: 'x64-linux', archiveName: 'difftastic-x64-linux.tar.gz', archiveType: 'tar.gz', binaryName: 'difft', version: '0', licenseName: 'difftastic-LICENSE' },
    { tool: 'difftastic', platformDir: 'x64-win32', archiveName: 'difftastic-x64-win32.tar.gz', archiveType: 'tar.gz', binaryName: 'difft.exe', version: '0', licenseName: 'difftastic-LICENSE' },
    { tool: 'ripgrep', platformDir: 'arm64-darwin', archiveName: 'ripgrep-arm64-darwin.tar.gz', archiveType: 'tar.gz', binaryName: 'rg', version: '0', licenseName: 'ripgrep-LICENSE', extraBinaries: ['ripgrep.node'] },
    { tool: 'ripgrep', platformDir: 'x64-darwin', archiveName: 'ripgrep-x64-darwin.tar.gz', archiveType: 'tar.gz', binaryName: 'rg', version: '0', licenseName: 'ripgrep-LICENSE', extraBinaries: ['ripgrep.node'] },
    { tool: 'ripgrep', platformDir: 'arm64-linux', archiveName: 'ripgrep-arm64-linux.tar.gz', archiveType: 'tar.gz', binaryName: 'rg', version: '0', licenseName: 'ripgrep-LICENSE', extraBinaries: ['ripgrep.node'] },
    { tool: 'ripgrep', platformDir: 'x64-linux', archiveName: 'ripgrep-x64-linux.tar.gz', archiveType: 'tar.gz', binaryName: 'rg', version: '0', licenseName: 'ripgrep-LICENSE', extraBinaries: ['ripgrep.node'] },
    { tool: 'ripgrep', platformDir: 'x64-win32', archiveName: 'ripgrep-x64-win32.tar.gz', archiveType: 'tar.gz', binaryName: 'rg.exe', version: '0', licenseName: 'ripgrep-LICENSE', extraBinaries: ['ripgrep.node'] },
    { tool: 'zellij', platformDir: 'arm64-darwin', archiveName: 'zellij-no-web-aarch64-apple-darwin.tar.gz', archiveType: 'tar.gz', binaryName: 'zellij', version: '0.44.3', licenseName: 'zellij-LICENSE' },
    { tool: 'zellij', platformDir: 'x64-darwin', archiveName: 'zellij-no-web-x86_64-apple-darwin.tar.gz', archiveType: 'tar.gz', binaryName: 'zellij', version: '0.44.3', licenseName: 'zellij-LICENSE' },
    { tool: 'zellij', platformDir: 'arm64-linux', archiveName: 'zellij-no-web-aarch64-unknown-linux-musl.tar.gz', archiveType: 'tar.gz', binaryName: 'zellij', version: '0.44.3', licenseName: 'zellij-LICENSE' },
    { tool: 'zellij', platformDir: 'x64-linux', archiveName: 'zellij-no-web-x86_64-unknown-linux-musl.tar.gz', archiveType: 'tar.gz', binaryName: 'zellij', version: '0.44.3', licenseName: 'zellij-LICENSE' },
    { tool: 'zellij', platformDir: 'x64-win32', archiveName: 'zellij-no-web-x86_64-pc-windows-msvc.zip', archiveType: 'zip', binaryName: 'zellij.exe', version: '0.44.3', licenseName: 'zellij-LICENSE' },
];

const VERSION_MARKER_NAME = '.happier-tools-manifest.json';
const TOOL_CHECKSUM_MANIFEST_NAME = 'checksums.sha256';
const RUNTIME_ASSET_CHECKSUM_MANIFEST_NAME = 'checksums.runtime-assets.sha256';
const ARCHIVE_CHECKSUM_MANIFEST_NAMES = Object.freeze([
    TOOL_CHECKSUM_MANIFEST_NAME,
    RUNTIME_ASSET_CHECKSUM_MANIFEST_NAME,
]);

const CLI_RUNTIME_ASSET_MANAGED_PROVIDER_REFS = Object.freeze({
    'cliproxyapi-managed': Object.freeze({
        pluginId: 'happier.provider.cliproxyapi',
        providerId: 'cliproxyapi',
    }),
});

/**
 * Platform leaves of the CLIProxyAPI managed wrapper. The wrapper is a runtime
 * asset of the CLI distribution, not a third-party developer tool: the plugin
 * declares its launch path as `tools/unpacked/<binary>` and the canonical CLI
 * runtime-asset build manifest records its integrity.
 *
 * These archives are produced by the one Go build owner and staged into
 * `tools/archives` by the publication pipeline, so a source checkout has none.
 * A leaf is staged when its archive or its `checksums.sha256` entry is present.
 * Either one alone is an incoherent publication, so staging is decided from the
 * pair and then verified: a listed-but-absent archive and an
 * unlisted-but-present archive both fail closed rather than being skipped.
 */
const CLI_RUNTIME_ASSET_ARCHIVE_MANIFEST = [
    { asset: 'cliproxyapi-managed', platformDir: 'arm64-darwin', archiveName: 'happier-cliproxyapi-managed-arm64-darwin.tar.gz', archiveType: 'tar.gz', binaryName: 'happier-cliproxyapi-managed', extraBinaries: ['happier-process-custody'], version: '1' },
    { asset: 'cliproxyapi-managed', platformDir: 'x64-darwin', archiveName: 'happier-cliproxyapi-managed-x64-darwin.tar.gz', archiveType: 'tar.gz', binaryName: 'happier-cliproxyapi-managed', extraBinaries: ['happier-process-custody'], version: '1' },
    { asset: 'cliproxyapi-managed', platformDir: 'arm64-linux', archiveName: 'happier-cliproxyapi-managed-arm64-linux.tar.gz', archiveType: 'tar.gz', binaryName: 'happier-cliproxyapi-managed', extraBinaries: ['happier-process-custody'], version: '1' },
    { asset: 'cliproxyapi-managed', platformDir: 'x64-linux', archiveName: 'happier-cliproxyapi-managed-x64-linux.tar.gz', archiveType: 'tar.gz', binaryName: 'happier-cliproxyapi-managed', extraBinaries: ['happier-process-custody'], version: '1' },
    { asset: 'cliproxyapi-managed', platformDir: 'x64-win32', archiveName: 'happier-cliproxyapi-managed-x64-win32.tar.gz', archiveType: 'tar.gz', binaryName: 'happier-cliproxyapi-managed.exe', extraBinaries: ['happier-process-custody.exe'], version: '1' },
].map((entry) => Object.freeze({
    ...entry,
    managedProviderRef: CLI_RUNTIME_ASSET_MANAGED_PROVIDER_REFS[entry.asset],
    licenseNames: Object.freeze(['CLIProxyAPI-LICENSE', 'CLIProxyAPI-THIRD-PARTY-NOTICES']),
    runtimeAssetRelativePath: `tools/unpacked/${entry.binaryName}`,
}));


/**
 * Get the platform-specific directory name.
 */
function getPlatformDir() {
    const platform = os.platform();
    const arch = os.arch();

    if (platform === 'darwin') {
        if (arch === 'arm64') return 'arm64-darwin';
        if (arch === 'x64') return 'x64-darwin';
    } else if (platform === 'linux') {
        if (arch === 'arm64') return 'arm64-linux';
        if (arch === 'x64') return 'x64-linux';
    } else if (platform === 'win32') {
        if (arch === 'x64') return 'x64-win32';
    }

    throw new Error(`Unsupported platform: ${arch}-${platform}`);
}

/**
 * Get the root tools directory.
 */
function getToolsDir() {
    const scriptDir = __dirname;
    return path.resolve(scriptDir, '..', 'tools');
}

function getToolArchiveManifest() {
    return TOOL_ARCHIVE_MANIFEST.map((entry) => ({ ...entry }));
}

function getManifestForPlatform(platformDir) {
    return TOOL_ARCHIVE_MANIFEST.filter((entry) => entry.platformDir === platformDir);
}

function getCliRuntimeAssetArchiveManifest() {
    return CLI_RUNTIME_ASSET_ARCHIVE_MANIFEST.map((entry) => ({ ...entry }));
}

/**
 * The archive inventory has two producers and one reader. `checksums.sha256`
 * records the committed third-party developer tools; `checksums.runtime-assets.sha256`
 * records first-party runtime assets the publication pipeline builds, so those
 * generated bytes never have to be committed or leave the release worktree
 * dirty. Duplicate names across the two files are an incoherent publication.
 */
function readArchiveChecksums(archivesDir) {
    const merged = new Map();
    for (const manifestName of ARCHIVE_CHECKSUM_MANIFEST_NAMES) {
        const manifestPath = path.join(archivesDir, manifestName);
        if (!fs.existsSync(manifestPath)) continue;
        for (const [archiveName, checksum] of readChecksumManifest(manifestPath)) {
            if (merged.has(archiveName)) {
                throw new Error(`Duplicate checksum entry across archive inventories: ${archiveName}`);
            }
            merged.set(archiveName, checksum);
        }
    }
    return merged;
}

/**
 * Runtime-asset leaves this distribution actually shipped for `platformDir`.
 * Staging is decided by the canonical archive inventory, never by guessing at
 * file presence, so a staged-but-corrupt archive still fails closed downstream.
 */
function getStagedRuntimeAssetsForPlatform(archivesDir, platformDir, checksums) {
    const inventory = checksums ?? readArchiveChecksums(archivesDir);
    return CLI_RUNTIME_ASSET_ARCHIVE_MANIFEST.filter((entry) => (
        entry.platformDir === platformDir
        && (inventory.has(entry.archiveName) || fs.existsSync(path.join(archivesDir, entry.archiveName)))
    ));
}

function manifestEntryKey(entry) {
    return entry.tool ?? entry.asset;
}

function readVersionMarker(unpackedPath) {
    const markerPath = path.join(unpackedPath, VERSION_MARKER_NAME);
    if (!fs.existsSync(markerPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    } catch {
        return null;
    }
}

function expectedFilesForEntry(entry) {
    return [
        entry.binaryName,
        ...(entry.extraBinaries || []),
        ...(entry.licenseName ? [entry.licenseName] : []),
        ...(entry.licenseNames || []),
    ];
}

/**
 * Check if tools are already unpacked for the requested platform.
 */
function areToolsUnpacked(toolsDir, platformDir = getPlatformDir()) {
    const unpackedPath = path.join(toolsDir, 'unpacked');

    if (!fs.existsSync(unpackedPath)) {
        return false;
    }

    const entries = [
        ...getManifestForPlatform(platformDir),
        ...getStagedRuntimeAssetsForPlatform(path.join(toolsDir, 'archives'), platformDir),
    ];
    const expectedFiles = entries.flatMap(expectedFilesForEntry);
    const filesExist = expectedFiles.every((file) => fs.existsSync(path.join(unpackedPath, file)));
    if (!filesExist) return false;

    const marker = readVersionMarker(unpackedPath);
    if (!marker || marker.platformDir !== platformDir) return false;
    return entries.every((entry) => marker.tools?.[manifestEntryKey(entry)]?.version === entry.version);
}

/**
 * Read the archive checksum manifest.
 */
function parseChecksumManifestContents(contents) {
    const entries = new Map();

    contents.split(/\r?\n/).forEach((line, index) => {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith('#')) {
            return;
        }

        const match = trimmed.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);

        if (!match) {
            throw new Error(`Invalid checksum manifest line ${index + 1}: ${line}`);
        }

        const archiveName = path.basename(match[2].trim());

        if (entries.has(archiveName)) {
            throw new Error(`Duplicate checksum entry: ${archiveName}`);
        }

        entries.set(archiveName, match[1].toLowerCase());
    });

    return entries;
}

function readChecksumManifest(manifestPath) {
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`Checksum manifest not found: ${manifestPath}`);
    }

    return parseChecksumManifestContents(fs.readFileSync(manifestPath, 'utf8'));
}

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

function verifyArchiveChecksumValue(archivePath, expectedChecksum) {
    if (!expectedChecksum) {
        throw new Error(`Missing checksum for archive: ${path.basename(archivePath)}`);
    }

    const actualChecksum = sha256File(archivePath);
    if (actualChecksum !== expectedChecksum) {
        throw new Error(`Archive checksum mismatch for ${path.basename(archivePath)}: expected ${expectedChecksum}, got ${actualChecksum}`);
    }
}

/**
 * Verify a compressed archive against the checksum manifest.
 */
function verifyArchiveChecksum(archivePath, manifestPath) {
    const archiveName = path.basename(archivePath);
    const checksums = manifestPath
        ? readChecksumManifest(manifestPath)
        : readArchiveChecksums(path.dirname(archivePath));
    verifyArchiveChecksumValue(archivePath, checksums.get(archiveName));
}

/**
 * Unpack a tar.gz archive to a destination directory.
 */
async function unpackArchive(archivePath, destDir) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }

        fs.createReadStream(archivePath)
            .pipe(zlib.createGunzip())
            .pipe(tar.extract({
                cwd: destDir,
                preserveMode: true,
                preserveOwner: false,
            }))
            .on('finish', () => {
                if (os.platform() !== 'win32') {
                    const files = fs.readdirSync(destDir);
                    files.forEach((file) => {
                        const filePath = path.join(destDir, file);
                        const stats = fs.statSync(filePath);
                        if (stats.isFile() && !file.endsWith('.node')) {
                            fs.chmodSync(filePath, 0o755);
                        }
                    });
                }
                resolve();
            })
            .on('error', reject);
    });
}

function findEndOfCentralDirectory(buffer) {
    for (let index = buffer.length - 22; index >= 0; index -= 1) {
        if (buffer.readUInt32LE(index) === 0x06054b50) return index;
    }
    return -1;
}

function unpackZipArchive(archivePath, destDir) {
    if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
    }

    const buffer = fs.readFileSync(archivePath);
    const eocd = findEndOfCentralDirectory(buffer);
    if (eocd < 0) throw new Error(`Invalid zip archive: ${archivePath}`);

    const entryCount = buffer.readUInt16LE(eocd + 10);
    let centralOffset = buffer.readUInt32LE(eocd + 16);

    for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
        if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) {
            throw new Error(`Invalid zip central directory: ${archivePath}`);
        }
        const method = buffer.readUInt16LE(centralOffset + 10);
        const compressedSize = buffer.readUInt32LE(centralOffset + 20);
        const uncompressedSize = buffer.readUInt32LE(centralOffset + 24);
        const fileNameLength = buffer.readUInt16LE(centralOffset + 28);
        const extraLength = buffer.readUInt16LE(centralOffset + 30);
        const commentLength = buffer.readUInt16LE(centralOffset + 32);
        const localHeaderOffset = buffer.readUInt32LE(centralOffset + 42);
        const fileName = buffer.toString('utf8', centralOffset + 46, centralOffset + 46 + fileNameLength);
        centralOffset += 46 + fileNameLength + extraLength + commentLength;

        if (!fileName || fileName.endsWith('/')) continue;
        if (fileName.includes('..') || path.isAbsolute(fileName)) {
            throw new Error(`Unsafe zip entry path: ${fileName}`);
        }

        if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
            throw new Error(`Invalid zip local header: ${archivePath}`);
        }
        const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
        const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
        const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
        let data;
        if (method === 0) {
            data = compressed;
        } else if (method === 8) {
            data = zlib.inflateRawSync(compressed);
        } else {
            throw new Error(`Unsupported zip compression method ${method} for ${fileName}`);
        }
        if (data.length !== uncompressedSize) {
            throw new Error(`Invalid zip entry size for ${fileName}`);
        }
        const outputPath = path.join(destDir, path.basename(fileName));
        fs.writeFileSync(outputPath, data);
    }
}

async function unpackManifestEntry(entry, archivesDir, unpackedPath, checksums) {
    const archivePath = path.join(archivesDir, entry.archiveName);
    if (!fs.existsSync(archivePath)) {
        throw new Error(`Archive not found: ${archivePath}`);
    }
    verifyArchiveChecksumValue(archivePath, checksums.get(entry.archiveName));

    if (entry.archiveType === 'zip') {
        unpackZipArchive(archivePath, unpackedPath);
    } else {
        await unpackArchive(archivePath, unpackedPath);
    }

    for (const expectedFile of [entry.binaryName, ...(entry.extraBinaries || [])]) {
        const expectedPath = path.join(unpackedPath, expectedFile);
        if (!fs.existsSync(expectedPath)) {
            throw new Error(`Expected binary not found after extraction: ${expectedPath}`);
        }
        if (os.platform() !== 'win32' && expectedFile === entry.binaryName) {
            fs.chmodSync(expectedPath, 0o755);
        }
    }

    if (entry.licenseName) {
        const source = path.join(archivesDir, entry.licenseName);
        if (!fs.existsSync(source)) {
            throw new Error(`License not found: ${source}`);
        }
        fs.copyFileSync(source, path.join(unpackedPath, entry.licenseName));
    }

    for (const licenseName of entry.licenseNames || []) {
        const licensePath = path.join(unpackedPath, licenseName);
        if (!fs.existsSync(licensePath)) {
            throw new Error(`Expected license not found after extraction: ${licensePath}`);
        }
    }
}

/**
 * Record the materialized runtime asset through the one CLI build-manifest
 * owner. The manifest carries exactly one runtime asset, so a distribution that
 * staged more than one leaf for this platform is incoherent and fails closed.
 */
function recordCliRuntimeAsset(toolsDir, entries) {
    if (entries.length === 0) return;
    if (entries.length > 1) {
        throw new Error(
            `Expected exactly one staged CLI runtime asset, found ${entries.length}: `
            + entries.map((entry) => entry.archiveName).join(', '),
        );
    }
    const runtimeRoot = path.dirname(toolsDir);
    const cliDistBuildManifest = require('@happier-dev/cli-common/cliDistBuildManifest');
    cliDistBuildManifest.writeCliRuntimeAssetBuildManifest({
        runtimeRoot,
        entrypoint: path.join(runtimeRoot, 'package-dist', 'index.mjs'),
        relativePath: entries[0].runtimeAssetRelativePath,
    });
}

function writeVersionMarker(unpackedPath, platformDir, entries) {
    const tools = {};
    for (const entry of entries) {
        tools[manifestEntryKey(entry)] = {
            version: entry.version,
            archiveName: entry.archiveName,
        };
    }
    fs.writeFileSync(path.join(unpackedPath, VERSION_MARKER_NAME), `${JSON.stringify({ platformDir, tools }, null, 2)}\n`);
}

/**
 * Main unpacking function.
 */
async function unpackTools(options = {}) {
    try {
        const platformDir = options.platformDir || getPlatformDir();
        const toolsDir = options.toolsDir || getToolsDir();
        const archivesDir = path.join(toolsDir, 'archives');
        const unpackedPath = path.join(toolsDir, 'unpacked');

        if (areToolsUnpacked(toolsDir, platformDir)) {
            // The extracted bytes are the asset; the build manifest is the record
            // the launch resolver reads. Re-record so an already-extracted tree
            // can never present the wrapper without its integrity entry.
            recordCliRuntimeAsset(toolsDir, getStagedRuntimeAssetsForPlatform(archivesDir, platformDir));
            console.log(`Tools already unpacked for ${platformDir}`);
            return { success: true, alreadyUnpacked: true };
        }

        console.log(`Unpacking tools for ${platformDir}...`);

        if (!fs.existsSync(unpackedPath)) {
            fs.mkdirSync(unpackedPath, { recursive: true });
        }

        const entries = getManifestForPlatform(platformDir);
        if (entries.length === 0) {
            throw new Error(`Unsupported platform: ${platformDir}`);
        }
        const checksums = readArchiveChecksums(archivesDir);
        const runtimeAssetEntries = getStagedRuntimeAssetsForPlatform(archivesDir, platformDir, checksums);
        for (const entry of [...entries, ...runtimeAssetEntries]) {
            await unpackManifestEntry(entry, archivesDir, unpackedPath, checksums);
        }
        recordCliRuntimeAsset(toolsDir, runtimeAssetEntries);
        writeVersionMarker(unpackedPath, platformDir, [...entries, ...runtimeAssetEntries]);

        console.log(`Tools unpacked successfully to ${unpackedPath}`);
        return { success: true, alreadyUnpacked: false };
    } catch (error) {
        console.error('Failed to unpack tools:', error.message);
        throw error;
    }
}

module.exports = {
    unpackTools,
    getPlatformDir,
    getToolsDir,
    areToolsUnpacked,
    getToolArchiveManifest,
    getCliRuntimeAssetArchiveManifest,
    unpackArchive,
    parseChecksumManifestContents,
    readChecksumManifest,
    readArchiveChecksums,
    RUNTIME_ASSET_CHECKSUM_MANIFEST_NAME,
    verifyArchiveChecksum,
};

if (require.main === module) {
    unpackTools()
        .then(() => {
            process.exit(0);
        })
        .catch((error) => {
            console.error('Error:', error);
            process.exit(1);
        });
}
