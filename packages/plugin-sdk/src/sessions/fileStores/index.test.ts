import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('sessions/fileStores experimental SDK subpath', () => {
  it('is published as a domain-named experimental SDK export', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { exports?: Record<string, unknown> };

    expect(packageJson.exports).toHaveProperty('./experimental/sessions/fileStores', {
      types: './dist/sessions/fileStores/index.d.ts',
      default: './dist/sessions/fileStores/index.js',
    });
  });

  it('exports generic record and path helpers used by session-file plugins', async () => {
    const fileStores = await import('./index.js') as Readonly<{
      isRecord(value: unknown): value is Record<string, unknown>;
      readString(value: unknown): string | null;
      readTrimmedString(value: unknown): string | null;
      parseJsonLine(line: string): unknown | null;
      expandHomePath(raw: string, homeDir?: string): string;
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
    expect(fileStores.expandHomePath('~/agent', '/home/alice')).toBe('/home/alice/agent');
    expect(fileStores.expandHomePath('~\\agent', '/home/alice')).toBe('/home/alice/agent');
    expect(fileStores.decodeIndexCursor(fileStores.encodeIndexCursor(3.9))).toBe(3);
    expect(fileStores.decodeIndexCursor('not-a-cursor')).toBeNull();
  });
});
