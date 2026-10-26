#!/usr/bin/env node

/**
 * Unpacks platform-specific binaries from compressed archives
 * This script extracts the necessary tools for the current platform
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
];

const VERSION_MARKER_NAME = '.happier-tools-manifest.json';

/**
 * Get the platform-specific directory name
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
 * Get the root tools directory
 */
function getToolsDir() {
    // Handle both direct execution and require() calls
    const scriptDir = __dirname;
    return path.resolve(scriptDir, '..', 'tools');
}

/**
 * Check if tools are already unpacked for current platform
 */
function getToolArchiveManifest() {
    return TOOL_ARCHIVE_MANIFEST.map((entry) => ({ ...entry }));
}

function getManifestForPlatform(platformDir, tools) {
    const entries = TOOL_ARCHIVE_MANIFEST.filter((entry) => entry.platformDir === platformDir);
    if (!tools) return entries;
    for (const tool of tools) {
        if (!entries.some((entry) => entry.tool === tool)) {
            throw new Error(`Unsupported tool ${tool} for platform: ${platformDir}`);
        }
    }
    return entries.filter((entry) => tools.includes(entry.tool));
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
    return [entry.binaryName, ...(entry.extraBinaries || []), ...(entry.licenseName ? [entry.licenseName] : [])];
}

function areToolsUnpacked(toolsDir, platformDir = getPlatformDir(), tools) {
    const unpackedPath = path.join(toolsDir, 'unpacked');
    
    if (!fs.existsSync(unpackedPath)) {
        return false;
    }

    const entries = getManifestForPlatform(platformDir, tools);
    const expectedFiles = entries.flatMap(expectedFilesForEntry);
    const filesExist = expectedFiles.every((file) => fs.existsSync(path.join(unpackedPath, file)));
    if (!filesExist) return false;

    const marker = readVersionMarker(unpackedPath);
    if (!marker || marker.platformDir !== platformDir) return false;
    return entries.every((entry) => marker.tools?.[entry.tool]?.version === entry.version);
}

function readChecksumMap(archivesDir) {
    const checksumPath = path.join(archivesDir, 'checksums.sha256');
    if (!fs.existsSync(checksumPath)) return new Map();
    const map = new Map();
    const lines = fs.readFileSync(checksumPath, 'utf8').split(/\r?\n/u);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(trimmed);
        if (match) {
            map.set(match[2].trim(), match[1].toLowerCase());
        }
    }
    return map;
}

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

function verifyArchiveChecksum(archivePath, expectedChecksum) {
    if (!expectedChecksum) {
        throw new Error(`Missing checksum for manifest archive: ${path.basename(archivePath)}`);
    }
    const actual = sha256File(archivePath);
    if (actual !== expectedChecksum) {
        throw new Error(`Archive checksum mismatch for ${path.basename(archivePath)}: expected ${expectedChecksum}, got ${actual}`);
    }
}

function resolveExpectedArchiveChecksum(entry, checksumMap) {
    return checksumMap.get(entry.archiveName) ?? entry.sha256 ?? null;
}

/**
 * Unpack a tar.gz archive to a destination directory
 */
async function unpackArchive(archivePath, destDir) {
    return new Promise((resolve, reject) => {
        // Ensure destination directory exists
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }
        
        // Create read stream and extract
        fs.createReadStream(archivePath)
            .pipe(zlib.createGunzip())
            .pipe(tar.extract({
                cwd: destDir,
                preserveMode: true,
                preserveOwner: false
            }))
            .on('finish', () => {
                // Set executable permissions for Unix systems
                if (os.platform() !== 'win32') {
                    const files = fs.readdirSync(destDir);
                    files.forEach(file => {
                        const filePath = path.join(destDir, file);
                        const stats = fs.statSync(filePath);
                        if (stats.isFile() && !file.endsWith('.node')) {
                            // Make binary files executable
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

async function unpackManifestEntry(entry, archivesDir, unpackedPath, checksumMap) {
    const archivePath = path.join(archivesDir, entry.archiveName);
    if (!fs.existsSync(archivePath)) {
        throw new Error(`Archive not found: ${archivePath}`);
    }
    verifyArchiveChecksum(archivePath, resolveExpectedArchiveChecksum(entry, checksumMap));

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
}

function writeVersionMarker(unpackedPath, platformDir, entries) {
    const tools = {};
    for (const entry of entries) {
        tools[entry.tool] = {
            version: entry.version,
            archiveName: entry.archiveName,
        };
    }
    fs.writeFileSync(path.join(unpackedPath, VERSION_MARKER_NAME), `${JSON.stringify({ platformDir, tools }, null, 2)}\n`);
}

/**
 * Main unpacking function
 */
async function unpackTools(options = {}) {
    try {
        const platformDir = options.platformDir || getPlatformDir();
        const toolsDir = options.toolsDir || getToolsDir();
        const archivesDir = path.join(toolsDir, 'archives');
        const unpackedPath = path.join(toolsDir, 'unpacked');
        
        // Check if already unpacked
        if (areToolsUnpacked(toolsDir, platformDir, options.tools)) {
            console.log(`Tools already unpacked for ${platformDir}`);
            return { success: true, alreadyUnpacked: true };
        }
        
        console.log(`Unpacking tools for ${platformDir}...`);
        
        // Create unpacked directory
        if (!fs.existsSync(unpackedPath)) {
            fs.mkdirSync(unpackedPath, { recursive: true });
        }
        
        const entries = getManifestForPlatform(platformDir, options.tools);
        if (entries.length === 0) {
            throw new Error(`Unsupported platform: ${platformDir}`);
        }
        const checksumMap = readChecksumMap(archivesDir);
        for (const entry of entries) {
            await unpackManifestEntry(entry, archivesDir, unpackedPath, checksumMap);
        }
        writeVersionMarker(unpackedPath, platformDir, entries);
        
        console.log(`Tools unpacked successfully to ${unpackedPath}`);
        return { success: true, alreadyUnpacked: false };
        
    } catch (error) {
        console.error('Failed to unpack tools:', error.message);
        throw error;
    }
}

// Export for use as module
module.exports = { unpackTools, getPlatformDir, getToolsDir, areToolsUnpacked, getToolArchiveManifest };

// Run if executed directly
if (require.main === module) {
    // Mitigation for nodejs/node#54918: process.exit() right after this JS-heavy
    // unpack can deadlock Node 24 in NodePlatform::Shutdown while V8 background
    // compile jobs wait for a main-thread GC. It wedged the CI install after the
    // success line. Exit by draining the event loop until upstream fixes it.
    unpackTools().catch((error) => {
        console.error('Error:', error);
        process.exitCode = 1;
    });
}
