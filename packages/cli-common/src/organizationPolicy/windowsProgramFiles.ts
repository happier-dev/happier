import { createRequire } from 'node:module';

type NativeLibrary = Readonly<{ symbols: Record<string, (...args: number[]) => number>; close(): void }>;
type WindowsFfi = Readonly<{
  dlopen(path: string, symbols: Record<string, Readonly<{ args: readonly string[]; returns: string }>>): NativeLibrary;
  ptr(value: ArrayBufferView): number;
  read: Readonly<{ u16(address: number, offset: number): number }>;
}>;

/** Native machine path: ambient ProgramFiles variables never select policy authority. */
export function resolveWindowsProgramFiles(): string {
  // The shipped CLI is Bun. Node development without this native facility
  // reports path_unavailable at the policy boundary rather than reading a user path.
  const require = createRequire(import.meta.url);
  const ffi = require('bun:ffi') as WindowsFfi;
  const shell = ffi.dlopen('shell32.dll', { SHGetKnownFolderPath: { args: ['ptr', 'u32', 'u64', 'ptr'], returns: 'i32' } });
  // FOLDERID_ProgramFiles, GUID in native little-endian layout.
  const folderId = new Uint8Array([0xb6, 0x63, 0x5e, 0x90, 0xbf, 0xc1, 0x4e, 0x49, 0xb2, 0x9c, 0x65, 0xb7, 0x32, 0xd3, 0xd2, 0x1a]);
  const result = new BigUint64Array(1);
  let ole: NativeLibrary | undefined;
  try {
    ole = ffi.dlopen('ole32.dll', { CoTaskMemFree: { args: ['ptr'], returns: 'void' } });
    const status = shell.symbols.SHGetKnownFolderPath(ffi.ptr(folderId), 0x4000, 0, ffi.ptr(result));
    if (status < 0 || result[0] === 0n) throw new Error('known_folder_unavailable');
    const address = Number(result[0]);
    const units: number[] = [];
    for (let offset = 0; ; offset += 2) {
      const unit = ffi.read.u16(address, offset);
      if (unit === 0) break;
      units.push(unit);
    }
    const path = Buffer.from(new Uint16Array(units).buffer).toString('utf16le');
    if (!path) throw new Error('known_folder_unavailable');
    return path;
  } finally {
    if (result[0] !== 0n) ole?.symbols.CoTaskMemFree(Number(result[0]));
    ole?.close();
    shell.close();
  }
}
