import { describe, expect, it } from 'vitest';
import { definePlugin } from './definePlugin.js';
import { defineProtocolObject, defineProtocolString } from './protocol/index.js';
import { defineAccessProviderSchemas, type AccessProviderRoleResultV1 } from '@happier-dev/plugin-sdk/access-providers';

describe('public access provider authoring', () => {
  it('projects one declaration and ordinary daemon roles through definePlugin without registration rights', () => {
    const config = defineProtocolObject({ managementUrl: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
    const roles = defineAccessProviderSchemas({ config });
    const result: AccessProviderRoleResultV1 = { kind: 'confirmed', facts: { state: 'ready' } };
    const role = (name: 'inspect' | 'join' | 'leave') => ({
      title: name, execution: { target: 'daemon' as const }, surfaces: ['plugin' as const],
      dangerLevel: name === 'inspect' ? 'safe' as const : 'externalSideEffect' as const,
      inputSchema: roles[`${name}Input`], resultSchema: roles.result, run: async () => result,
    });
    const plugin = definePlugin({
      id: 'example.access-provider', version: '1.0.0',
      accessProviders: { network: {
        title: 'Private network', icon: 'network', schemaVersion: 1,
        targets: ['machine'], capabilities: ['management', 'privateNetwork'], exposure: 'privateNetwork',
        configSchema: config.jsonSchema, inboundPorts: [], credentialPurposes: [],
        actions: { inspect: 'inspect', join: 'join', leave: 'leave' },
      } },
      actions: { inspect: role('inspect'), join: role('join'), leave: role('leave') },
    });
    expect(plugin.manifest.contributes?.accessProviders).toMatchObject([{ id: 'network', capabilities: ['management', 'privateNetwork'] }]);
  });
});
