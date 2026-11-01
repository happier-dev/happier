// Kept free of cli-common imports: the Vitest setup file loads this module before tests install
// their `node:child_process` mocks, and an eager service import would capture the real spawn.

/** Smallest bytes the service owner accepts as the x64 GUI launcher: MZ, PE32+, GUI subsystem, marker. */
export function createWindowsServiceLauncherPeFixture(): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x00004550, 0x80);
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(0x20b, 0x98);
  bytes.writeUInt16LE(2, 0x98 + 68);
  bytes.write('HAPPIER_SERVICE_LAUNCHER_V1', 0x120, 'ascii');
  return bytes;
}
