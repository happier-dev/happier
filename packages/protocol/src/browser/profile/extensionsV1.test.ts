import { describe, expect, it } from 'vitest';
import { BrowserExtensionRecordV1Schema } from './v1.js';

describe('browser extension profile records', () => {
  it('rejects non-extension ids and closed record fields before persistence', () => {
    const schema = BrowserExtensionRecordV1Schema;
    const record = { id: 'a'.repeat(32), name: 'Content fixture', version: '1.0', enabled: true,
      source: { kind: 'webStore', extensionId: 'a'.repeat(32) }, directory: '/profile/extensions/fixture',
      permissions: ['storage'], hostPermissions: ['https://example.test/*'] };
    expect(schema.safeParse(record).success).toBe(true);
    expect(schema.safeParse({ ...record, id: '../outside' }).success).toBe(false);
    expect(schema.safeParse({ ...record, source: { ...record.source, extensionId: 'z'.repeat(32) } }).success).toBe(false);
    expect(schema.safeParse({ ...record, source: { ...record.source, extensionId: 'b'.repeat(32) } }).success).toBe(false);
    expect(schema.safeParse({ ...record, futureField: true }).success).toBe(false);
  });
});
