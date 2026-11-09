import type { Buffer } from 'node:buffer';

export function createWindowsServiceLauncherPeFixture(overrides?: Readonly<{
  machine?: number;
  optionalMagic?: number;
  subsystem?: number;
}>): Buffer;
