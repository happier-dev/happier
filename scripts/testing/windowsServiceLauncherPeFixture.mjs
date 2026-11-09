// This fixture models the filesystem/native executable boundary. Keep it free of
// product imports: CLI setup loads it before process boundary mocks are installed.

/**
 * @param {{ machine?: number; optionalMagic?: number; subsystem?: number }} [overrides]
 * @returns {Buffer}
 */
export function createWindowsServiceLauncherPeFixture(overrides = {}) {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x00004550, 0x80);
  bytes.writeUInt16LE(overrides.machine ?? 0x8664, 0x84);
  bytes.writeUInt16LE(overrides.optionalMagic ?? 0x20b, 0x98);
  bytes.writeUInt16LE(overrides.subsystem ?? 2, 0x98 + 68);
  bytes.write('HAPPIER_SERVICE_LAUNCHER_V1', 0x120, 'ascii');
  return bytes;
}
