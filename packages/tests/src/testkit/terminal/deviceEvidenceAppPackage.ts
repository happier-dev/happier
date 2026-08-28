import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { crc32, inflateRawSync } from 'node:zlib';

export const TERMINAL_NATIVE_BUILD_IDENTITY_ENTRY = 'happier-terminal-native-build-identity.json';

type JsonObject = Record<string, unknown>;
type ZipEntry = Readonly<{
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  read: () => Buffer;
}>;

export type TerminalNativeAppPackageInspection = Readonly<{
  platform: 'ios' | 'android';
  format: 'ios-simulator-app-archive' | 'ios-ipa' | 'android-apk';
  identity: JsonObject;
  identityEntry: string;
  applicationId: string;
  version: string;
  buildNumber: string;
  executable: string | null;
  architectures: readonly string[];
  metadataSha256: string;
  dexFileCount: number;
  nativeLibraryCount: number;
  resourcesPresent: boolean;
  packageSignatureEnvelope: readonly string[];
  codeSignaturePresent: boolean;
  provisioningProfilePresent: boolean;
}>;

const bplistParser = createRequire(import.meta.url)('bplist-parser') as {
  parseBuffer: (value: Buffer) => unknown[];
};

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const minimum = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('app package has no ZIP end-of-central-directory record');
}

function safeEntryName(name: string): boolean {
  return name.length > 0 && !name.startsWith('/') && !name.includes('\\')
    && !name.split('/').some((part) => part === '..' || part === '.');
}

function readZip(path: string): Readonly<{ archive: Buffer; entries: ReadonlyMap<string, ZipEntry>; centralOffset: number }> {
  const archive = readFileSync(path);
  const eocd = findEndOfCentralDirectory(archive);
  if (archive.readUInt16LE(eocd + 4) !== 0 || archive.readUInt16LE(eocd + 6) !== 0) {
    throw new Error('multi-disk app packages are unsupported');
  }
  const entryCount = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new Error('ZIP64 app packages are unsupported');
  }
  if (entryCount < 1 || centralOffset + centralSize > eocd) throw new Error('app package central directory is out of bounds');

  const entries = new Map<string, ZipEntry>();
  const localOffsets = new Set<number>();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('app package has an invalid ZIP central directory');
    }
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const expectedCrc32 = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const disk = archive.readUInt16LE(offset + 34);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    const unixMode = externalAttributes >>> 16;
    if (nextOffset > eocd || disk !== 0 || (flags & 1) !== 0 || ![0, 8].includes(method)
      || (unixMode & 0xf000) === 0xa000) {
      throw new Error('app package contains an unsupported ZIP entry');
    }
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (!safeEntryName(name) || entries.has(name) || localOffsets.has(localOffset)) {
      throw new Error('app package contains duplicate or unsafe ZIP entries');
    }
    if (localOffset + 30 > centralOffset || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('app package ZIP local entry is invalid');
    }
    const localFlags = archive.readUInt16LE(localOffset + 6);
    const localMethod = archive.readUInt16LE(localOffset + 8);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8');
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (localName !== name || localFlags !== flags || localMethod !== method
      || dataOffset + compressedSize > centralOffset || uncompressedSize > 512 * 1024 * 1024) {
      throw new Error('app package ZIP central/local metadata does not match');
    }
    const read = (): Buffer => {
      const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
      const value = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: uncompressedSize });
      if (value.length !== uncompressedSize) throw new Error(`app package ZIP size mismatch for ${name}`);
      if (crc32(value) !== expectedCrc32) throw new Error(`app package ZIP CRC mismatch for ${name}`);
      return value;
    };
    entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset, read });
    localOffsets.add(localOffset);
    offset = nextOffset;
  }
  if (offset !== centralOffset + centralSize) throw new Error('app package central directory size does not match');
  return { archive, entries, centralOffset };
}

function jsonObject(value: Buffer, label: string): JsonObject {
  const parsed = JSON.parse(value.toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed as JsonObject;
}

function requireUniqueBuildIdentityEntry(entries: ReadonlyMap<string, ZipEntry>, expectedEntry: string): ZipEntry {
  const candidates = [...entries.values()].filter((entry) => entry.name.split('/').at(-1) === TERMINAL_NATIVE_BUILD_IDENTITY_ENTRY);
  if (candidates.length !== 1 || candidates[0]?.name !== expectedEntry) {
    throw new Error(`app package must contain exactly one TERM build identity at ${expectedEntry}`);
  }
  return candidates[0];
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_match, entity: string) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  })[entity] ?? '');
}

