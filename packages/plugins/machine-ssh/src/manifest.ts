import { definePlugin, PluginError, type DefinedPlugin } from '@happier-dev/plugin-sdk';
import type { ActionContract } from '@happier-dev/plugin-sdk/actions';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import {
    defineMachineProvisionerSchemas, MachineProvisionerBootstrapCarrierV1Schema,
    MachineProvisionerCheckResultV1Schema, MachineProvisionerPowerResultV1Schema, MachineProvisionerNativeExecResultV1Schema,
    MachineProvisionerNativeStreamResultV1Schema, MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
    MachineProvisionerPutFileResultV1Schema, type MachineProvisionerAuthorDefinitionV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import { REMOTE_HOST_SSH_PROVISIONER, SSH_PASSWORD_ENV } from '@happier-dev/plugin-sdk/machine-provisioners/ssh';

const identity = defineProtocolObject({ remoteHostId: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
export const ROLE_SCHEMAS = defineMachineProvisionerSchemas({ launch: identity, resource: identity });
const reference = { contributionRef: REMOTE_HOST_SSH_PROVISIONER, schemaVersion: 1 } as const;
export const SSH_CLIENT_TOOL_ID = 'ssh-client';
const processAccess = 'ssh-process';
const defaults = { scopes: ['machine'], surfaces: ['plugin'], execution: { target: 'daemon' } } as const;
const transport = { ...defaults, hostAccess: [processAccess], dangerLevel: 'writesRemote',
    confirmation: { title: 'Use this SSH host?', body: 'Happier uses the selected Remote Host to access this workspace.' } } as const;

export const binding = {
    title: 'SSH', icon: 'terminal', resourceKind: 'ssh-remote-host', schemaVersion: 1, enrollmentRole: 'server',
    kindTitle: 'Remote Host', description: 'Use folders on an existing SSH host.',
    launchSchema: identity.jsonSchema, resourceSchema: identity.jsonSchema, resourceIdPath: 'remoteHostId',
    platforms: ['darwin', 'linux', 'win32'], browserReachable: false,
    prerequisites: [{ kind: 'systemTool', id: SSH_CLIENT_TOOL_ID }, { kind: 'systemTool', id: 'scp' }],
    billing: { location: 'unknown', stoppedBilling: 'unknown' }, retention: { supportedIntents: [] },
    actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' },
    bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file', stream: 'stream' },
    workspaceAttachment: { when: { op: 'truthy', path: 'remoteHostId' }, optionsWhen: { op: 'truthy', path: 'remoteHostId' },
        resourceIdentityPaths: ['remoteHostId'], bootstrapCredential: { kind: 'remote-host-ssh', remoteHostIdPath: 'remoteHostId' } },
} satisfies MachineProvisionerAuthorDefinitionV1;

export function options({ remoteHostId }: ReturnType<typeof identity.parse>) {
    return { base: { launch: {} }, dimensions: { size: [], location: [], network: [], duration: [],
        image: [{ id: remoteHostId, title: 'SSH Remote Host', assignments: [{ path: 'remoteHostId', value: remoteHostId }] }] } };
}

export function acquire(input: Parameters<typeof ROLE_SCHEMAS.acquireInput.parse>[0]) {
    const { launch } = ROLE_SCHEMAS.acquireInput.parse(input);
    return { kind: 'bound' as const, resource: { ...reference, value: launch } };
}

export const PLUGIN: DefinedPlugin<
    typeof REMOTE_HOST_SSH_PROVISIONER.pluginId,
    Readonly<Record<string, ActionContract>>,
    Readonly<Record<string, readonly unknown[]>>
> = definePlugin({
    id: REMOTE_HOST_SSH_PROVISIONER.pluginId, version: '0.0.0', displayName: 'SSH workspaces', description: binding.description,
    entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
    systemTools: {
        [SSH_CLIENT_TOOL_ID]: { title: 'OpenSSH client', executableNames: ['ssh'] },
        scp: { title: 'OpenSSH file transfer', executableNames: ['scp'] },
    },
    hostAccess: { required: [{ id: processAccess, capability: 'process', reason: 'Use OpenSSH for the admitted Remote Host.',
        scope: { executables: [{ kind: 'systemTool', id: SSH_CLIENT_TOOL_ID }, { kind: 'systemTool', id: 'scp' }], envKeys: [SSH_PASSWORD_ENV, 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'DISPLAY'] },
    }], optional: [] },
    machineProvisioners: { [REMOTE_HOST_SSH_PROVISIONER.localId]: binding },
    actions: {
        check: { ...defaults, hostAccess: [processAccess], title: 'Check OpenSSH', dangerLevel: 'safe',
            inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
            async run(_input, context) {
                try {
                    await context.services.exec.systemTools.resolve({ toolId: SSH_CLIENT_TOOL_ID, purpose: 'Check for OpenSSH', signal: context.signal });
                    await context.services.exec.systemTools.resolve({ toolId: 'scp', purpose: 'Check for OpenSSH file transfer', signal: context.signal });
                    return { available: true };
                } catch { return { available: false, code: 'provider_unavailable' }; }
            } },
        options: { ...defaults, title: 'Select SSH Remote Host', dangerLevel: 'safe', inputSchema: identity,
            resultSchema: MachineProvisionerOptionsResultV1Schema, run: options },
        acquire: { ...defaults, title: 'Attach SSH Remote Host', dangerLevel: 'safe',
            inputSchema: ROLE_SCHEMAS.acquireInput, resultSchema: ROLE_SCHEMAS.acquireResult, run: acquire },
        bootstrap: { ...defaults, title: 'Prepare SSH transport', dangerLevel: 'safe',
            inputSchema: ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
            run: () => ({ kind: 'native' as const, transport: reference }) },
        inspect: { ...defaults, hostAccess: [processAccess], title: 'Inspect SSH attachment', dangerLevel: 'safe',
            inputSchema: ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
            async run(input, context) { return (await import('./transport.js')).inspectSsh(input, context); } },
        destroy: { ...defaults, title: 'Refuse SSH host deletion', dangerLevel: 'safe',
            inputSchema: ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerPowerResultV1Schema,
            run: () => ({ kind: 'refused' as const, code: 'native_intent_unsupported' }) },
        exec: { ...transport, title: 'Run SSH command', inputSchema: ROLE_SCHEMAS.execInput, resultSchema: MachineProvisionerNativeExecResultV1Schema,
            async run(input, context) {
                if (input.processConfig) throw new PluginError({ code: 'native_intent_unsupported' });
                return (await import('./transport.js')).runSshExec(input, context);
            } },
        'put-file': { ...transport, title: 'Write SSH guest file', inputSchema: ROLE_SCHEMAS.putFileInput, resultSchema: MachineProvisionerPutFileResultV1Schema,
            async run(input, context) { return (await import('./transport.js')).putSshFile(input, context); } },
        stream: { ...transport, title: 'Open SSH channel', inputSchema: ROLE_SCHEMAS.streamInput, resultSchema: MachineProvisionerNativeStreamResultV1Schema,
            async run(input, context) { return (await import('./transport.js')).streamSsh(input, context); } },
    },
});

export const PLUGIN_MANIFEST = PLUGIN.manifest;
