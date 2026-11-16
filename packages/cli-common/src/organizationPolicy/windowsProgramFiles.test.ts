import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const native = vi.hoisted(() => ({ status: 0, folder: [] as number[], frees: [] as number[], closes: [] as string[], ffiAvailable: true,
  execFileSync: vi.fn(() => JSON.stringify({ v: 1, path: 'D:\\Native Programs' })),
}));
vi.mock('node:child_process', () => ({ execFileSync: native.execFileSync }));
vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(),
  existsSync: (path: string) => path.endsWith('happier-process-custody.exe'),
}));
vi.mock('node:module', () => ({ createRequire: () => (specifier: string) => {
  if (specifier !== 'bun:ffi') throw new Error('Unexpected native module');
  if (!native.ffiAvailable) throw new Error('Bun native SDK unavailable in Node');
  const pointers = new Map<number, ArrayBufferView>();
  const path = 'D:\\Native Programs';
  return {
    ptr(value: ArrayBufferView) { const pointer = pointers.size + 1; pointers.set(pointer, value); return pointer; },
    read: { u16: (_address: number, offset: number) => offset / 2 < path.length ? path.charCodeAt(offset / 2) : 0 },
    dlopen(library: string) {
      return {
        close: () => native.closes.push(library),
        symbols: library === 'shell32.dll' ? {
          SHGetKnownFolderPath(folder: number, flags: number, token: number, output: number) {
            expect(flags).toBe(0x4000);
            expect(token).toBe(0);
            native.folder = Array.from(new Uint8Array(pointers.get(folder)!.buffer));
            new BigUint64Array(pointers.get(output)!.buffer)[0] = 0x1000n;
            return native.status;
          },
        } : { CoTaskMemFree: (pointer: number) => native.frees.push(pointer) },
      };
    },
  };
} }));

import { resolveWindowsProgramFiles } from './windowsProgramFiles.js';

const execPath = Object.getOwnPropertyDescriptor(process, 'execPath')!;
const argv = process.argv;
const bunVersion = Object.getOwnPropertyDescriptor(process.versions, 'bun');
afterEach(() => {
  Object.defineProperty(process, 'execPath', execPath);
  process.argv = argv;
  if (bunVersion) Object.defineProperty(process.versions, 'bun', bunVersion);
  else Reflect.deleteProperty(process.versions, 'bun');
  native.ffiAvailable = true;
  native.execFileSync.mockClear();
});

describe('Windows ProgramFiles native boundary', () => {
  it('requests the Microsoft ProgramFiles KnownFolder and frees its UTF-16 result', () => {
    Object.defineProperty(process.versions, 'bun', { configurable: true, value: '1.3.0' });
    native.status = 0; native.frees = []; native.closes = [];
    expect(resolveWindowsProgramFiles()).toBe('D:\\Native Programs');
    // Microsoft FOLDERID_ProgramFiles: 905e63b6-c1bf-494e-b29c-65b732d3d21a.
    expect(native.folder).toEqual([0xb6, 0x63, 0x5e, 0x90, 0xbf, 0xc1, 0x4e, 0x49, 0xb2, 0x9c, 0x65, 0xb7, 0x32, 0xd3, 0xd2, 0x1a]);
    expect(native.frees).toEqual([0x1000]);
    expect(native.closes).toEqual(['ole32.dll', 'shell32.dll']);
  });
  it('cleans up the native result on HRESULT failure', () => {
    Object.defineProperty(process.versions, 'bun', { configurable: true, value: '1.3.0' });
    native.status = -1; native.frees = []; native.closes = [];
    expect(() => resolveWindowsProgramFiles()).toThrow('known_folder_unavailable');
    expect(native.frees).toEqual([0x1000]);
    expect(native.closes).toEqual(['ole32.dll', 'shell32.dll']);
  });
  it('reads the native KnownFolder through the packaged helper in a Node single executable', () => {
    Reflect.deleteProperty(process.versions, 'bun');
    native.ffiAvailable = false;
    Object.defineProperty(process, 'execPath', { ...execPath, value: 'C:/installer/runner/happier.exe' });
    process.argv = [process.execPath, 'C:/staging/payload/package-dist/index.mjs'];
    expect(resolveWindowsProgramFiles()).toBe('D:\\Native Programs');
    expect(native.execFileSync).toHaveBeenCalledWith(
      join('C:/staging/payload', 'tools', 'unpacked', 'happier-process-custody.exe'),
      ['windows-program-files'], expect.objectContaining({ encoding: 'utf8', windowsHide: true }),
    );
  });
});
