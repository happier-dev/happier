import { describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ status: 0, folder: [] as number[], frees: [] as number[], closes: [] as string[] }));
vi.mock('node:module', () => ({ createRequire: () => (specifier: string) => {
  if (specifier !== 'bun:ffi') throw new Error('Unexpected native module');
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

describe('Windows ProgramFiles native boundary', () => {
  it('requests the Microsoft ProgramFiles KnownFolder and frees its UTF-16 result', () => {
    native.status = 0; native.frees = []; native.closes = [];
    expect(resolveWindowsProgramFiles()).toBe('D:\\Native Programs');
    // Microsoft FOLDERID_ProgramFiles: 905e63b6-c1bf-494e-b29c-65b732d3d21a.
    expect(native.folder).toEqual([0xb6, 0x63, 0x5e, 0x90, 0xbf, 0xc1, 0x4e, 0x49, 0xb2, 0x9c, 0x65, 0xb7, 0x32, 0xd3, 0xd2, 0x1a]);
    expect(native.frees).toEqual([0x1000]);
    expect(native.closes).toEqual(['ole32.dll', 'shell32.dll']);
  });
  it('cleans up the native result on HRESULT failure', () => {
    native.status = -1; native.frees = []; native.closes = [];
    expect(() => resolveWindowsProgramFiles()).toThrow('known_folder_unavailable');
    expect(native.frees).toEqual([0x1000]);
    expect(native.closes).toEqual(['ole32.dll', 'shell32.dll']);
  });
});
