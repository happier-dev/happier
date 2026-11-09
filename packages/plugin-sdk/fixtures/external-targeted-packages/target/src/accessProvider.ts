import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { defineAccessProviderSchemas, type AccessProviderRoleResultV1 } from '@happier-dev/plugin-sdk/access-providers';

const config = defineProtocolObject({ managementUrl: defineProtocolString() }, { policy: 'closed' });
const schemas = defineAccessProviderSchemas({ config });
const unavailable = async (): Promise<AccessProviderRoleResultV1> => ({ kind: 'unknown', code: 'native_adapter_unavailable' });

/** Independent author package: native I/O is deliberately absent from this fixture. */
export const accessProviderAuthorFixture = definePlugin({
  id: 'examples.access-provider', version: '1.0.0',
  accessProviders: { network: {
    title: 'Private network', icon: 'network', schemaVersion: 1,
    targets: ['machine'], capabilities: ['management', 'privateNetwork'], exposure: 'privateNetwork',
    configSchema: config.jsonSchema, inboundPorts: [],
    credentialPurposes: [{ purpose: 'network.join', required: true }],
    actions: { inspect: 'inspect', join: 'join', leave: 'leave' },
  } },
  actions: {
    inspect: { title: 'Inspect', surfaces: ['plugin'], execution: { target: 'daemon' }, dangerLevel: 'safe',
      inputSchema: schemas.inspectInput, resultSchema: schemas.result, run: unavailable },
    join: { title: 'Join', surfaces: ['plugin'], execution: { target: 'daemon' }, dangerLevel: 'externalSideEffect',
      inputSchema: schemas.joinInput, resultSchema: schemas.result,
      run: async input => {
        const endpoint: string = input.config.managementUrl;
        const admittedFile: string | undefined = input.setupCredentialFile;
        void endpoint;
        void admittedFile;
        return unavailable();
      } },
    leave: { title: 'Leave', surfaces: ['plugin'], execution: { target: 'daemon' }, dangerLevel: 'externalSideEffect',
      inputSchema: schemas.leaveInput, resultSchema: schemas.result, run: unavailable },
  },
});
