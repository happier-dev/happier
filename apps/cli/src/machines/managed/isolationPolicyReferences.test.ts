import { describe, expect, it, vi } from 'vitest';
import { AxiosHeaders } from 'axios';
import axios from '@/api/client/credentialAxios';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { MachineProvisionerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ManagedMachinePresetContentV1Schema, openManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { isMachineIsolationPresetReference, validateMachineIsolationConfiguredSandboxes } from './isolationPolicyReferences';

describe('local isolation saved preset reference', () => {
  it('accepts an admitted local launch and rejects remote variants, another provider, and another controller', () => {
    const descriptor = MachineProvisionerContributionV1Schema.parse({ id: 'vm', title: 'Compute', icon: 'server', resourceKind: 'vm',
      schemaVersion: 1, launchSchema: { type: 'object', properties: { local: { type: 'boolean' } }, required: ['local'], additionalProperties: false },
      resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], browserReachable: true,
      prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['delete'] },
      actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' },
      sessionPlacement: { kind: 'controller-local', when: { op: 'eq', path: 'local', value: true } } });
    const entry = { provisioner: { pluginId: 'acme.compute', localId: 'vm' }, presetId: 'preset' };
    const target = { machineId: 'host', installationId: 'install', homeId: 'home' };
    const content = ManagedMachinePresetContentV1Schema.parse({ v: 1, name: 'Sandbox',
      launch: { provider: entry.provisioner, schemaVersion: 1, name: 'Sandbox', choices: { local: true } } });
    const opened = openManagedMachinePresetContentV1({ presetId: entry.presetId, mode: 'plain', content: { t: 'plain', v: content } });
    if (!opened?.launch) throw new Error('Preset fixture must open');
    const preset = { id: entry.presetId, homeId: target.homeId, controller: { machineId: target.machineId, installationId: target.installationId } };
    expect(isMachineIsolationPresetReference({ entry, target, preset, launch: opened.launch, descriptor })).toBe(true);
    expect(isMachineIsolationPresetReference({ entry, target, preset, launch: { ...opened.launch, choices: { local: false } }, descriptor })).toBe(false);
    expect(isMachineIsolationPresetReference({ entry, target, preset, launch: { ...opened.launch, choices: { local: true, undeclared: true } }, descriptor })).toBe(false);
    expect(isMachineIsolationPresetReference({ entry, target, preset, launch: { ...opened.launch, provider: { ...entry.provisioner, pluginId: 'other.compute' } }, descriptor })).toBe(false);
    expect(isMachineIsolationPresetReference({ entry, target, preset: { ...preset, controller: { ...preset.controller, machineId: 'other' } }, launch: opened.launch, descriptor })).toBe(false);
    expect(isMachineIsolationPresetReference({ entry, target, preset: { ...preset, homeId: 'other-home' }, launch: opened.launch, descriptor })).toBe(false);
    expect(isMachineIsolationPresetReference({ entry, target, preset: { ...preset, id: 'other-preset' }, launch: opened.launch, descriptor })).toBe(false);
    expect(isMachineIsolationPresetReference({ entry, target, preset, launch: opened.launch, descriptor: null })).toBe(false);
    expect(isMachineIsolationPresetReference({ entry, target, preset: { ...preset, controller: undefined }, launch: opened.launch, descriptor })).toBe(true);
  });
  it.each(['plain', 'requester-e2ee', 'owner-e2ee-locked', 'network-unavailable'] as const)(
    'opens configured references through the Account boundary (%s)', async scenario => {
    const identity = { pluginId: 'test.local', localId: 'vm' };
    const descriptor = MachineProvisionerContributionV1Schema.parse({ id: identity.localId, title: 'Local', icon: 'server', resourceKind: 'vm',
      schemaVersion: 1, launchSchema: { type: 'object', properties: {}, additionalProperties: false },
      resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: [process.platform], browserReachable: true,
      prerequisites: [], billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['delete'] },
      actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' },
      sessionPlacement: { kind: 'controller-local' } });
    const accountAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-root', binding: {
      serverIdentityId: 'home', accountId: 'requester', principalId: 'principal', credentialId: '00000000-0000-4000-8000-000000000001',
      grant: API_TOKEN_FULL_GRANT_V1, machineId: 'host', custodianAccountId: 'owner', installationId: 'install',
      actionId: 'machines.isolation.set', requestId: 'save', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'host' } } });
    Object.defineProperty(accountAuthorization, 'requesterHttpProjection', { value: { accountId: 'requester', serverId: 'home', serverIdentityId: 'home',
      serverHttpBaseUrl: 'https://home.test', isCurrent: async () => true, createRequestHeaders: async () => ({ 'x-test-root': 'signed' }) } });
    const target = { homeId: 'home', machineId: 'host', installationId: 'install' };
    const preset = { id: 'preset', homeId: 'home', revision: 1, owner: { kind: 'account', accountId: 'requester' },
      contentEncryptionMode: 'plain', content: { t: 'plain', v: { v: 1, name: 'Local', launch: { provider: identity, schemaVersion: 1, name: 'Local', choices: {} } } }, recipients: [] };
    // HTTP is the genuine boundary; the admitted registry, content opener and placement decision stay real.
    const network = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() },
      data: { kind: 'found', preset } });
    const validate = () => validateMachineIsolationConfiguredSandboxes({ entries: { local: { provisioner: identity, presetId: 'preset' } }, target,
      runtime: { serverId: 'home', machineId: 'host', accountId: 'requester', serverHttpBaseUrl: 'https://home.test',
        accountAuthorization, isCurrent: async () => true }, provisioners: [{ identity, definition: descriptor }], signal: new AbortController().signal });
    try {
      if (scenario === 'requester-e2ee' || scenario === 'owner-e2ee-locked') network.mockResolvedValue({ status: 200,
        statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() }, data: { kind: 'found', preset: { ...preset,
          contentEncryptionMode: 'e2ee', content: { t: 'encrypted', c: Buffer.alloc(40, 7).toString('base64') } } } });
      if (scenario === 'network-unavailable') network.mockRejectedValue(new Error('HTTP transport unavailable'));
      if (scenario === 'owner-e2ee-locked') {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'requester' })).toString('base64url')}.signature`;
        expect(await validateMachineIsolationConfiguredSandboxes({ entries: { local: { provisioner: identity, presetId: 'preset' } }, target,
          runtime: { serverId: 'home', machineId: 'host', accountId: 'requester', serverHttpBaseUrl: 'https://home.test',
            credentials: { token, encryption: null }, isCurrent: async () => true }, provisioners: [{ identity, definition: descriptor }],
          signal: new AbortController().signal })).toBe('locked');
      } else expect(await validate()).toBe(scenario === 'plain' ? 'valid' : 'unavailable');
    } finally { network.mockRestore(); }
  });
});
