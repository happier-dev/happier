import { expect, it } from 'vitest';
import { MachineRecipeV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { machineSecretGrantSubjectKey } from '@happier-dev/deployment-protocol';
import type { AccessProviderSelectionV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { createMachineSetupNativeBackend } from '@happier-dev/cli-common/machineSetup';
import { reachabilityConnectorSubject } from '../reachability/prepareReachabilityJoinCredential';
import { prepareMachineRecipeProgramV1 } from './prepareMachineRecipeProgram';

it('compiles a reference-only credential selection to the installed connector subject and native file path without acquiring secret bytes', async () => {
    const selection = { provider: { kind: 'builtin', id: 'tailscale' }, config: {}, credentialRefs: [
        { purpose: 'network.join', credentialRef: { kind: 'savedSecret', ref: 'happier:shared-secret:v1:join-key', resourceRevision: 3 } },
    ] } satisfies AccessProviderSelectionV1;
    const declaration = { id: 'cold-join', revision: '1', title: 'Cold join',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [
            { id: 'key', kind: 'file', path: { kind: 'targetFact', fact: 'invocation.credentialFile' },
                owner: 'root', group: 'root', mode: 0o600, lifetime: 'invocation',
                content: { kind: 'secretGrant', credentialSelection: { provider: selection.provider, config: selection.config,
                    credentialRefs: [{ purpose: 'network.join', credentialRef: { kind: 'savedSecret',
                        ref: { kind: 'input', path: 'joinCredential.ref' },
                        resourceRevision: { kind: 'input', path: 'joinCredential.resourceRevision' } } }] } } },
            { id: 'join', kind: 'command', executable: 'tailscale', args: ['up', { kind: 'template', value: '--auth-key=file:{path}',
                variables: { path: { kind: 'targetFact', fact: 'invocation.credentialFile' } } }],
                check: { executable: 'tailscale', args: ['status'], unsatisfiedExitCodes: [1] } },
        ] };
    const recipe = MachineRecipeV1Schema.parse(declaration);
    const joinCredential = { ref: selection.credentialRefs[0].credentialRef.ref, resourceRevision: 3 };
    const selections: AccessProviderSelectionV1[] = [];
    const backend = createMachineSetupNativeBackend({ platform: 'linux', async run(command) {
        if (command.executable === 'getent') return { code: 0, stdout: command.args.includes('passwd')
            ? 'root:x:0:0::/root:/bin/sh\n' : 'root:x:0:\n', stderr: '' };
        return { code: 1, stdout: '', stderr: '' };
    } });
    const plan = await prepareMachineRecipeProgramV1({ machineId: 'machine', installationId: 'installation', desiredRevision: 1,
        recipe, program: 'steps', inputs: { joinCredential }, backend,
        onCredentialSelection: selected => { selections.push(selected); } });
    const path = '/run/happier-machine-credentials/installation.setup-key';
    expect(plan?.steps).toMatchObject([
        { path, content: { kind: 'secretGrant', grantRef: machineSecretGrantSubjectKey(reachabilityConnectorSubject(selection,
            { machineId: 'machine', installationId: 'installation' })) } },
        { args: ['up', `--auth-key=file:${path}`] },
    ]);
    expect(selections).toEqual([selection]);
    expect(JSON.stringify(plan?.steps)).not.toContain('join-key');
    expect(MachineRecipeV1Schema.safeParse({ ...declaration, steps: [{ ...declaration.steps[0], content: {
        kind: 'secretGrant', credentialSelection: { kind: 'input', path: 'joinSelection' }, grantRef: 'caller-grant',
    } }] }).success).toBe(false);
    await expect(prepareMachineRecipeProgramV1({ machineId: 'machine', desiredRevision: 1, recipe, program: 'steps',
        inputs: { joinCredential }, backend })).rejects.toMatchObject({ code: 'machine_recipe_target_fact_unavailable' });
    await expect(prepareMachineRecipeProgramV1({ machineId: 'machine', installationId: 'installation', desiredRevision: 1,
        recipe, program: 'steps', inputs: { joinCredential: { ...joinCredential,
            ref: { kind: 'input', path: 'anotherCredential.ref' } }, anotherCredential: joinCredential }, backend,
    })).rejects.toMatchObject({ code: 'invalid_machine_recipe_inputs' });
});