function parsePlist(value: Buffer): JsonObject {
  let parsed: unknown;
  if (value.subarray(0, 8).toString('ascii') === 'bplist00') {
    [parsed] = bplistParser.parseBuffer(value);
  } else {
    const xml = value.toString('utf8');
    if (!xml.includes('<plist') || !xml.includes('<dict>')) throw new Error('iOS Info.plist is neither binary nor XML plist data');
    const result: JsonObject = {};
    const pattern = /<key>([^<]+)<\/key>\s*<(string|integer)>([^<]*)<\/\2>/g;
    for (const match of xml.matchAll(pattern)) result[decodeXmlEntities(match[1]!)] = decodeXmlEntities(match[3]!);
    parsed = result;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('iOS Info.plist root must be a dictionary');
  return parsed as JsonObject;
}

function requiredString(object: JsonObject, key: string, label: string): string {
  const value = object[key];
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim().length === 0) {
    throw new Error(`${label} is missing ${key}`);
  }
  return String(value);
}

function inspectMachO(value: Buffer): readonly string[] {
  if (value.length < 32) throw new Error('iOS app executable is not a Mach-O binary');
  const cpuName = (cpu: number): string => {
    if (cpu === 0x0100000c) return 'arm64';
    if (cpu === 0x01000007) return 'x86_64';
    if (cpu === 12) return 'arm';
    if (cpu === 7) return 'x86';
    throw new Error(`unsupported Mach-O CPU type 0x${cpu.toString(16)}`);
  };
  const magicLe = value.readUInt32LE(0);
  if (magicLe === 0xfeedfacf || magicLe === 0xfeedface) return [cpuName(value.readUInt32LE(4))];
  const magicBe = value.readUInt32BE(0);
  if (magicBe !== 0xcafebabe && magicBe !== 0xcafebabf) throw new Error('iOS app executable is not a Mach-O binary');
  const count = value.readUInt32BE(4);
  const stride = magicBe === 0xcafebabf ? 32 : 20;
  if (count < 1 || count > 32 || 8 + count * stride > value.length) throw new Error('iOS fat Mach-O header is invalid');
  return [...new Set(Array.from({ length: count }, (_, index) => cpuName(value.readUInt32BE(8 + index * stride))))].sort();
}

function readLength8(value: Buffer, offset: number): readonly [number, number] {
  const first = value[offset]!;
  return (first & 0x80) === 0 ? [first, offset + 1] : [((first & 0x7f) << 8) | value[offset + 1]!, offset + 2];
}

function readLength16(value: Buffer, offset: number): readonly [number, number] {
  const first = value.readUInt16LE(offset);
  return (first & 0x8000) === 0 ? [first, offset + 2]
    : [((first & 0x7fff) << 16) | value.readUInt16LE(offset + 2), offset + 4];
}

