import { describe, expect, it } from 'vitest';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import { LumeNativeConfigurationSchema, LumeNativeDetailsSchema, LumeNativePullSchema, LumeNativeResourceSchema } from './schemas.js';

describe('Lume native public schema boundary', () => {
  it('composes strict native ingress without changing exact identities or tolerant vendor projections', () => {
    const resource = { storage: 'external disk', vmName: 'native vm' };
    const pull = { ...resource, image: 'linux:latest', registry: 'ghcr.io', organization: 'trycua' };
    const configuration = { cpu: 2, memory: '4GB', diskSize: '20GB' };
    // Public composition is the real recognition boundary, not a private
    // schema-brand check or a wrapper around the previous Zod validators.
    const composed = defineProtocolObject({ resource: LumeNativeResourceSchema,
      pull: LumeNativePullSchema, configuration: LumeNativeConfigurationSchema }, { policy: 'closed' });
    expect(composed.parse({ resource, pull, configuration })).toEqual({ resource, pull, configuration });
    expect(composed.safeParse({ resource: { ...resource, private: 'rejected' }, pull, configuration }).success).toBe(false);
    expect(LumeNativePullSchema.safeParse({ ...pull, private: 'rejected' }).success).toBe(false);
    expect(LumeNativeConfigurationSchema.safeParse({ ...configuration, private: 'rejected' }).success).toBe(false);
    for (const vmName of ['', '.', '..', 'neighbor:latest', 'a/b', 'a\\b', 'native\0vm']) {
      expect(LumeNativeResourceSchema.safeParse({ ...resource, vmName }).success).toBe(false);
    }
    for (const vmName of ['native vm', '.\n', 'line\nbreak']) {
      expect(LumeNativeResourceSchema.parse({ ...resource, vmName })).toEqual({ ...resource, vmName });
    }
    expect(LumeNativePullSchema.safeParse({ ...pull, image: 'image\0secret' }).success).toBe(false);
    expect(LumeNativeResourceSchema.safeParse({ ...resource, storage: 'disk\0secret' }).success).toBe(false);
    for (const cpu of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(LumeNativeConfigurationSchema.safeParse({ ...configuration, cpu }).success).toBe(false);
    }
    const details = { name: resource.vmName, locationName: resource.storage, status: 'running', os: 'linux',
      cpuCount: 2, memorySize: 4 * 1024 ** 3, diskSize: { allocated: 1024 ** 3, total: 20 * 1024 ** 3 } };
    expect(LumeNativeDetailsSchema.parse({ ...details, future: 'vendor addition', vncUrl: 'vnc://private',
      diskSize: { ...details.diskSize, future: 'vendor addition' } })).toEqual(details);
  });
});
