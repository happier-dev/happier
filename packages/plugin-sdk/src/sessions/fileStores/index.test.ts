import { readFileSync } from 'node:fs';

import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  JsonlForwardLine,
  JsonlParsedLine,
  JsonlScanBounds,
  JsonlScannerFileSystem,
  JsonlSessionFileDescriptor,
  JsonlSourceDiagnostic,
  SessionFileStoreHeaderDescriptor,
  SessionFileStoreProductDescriptor,
  SessionFileStoreResolution,
  SessionFileStoreResolutionInput,
} from './index.js';
import type {
  JsonlForwardLineV1,
  JsonlParsedLineV1,
  JsonlScanBoundsV1,
  JsonlScannerFileSystemV1,
  JsonlSessionFileDescriptorV1,
  JsonlSourceDiagnosticV1,
} from './boundedJsonlScanner.js';
import type {
  SessionFileStoreHeaderDescriptorV1,
  SessionFileStoreProductDescriptorV1,
} from './productDescriptor.js';
import type {
  SessionFileStoreResolutionInputV1,
  SessionFileStoreResolutionV1,
} from './sessionDirResolver.js';

describe('sessions/file-stores SDK subpath', () => {
  it('projects the final unsuffixed session-file contract without copying its owners', () => {
    expectTypeOf<JsonlForwardLine>().toEqualTypeOf<JsonlForwardLineV1>();
    expectTypeOf<JsonlParsedLine>().toEqualTypeOf<JsonlParsedLineV1>();
    expectTypeOf<JsonlScanBounds>().toEqualTypeOf<JsonlScanBoundsV1>();
    expectTypeOf<JsonlScannerFileSystem>().toEqualTypeOf<JsonlScannerFileSystemV1>();
    expectTypeOf<JsonlSessionFileDescriptor>().toEqualTypeOf<JsonlSessionFileDescriptorV1>();
    expectTypeOf<JsonlSourceDiagnostic>().toEqualTypeOf<JsonlSourceDiagnosticV1>();
    expectTypeOf<SessionFileStoreHeaderDescriptor>()
      .toEqualTypeOf<SessionFileStoreHeaderDescriptorV1>();
    expectTypeOf<SessionFileStoreProductDescriptor>()
      .toEqualTypeOf<SessionFileStoreProductDescriptorV1>();
    expectTypeOf<SessionFileStoreResolutionInput>()
      .toEqualTypeOf<SessionFileStoreResolutionInputV1>();
    expectTypeOf<SessionFileStoreResolution>()
      .toEqualTypeOf<SessionFileStoreResolutionV1>();
  });

  it('is published through the canonical domain-named SDK export', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { exports?: Record<string, unknown> };

    expect(packageJson.exports).toHaveProperty('./sessions/file-stores', {
      types: './dist/sessions/file-stores/index.d.ts',
      default: './dist/sessions/file-stores/index.js',
    });
  });

  it('exports generic record and path helpers used by session-file plugins', async () => {
    const fileStores = await import('./index.js') as Readonly<{
      isRecord(value: unknown): value is Record<string, unknown>;
      readString(value: unknown): string | null;
      readTrimmedString(value: unknown): string | null;
      parseJsonLine(line: string): unknown | null;
      parseTimestampMs(value: unknown): number | null;
      expandHomePath(raw: string, homeDir?: string): string;
      resolveHomeDirFromEnvironment(
        env: NodeJS.ProcessEnv,
        platform?: NodeJS.Platform,
      ): string;
      encodeIndexCursor(offset: number): string;
      decodeIndexCursor(raw: string | null | undefined): number | null;
    }>;

    expect(fileStores.isRecord({ a: 1 })).toBe(true);
    expect(fileStores.isRecord([])).toBe(false);
    expect(fileStores.readString(' value ')).toBe(' value ');
    expect(fileStores.readString('   ')).toBeNull();
    expect(fileStores.readTrimmedString(' value ')).toBe('value');
    expect(fileStores.readTrimmedString('   ')).toBeNull();
    expect(fileStores.parseJsonLine('{"ok":true}')).toEqual({ ok: true });
    expect(fileStores.parseJsonLine('{')).toBeNull();
    const timestampCases = [
      [1_700_000_000, 1_700_000_000_000],
      [1_700_000_000_000, 1_700_000_000_000],
      [1_000_000_000_000, 1_000_000_000_000],
    ] as const;
    for (const [value, expected] of timestampCases) {
      expect(fileStores.parseTimestampMs(value)).toBe(expected);
    }
    expect(fileStores.parseTimestampMs('2026-05-17T12:00:00.000Z'))
      .toBe(Date.parse('2026-05-17T12:00:00.000Z'));
    expect(fileStores.parseTimestampMs(-1)).toBeNull();
    expect(fileStores.expandHomePath('~/agent', '/home/alice')).toBe('/home/alice/agent');
    expect(fileStores.expandHomePath('~\\agent', '/home/alice')).toBe('/home/alice/agent');
    expect(fileStores.resolveHomeDirFromEnvironment({
      HOME: '/home/alice',
      USERPROFILE: 'C:\\Users\\alice',
    }, 'win32')).toBe('C:\\Users\\alice');
    expect(fileStores.decodeIndexCursor(fileStores.encodeIndexCursor(3.9))).toBe(3);
    expect(fileStores.decodeIndexCursor('not-a-cursor')).toBeNull();
  });
});