export function parseAndroidBinaryManifest(value: Buffer): Readonly<{ applicationId: string; version: string; buildNumber: string }> {
  if (value.length < 8 || value.readUInt16LE(0) !== 0x0003 || value.readUInt32LE(4) > value.length) {
    throw new Error('AndroidManifest.xml is not Android binary XML');
  }
  let strings: string[] | null = null;
  let offset = value.readUInt16LE(2);
  const end = value.readUInt32LE(4);
  while (offset + 8 <= end) {
    const type = value.readUInt16LE(offset);
    const headerSize = value.readUInt16LE(offset + 2);
    const size = value.readUInt32LE(offset + 4);
    if (headerSize < 8 || size < headerSize || offset + size > end) throw new Error('AndroidManifest.xml has an invalid chunk');
    if (type === 0x0001) {
      if (headerSize < 28) throw new Error('AndroidManifest.xml string pool is invalid');
      const count = value.readUInt32LE(offset + 8);
      const flags = value.readUInt32LE(offset + 16);
      const stringData = offset + value.readUInt32LE(offset + 20);
      if (count > 1_000_000 || offset + headerSize + count * 4 > offset + size) throw new Error('AndroidManifest.xml string pool is out of bounds');
      strings = Array.from({ length: count }, (_, index) => {
        let cursor = stringData + value.readUInt32LE(offset + headerSize + index * 4);
        if (cursor >= offset + size) throw new Error('AndroidManifest.xml string offset is out of bounds');
        if ((flags & 0x100) !== 0) {
          [, cursor] = readLength8(value, cursor);
          const [length, start] = readLength8(value, cursor);
          if (start + length > offset + size) throw new Error('AndroidManifest.xml UTF-8 string is out of bounds');
          return value.subarray(start, start + length).toString('utf8');
        }
        const [length, start] = readLength16(value, cursor);
        if (start + length * 2 > offset + size) throw new Error('AndroidManifest.xml UTF-16 string is out of bounds');
        return value.subarray(start, start + length * 2).toString('utf16le');
      });
    } else if (type === 0x0102 && strings) {
      const nameIndex = value.readUInt32LE(offset + 20);
      if (strings[nameIndex] === 'manifest') {
        const attributeStart = value.readUInt16LE(offset + 24);
        const attributeSize = value.readUInt16LE(offset + 26);
        const attributeCount = value.readUInt16LE(offset + 28);
        const attributes = new Map<string, string>();
        if (attributeSize < 20 || attributeCount > 1024) throw new Error('Android manifest attributes are invalid');
        for (let index = 0; index < attributeCount; index += 1) {
          const attribute = offset + 16 + attributeStart + index * attributeSize;
          if (attribute + 20 > offset + size) throw new Error('Android manifest attribute is out of bounds');
          const attributeName = strings[value.readUInt32LE(attribute + 4)];
          const rawIndex = value.readUInt32LE(attribute + 8);
          const dataType = value[attribute + 15];
          const data = value.readUInt32LE(attribute + 16);
          if (!attributeName) continue;
          const raw = rawIndex !== 0xffffffff ? strings[rawIndex]
            : dataType === 0x03 ? strings[data]
              : dataType === 0x10 || dataType === 0x11 ? String(data) : undefined;
          if (raw !== undefined) attributes.set(attributeName, raw);
        }
        const applicationId = attributes.get('package');
        const version = attributes.get('versionName');
        const buildNumber = attributes.get('versionCode');
        if (!applicationId || !version || !buildNumber) throw new Error('Android manifest is missing package/version metadata');
        return { applicationId, version, buildNumber };
      }
    }
    offset += size;
  }
  throw new Error('AndroidManifest.xml has no manifest element');
}

function apkSignatureSchemes(archive: Buffer, centralOffset: number, entries: ReadonlyMap<string, ZipEntry>): readonly string[] {
  const schemes = new Set<string>();
  if ([...entries.keys()].some((name) => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(name))) schemes.add('v1');
  if (centralOffset >= 24 && archive.subarray(centralOffset - 16, centralOffset).toString('ascii') === 'APK Sig Block 42') {
    const footerSize = Number(archive.readBigUInt64LE(centralOffset - 24));
    const start = centralOffset - footerSize - 8;
    if (start < 0 || Number(archive.readBigUInt64LE(start)) !== footerSize) throw new Error('APK signing block size is invalid');
    let cursor = start + 8;
    const end = centralOffset - 24;
    while (cursor < end) {
      const pairSize = Number(archive.readBigUInt64LE(cursor));
      if (pairSize < 4 || cursor + 8 + pairSize > end) throw new Error('APK signing block entry is invalid');
      const id = archive.readUInt32LE(cursor + 8);
      if (id === 0x7109871a) schemes.add('v2');
      if (id === 0xf05368c0) schemes.add('v3');
      if (id === 0x1b93ad61) schemes.add('v3.1');
      cursor += 8 + pairSize;
    }
    if (cursor !== end) throw new Error('APK signing block is misaligned');
  }
  if (schemes.size === 0) throw new Error('APK has no v1/v2/v3 signing envelope');
  return [...schemes].sort();
}

