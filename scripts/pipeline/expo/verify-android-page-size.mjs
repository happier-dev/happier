// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readAndroidBundleProtobufFields } from './read-android-aab-metadata.mjs';

const PAGE_SIZE = 16384n;

/** @param {Buffer} bytes @param {string} abi */
function readLoadAlignments(bytes, abi) {
  if (bytes.length < 64 || !bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))
    || bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1 || bytes.readUInt16LE(16) !== 3
    || bytes.readUInt16LE(18) !== (abi === 'arm64-v8a' ? 183 : 62)) {
    throw new Error('Expected a matching 64-bit little-endian ELF shared library');
  }
  const start = Number(bytes.readBigUInt64LE(32));
  const size = bytes.readUInt16LE(54);
  const count = bytes.readUInt16LE(56);
  if (!Number.isSafeInteger(start) || start < 64 || size !== 56 || count === 0 || count === 65535
    || start + size * count > bytes.length) throw new Error('Invalid ELF program-header table');
  const alignments = [];
  for (let i = 0; i < count; i++) {
    const at = start + i * size;
    if (bytes.readUInt32LE(at) !== 1) continue;
    const offset = bytes.readBigUInt64LE(at + 8);
    const address = bytes.readBigUInt64LE(at + 16);
    const fileSize = bytes.readBigUInt64LE(at + 32);
    const alignment = bytes.readBigUInt64LE(at + 48);
    if (offset + fileSize > BigInt(bytes.length)) throw new Error('Truncated ELF LOAD segment');
    if (alignment < PAGE_SIZE || (alignment & (alignment - 1n)) !== 0n || (address - offset) % alignment !== 0n) {
      throw new Error(`LOAD alignment ${alignment} is incompatible with 16KB pages (requires at least 16384)`);
    }
    alignments.push(Number(alignment));
  }
  if (!alignments.length) throw new Error('ELF shared library has no LOAD segments');
  return alignments;
}

/** @param {Buffer} bytes */
function readPackaging(bytes) {
  // bundletool 1.18.2 config.proto: BundleConfig.optimizations (2),
  // Optimizations.uncompress_native_libraries (2), enabled (1), alignment (2).
  // The AAB requests APK alignment; its own ZIP offsets are not APK offsets.
  const message = (entries, number) => {
    const matches = entries.filter((entry) => entry.number === number && entry.wire === 2);
    if (matches.length !== 1 || !Buffer.isBuffer(matches[0].value)) throw new Error('Missing or ambiguous Android bundle packaging configuration');
    return readAndroidBundleProtobufFields(matches[0].value);
  };
  const native = message(message(readAndroidBundleProtobufFields(bytes), 2), 2);
  const enabled = native.filter((entry) => entry.number === 1 && entry.wire === 0);
  const alignment = native.filter((entry) => entry.number === 2 && entry.wire === 0);
  if (enabled.length > 1 || alignment.length > 1) throw new Error('Ambiguous Android bundle page alignment');
  if (enabled.length && enabled[0].value !== 0n && enabled[0].value !== 1n) throw new Error('Invalid native library compression flag');
  if (enabled[0]?.value === 1n && alignment[0]?.value !== 2n && alignment[0]?.value !== 3n) {
    throw new Error('Android bundle must request PAGE_ALIGNMENT_16K or PAGE_ALIGNMENT_64K for uncompressed native libraries');
  }
  return enabled[0]?.value === 1n ? Number(alignment[0].value) : 'compressed';
}

/**
 * Fail closed before Android artifact publication or submission. Checks every
 * shipped 64-bit library in every AAB module, including third-party prebuilts.
 * @param {{ aabPath: string; env?: NodeJS.ProcessEnv }} options
 */
export function verifyAndroidPageSize({ aabPath, env = process.env }) {
  const archive = path.resolve(aabPath);
  const entries = execFileSync('unzip', ['-Z1', archive], { env, encoding: 'utf8', maxBuffer: Infinity }).trim().split('\n');
  if (new Set(entries).size !== entries.length) throw new Error('Android bundle contains duplicate ZIP entries');
  const libraries = entries.filter((name) => /(?:^|\/)lib\/(?:arm64-v8a|x86_64)\/[^/]+\.so$/u.test(name));
  if (!libraries.length) throw new Error('Android bundle contains no 64-bit native libraries to verify');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-android-page-size-'));
  const output = path.join(directory, 'entry');
  const extract = (entry) => {
    if (/[\[\]*?]/u.test(entry)) throw new Error('Unsupported ZIP entry name');
    const fd = fs.openSync(output, 'w');
    try { execFileSync('unzip', ['-p', archive, entry], { env, stdio: ['ignore', fd, 'pipe'] }); }
    finally { fs.closeSync(fd); }
    return fs.readFileSync(output);
  };
  try {
    const failures = [];
    const verified = [];
    for (const name of libraries) {
      const abi = name.split('/').at(-2);
      try { verified.push({ name, alignments: readLoadAlignments(extract(name), abi) }); }
      catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    let packaging;
    try { packaging = readPackaging(extract('BundleConfig.pb')); }
    catch (error) { failures.push(`BundleConfig.pb: ${error instanceof Error ? error.message : String(error)}`); }
    if (failures.length) throw new Error(`Android 16KB page-size verification failed:\n${failures.join('\n')}`);
    return { libraries: verified, packaging };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: verify-android-page-size.mjs <artifact.aab>');
    const result = verifyAndroidPageSize({ aabPath: process.argv[2] });
    console.log(`Android 16KB page-size verification passed (${result.libraries.length} libraries; packaging=${result.packaging}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
