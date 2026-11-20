import { describe, expect, it } from 'vitest';
import {
  AuthoringMemoryContentV1Schema,
  AuthoringMemoryPrivatePayloadV1Schema,
  StoredAuthoringMemoryPrivatePayloadV1Schema,
  assertAuthoringMemoryValueForKeyV1,
  assertAuthoringMemoryContentForModeV1,
  buildProjectLastOpenedMemoryKeyV1,
  parseProjectLastOpenedMemoryKeyV1,
} from './authoringMemory.js';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '../crypto/accountScopedCipher.js';

describe('authoring-memory envelopes', () => {
  it('projects retained Workflow values only after plain or authenticated E2EE opening', () => {
    const key = 'workflowProject:00000000-0000-4000-8000-000000000005';
    const value = { machineId: 'machine-one', directory: '/repo', workspaceRefId: 'workspace-one' };
    const retained = { ...value, retired: { future: true } };
    expect(assertAuthoringMemoryContentForModeV1({ t: 'plain', v: retained }, 'plain', key))
      .toEqual({ t: 'plain', v: value });
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(7) };
    const ciphertext = sealAccountScopedBlobCiphertext({ kind: 'authoring_memory', material,
      payload: { key, value: retained, retired: true }, randomBytes: length => new Uint8Array(length).fill(8) });
    const opened = openAccountScopedBlobCiphertext({ kind: 'authoring_memory', material, ciphertext });
    expect(StoredAuthoringMemoryPrivatePayloadV1Schema.parse(opened?.value)).toEqual({ key, value });
    expect(() => assertAuthoringMemoryValueForKeyV1(key, retained)).toThrow();
    expect(AuthoringMemoryPrivatePayloadV1Schema.safeParse({ key, value: retained }).success).toBe(false);
    expect(StoredAuthoringMemoryPrivatePayloadV1Schema.safeParse({ key,
      value: { ...retained, machineId: '' } }).success).toBe(false);
    const opaque = { future: { retired: true, arbitrary: [null, 4] } };
    expect(StoredAuthoringMemoryPrivatePayloadV1Schema.parse({ key: 'engineSelection:future', value: opaque }))
      .toEqual({ key: 'engineSelection:future', value: opaque });
  });
  it('keeps a saved Workflow project in personal authoring memory with its exact workspace binding', () => {
    const key = 'workflowProject:00000000-0000-4000-8000-000000000005';
    const value = { machineId: 'machine-one', directory: '/repo', workspaceRefId: 'workspace-one' };
    expect(AuthoringMemoryPrivatePayloadV1Schema.safeParse({ key, value }).success).toBe(true);
    expect(() => assertAuthoringMemoryContentForModeV1({ t: 'plain', v: value }, 'plain', key)).not.toThrow();
    expect(AuthoringMemoryPrivatePayloadV1Schema.safeParse({ key, value: { machineId: 'machine-one' } }).success).toBe(false);
    expect(AuthoringMemoryPrivatePayloadV1Schema.safeParse({ key: 'workflowProject:', value }).success).toBe(false);
  });
  it('round-trips a native Workflow workspace through strict JSON authoring memory', () => {
    const key = 'workflowProject:00000000-0000-4000-8000-000000000005';
    const workspace = { v: 2, kind: 'managed', serverId: 'home', workspaceId: 'guest-checkout', managedId: 'guest',
      controller: { machineId: 'controller', installationId: 'installation' }, rootPath: '/guest/repo' };
    const value = { machineId: 'controller', directory: workspace.rootPath,
      sessionPlacement: { kind: 'in_place', workspace } };
    const parsed = assertAuthoringMemoryValueForKeyV1(key, value);
    expect(parsed).toStrictEqual(value);
    const envelope = AuthoringMemoryContentV1Schema.parse({ t: 'plain', v: parsed });
    expect(envelope).toEqual({ t: 'plain', v: value });
    expect(assertAuthoringMemoryContentForModeV1(JSON.parse(JSON.stringify(envelope)), 'plain', key))
      .toEqual(envelope);
    for (const machineId of ['controller', undefined]) {
      expect(() => assertAuthoringMemoryValueForKeyV1(key, { ...value,
        sessionPlacement: { ...value.sessionPlacement, workspace: { ...workspace, machineId } } })).toThrow();
    }
  });
  it('admits qualified Project recency and rejects invalid timestamps and noncanonical identities', () => {
    const key = 'projectLastOpened:home%3Aone:project%2Fone';
    expect(buildProjectLastOpenedMemoryKeyV1({ serverId: 'home:one', projectKey: 'project/one' })).toBe(key);
    expect(parseProjectLastOpenedMemoryKeyV1(key)).toEqual({ serverId: 'home:one', projectKey: 'project/one' });
    expect(AuthoringMemoryPrivatePayloadV1Schema.safeParse({ key, value: 0 }).success).toBe(true);
    expect(AuthoringMemoryPrivatePayloadV1Schema.safeParse({ key, value: 1234 }).success).toBe(true);
    for (const value of [-1, Infinity, '1234', { timestamp: 1234 }]) {
      expect(AuthoringMemoryPrivatePayloadV1Schema.safeParse({ key, value }).success).toBe(false);
      expect(() => assertAuthoringMemoryContentForModeV1({ t: 'plain', v: value }, 'plain', key)).toThrow();
    }
    for (const key of ['projectLastOpened::project', 'projectLastOpened:home:', 'projectLastOpened:home:project:extra', 'projectLastOpened:home%3aone:project', 'projectLastOpened:%20home:project']) {
      expect(AuthoringMemoryPrivatePayloadV1Schema.safeParse({ key, value: 1 }).success).toBe(false);
    }
  });
  it('preserves opaque strict JSON engine carriers, and rejects values outside JSON', () => {
    const value = { v: 1, modelSelection: { future: { nested: [null, false, 2] } }, unknown: 'preserve' };
    expect(AuthoringMemoryContentV1Schema.parse({ t: 'plain', v: value })).toEqual({ t: 'plain', v: value });
    expect(AuthoringMemoryContentV1Schema.safeParse({ t: 'plain', v: { invalid: undefined } }).success).toBe(false);
    expect(AuthoringMemoryContentV1Schema.safeParse({ t: 'plain', v: value, extra: true }).success).toBe(false);
    expect(AuthoringMemoryPrivatePayloadV1Schema.parse({ key: 'engineSelection:default:agent:codex', value })).toEqual({ key: 'engineSelection:default:agent:codex', value });
  });

  it('requires the persisted Account mode and exact cipher purpose', () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(7) };
    const randomBytes = (length: number) => new Uint8Array(length).fill(8);
    const encrypted = { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'authoring_memory', material, payload: { key: 'lastUsedProfile', value: 'profile' }, randomBytes }) };
    expect(assertAuthoringMemoryContentForModeV1(encrypted, 'e2ee')).toEqual(encrypted);
    expect(() => assertAuthoringMemoryContentForModeV1(encrypted, 'plain')).toThrow();
    expect(() => assertAuthoringMemoryContentForModeV1({ t: 'plain', v: 'profile' }, 'e2ee')).toThrow();
    expect(() => assertAuthoringMemoryContentForModeV1({ t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material, payload: {}, randomBytes }) }, 'e2ee')).toThrow();
  });

  it('drops additive persisted envelope fields while mutation content remains strict', () => {
    const stored = { t: 'plain', v: { opaque: { future: true } }, futureEnvelopeField: true };
    expect(assertAuthoringMemoryContentForModeV1(stored, 'plain')).toEqual({ t: 'plain', v: stored.v });
    expect(AuthoringMemoryContentV1Schema.safeParse(stored).success).toBe(false);
    expect(() => assertAuthoringMemoryContentForModeV1(stored, 'e2ee')).toThrow();
  });
});