function inspectIos(path: string): TerminalNativeAppPackageInspection {
  const zip = readZip(path);
  const infoCandidates = [...zip.entries.keys()].filter((name) => (
    /^Payload\/[^/]+\.app\/Info\.plist$/.test(name) || /^[^/]+\.app\/Info\.plist$/.test(name)
  ));
  if (infoCandidates.length !== 1) throw new Error('iOS app archive must contain exactly one top-level .app/Info.plist');
  const infoEntry = infoCandidates[0]!;
  const appRoot = infoEntry.slice(0, -'Info.plist'.length);
  const format = appRoot.startsWith('Payload/') ? 'ios-ipa' as const : 'ios-simulator-app-archive' as const;
  const identityEntry = `${appRoot}${TERMINAL_NATIVE_BUILD_IDENTITY_ENTRY}`;
  const identityZipEntry = requireUniqueBuildIdentityEntry(zip.entries, identityEntry);
  const infoBytes = zip.entries.get(infoEntry)!.read();
  const info = parsePlist(infoBytes);
  const executable = requiredString(info, 'CFBundleExecutable', 'iOS Info.plist');
  const executableEntry = zip.entries.get(`${appRoot}${executable}`);
  if (!executableEntry || executableEntry.uncompressedSize < 32) throw new Error('iOS app archive is missing its declared executable');
  const architectures = inspectMachO(executableEntry.read());
  const codeSignaturePresent = zip.entries.has(`${appRoot}_CodeSignature/CodeResources`);
  const provisioningProfilePresent = zip.entries.has(`${appRoot}embedded.mobileprovision`);
  if (format === 'ios-ipa' && (!codeSignaturePresent || !provisioningProfilePresent)) {
    throw new Error('iOS IPA is missing its code signature resources or provisioning profile');
  }
  return {
    platform: 'ios', format, identity: jsonObject(identityZipEntry.read(), 'TERM build identity'), identityEntry,
    applicationId: requiredString(info, 'CFBundleIdentifier', 'iOS Info.plist'),
    version: requiredString(info, 'CFBundleShortVersionString', 'iOS Info.plist'),
    buildNumber: requiredString(info, 'CFBundleVersion', 'iOS Info.plist'),
    executable, architectures, metadataSha256: sha256(infoBytes), dexFileCount: 0, nativeLibraryCount: 0,
    resourcesPresent: true, packageSignatureEnvelope: codeSignaturePresent ? ['codesign'] : [],
    codeSignaturePresent, provisioningProfilePresent,
  };
}

function inspectAndroid(path: string): TerminalNativeAppPackageInspection {
  const zip = readZip(path);
  const identityEntry = `assets/${TERMINAL_NATIVE_BUILD_IDENTITY_ENTRY}`;
  const identityZipEntry = requireUniqueBuildIdentityEntry(zip.entries, identityEntry);
  const manifest = zip.entries.get('AndroidManifest.xml');
  const resources = zip.entries.get('resources.arsc');
  if (!manifest || manifest.uncompressedSize < 16) throw new Error('APK is missing AndroidManifest.xml');
  if (!resources || resources.uncompressedSize < 8) throw new Error('APK is missing resources.arsc');
  const dexEntries = [...zip.entries.values()].filter((entry) => /^classes(?:\d+)?\.dex$/.test(entry.name));
  if (dexEntries.length === 0 || dexEntries.some((entry) => !entry.read().subarray(0, 4).equals(Buffer.from('dex\n')))) {
    throw new Error('APK must contain valid classes.dex bytecode');
  }
  const nativeEntries = [...zip.entries.values()].filter((entry) => /^lib\/[^/]+\/[^/]+\.so$/.test(entry.name));
  if (nativeEntries.length === 0 || nativeEntries.some((entry) => !entry.read().subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))) {
    throw new Error('TERM native APK must contain ELF native libraries');
  }
  const architectures = [...new Set(nativeEntries.map((entry) => entry.name.split('/')[1]!))].sort();
  const metadata = manifest.read();
  const parsed = parseAndroidBinaryManifest(metadata);
  return {
    platform: 'android', format: 'android-apk', identity: jsonObject(identityZipEntry.read(), 'TERM build identity'),
    identityEntry, ...parsed, executable: null, architectures, metadataSha256: sha256(metadata),
    dexFileCount: dexEntries.length, nativeLibraryCount: nativeEntries.length, resourcesPresent: true,
    packageSignatureEnvelope: apkSignatureSchemes(zip.archive, zip.centralOffset, zip.entries),
    codeSignaturePresent: true, provisioningProfilePresent: false,
  };
}

export function inspectTerminalNativeAppPackage(
  path: string,
  platform: 'ios' | 'android',
): TerminalNativeAppPackageInspection {
  return platform === 'ios' ? inspectIos(path) : inspectAndroid(path);
}

/** Reads the signed TERM identity only after validating a real platform app package. */
export function readTerminalNativeBuildIdentityFromAppPackage(
  path: string,
  platform: 'ios' | 'android',
): JsonObject {
  return inspectTerminalNativeAppPackage(path, platform).identity;
}
