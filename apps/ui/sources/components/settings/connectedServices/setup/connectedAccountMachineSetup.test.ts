import { describe, expect, it } from 'vitest';
import type { PluginConnectedAccountMachineSetupV1 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { MachineReachabilityObservationV1, MachinePrivateNetworkObservationV1 } from '@happier-dev/protocol/machines/reachability/machineReachabilityPostureV1';
import type { PluginJsonValueV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';

import {
    createConnectedAccountMachineSetupDraft,
    prefillConnectedAccountMachineSetupDraft,
    resolveAfterApplyConfiguration,
} from './connectedAccountMachineSetup';

const declaration = {
    title: 'Install Coder on a Machine',
    recipe: { pluginId: 'happier.machine.recipes', recipeId: 'coder', revision: '1' },
    inputPrefill: [{ path: 'network.accessUrl', source: { kind: 'privateNetworkHttps', provider: { kind: 'builtin', id: 'tailscale' } } }],
    afterApply: { modeId: 'first-admin', configurationFromInputs: { endpoint: 'network.accessUrl' } },
} satisfies PluginConnectedAccountMachineSetupV1;

const network: MachinePrivateNetworkObservationV1 = {
    provider: { kind: 'builtin', id: 'tailscale' }, state: 'ready', dnsName: 'workstation.example.ts.net',
    networkIdentity: 'tailnet', displayName: 'Tailnet', addresses: ['100.64.0.10'],
    interfaceName: 'tailscale0', sourceRanges: ['100.64.0.0/10'], magicDnsEnabled: true,
};

function observation(privateNetworks: MachinePrivateNetworkObservationV1[]): MachineReachabilityObservationV1 {
    return { revision: 1, management: { daemon: 'ready', providers: [], publicSsh: 'closed' }, privateNetworks, ingress: [] };
}

function setup(inputs: Record<string, PluginJsonValueV2>): MachineSetupV1 {
    return { items: [{ kind: 'setupRecipe', selection: { ref: declaration.recipe, inputs } }] };
}

describe('connected account Machine setup draft', () => {
    it('prefills the declared recipe input with the ready matching private-network HTTPS origin', () => {
        expect(createConnectedAccountMachineSetupDraft(declaration, observation([network]))).toEqual(
            setup({ network: { accessUrl: 'https://workstation.example.ts.net' } }),
        );
    });

    it.each([
        ['no observation', null],
        ['no private network', observation([])],
        ['no observed DNS', observation([{ ...network, dnsName: null }])],
        ['unavailable provider', observation([{ ...network, state: 'unavailable' }])],
        ['another built-in provider', observation([{ ...network, provider: { kind: 'builtin', id: 'other' } }])],
        ['a contributed provider with a similar name', observation([{ ...network, provider: { pluginId: 'example.network', localId: 'tailscale' } }])],
        ['ambiguous matching networks', observation([network, { ...network, dnsName: 'other.example.ts.net' }])],
    ] as const)('leaves the input empty for %s instead of guessing a hostname', (_reason, facts) => {
        expect(createConnectedAccountMachineSetupDraft(declaration, facts)).toEqual(setup({}));
    });

    it.each(['', 'not a hostname', 'https://workstation.example.ts.net', 'workstation.example.ts.net/path',
        'person@workstation.example.ts.net', 'workstation.example.ts.net:443', '*.example.ts.net'])('does not prefill malformed observed DNS %j', dnsName => {
        expect(createConnectedAccountMachineSetupDraft(declaration, observation([{ ...network, dnsName }]))).toEqual(setup({}));
    });

    it('uses only explicitly declared prefill without adding recipe or authentication defaults', () => {
        expect(createConnectedAccountMachineSetupDraft({ ...declaration, inputPrefill: undefined }, observation([network]))).toEqual(setup({}));
    });

    it('fills an absent input after Network facts arrive, preserving the rest of the draft', () => {
        const draft = setup({ name: 'my-coder', network: { exposure: 'public' } });
        expect(prefillConnectedAccountMachineSetupDraft(declaration, draft, observation([network]))).toEqual(
            setup({ name: 'my-coder', network: { exposure: 'public', accessUrl: 'https://workstation.example.ts.net' } }),
        );
        expect(draft).toEqual(setup({ name: 'my-coder', network: { exposure: 'public' } }));
    });

    it.each(['https://coder.example.com', ''])('preserves the user-entered endpoint %j when Network facts arrive', accessUrl => {
        const draft = setup({ network: { accessUrl } });
        expect(prefillConnectedAccountMachineSetupDraft(declaration, draft, observation([network]))).toBe(draft);
    });
});

describe('Machine setup configuration handoff', () => {
    it('maps the reviewed public endpoint from its declared nested input path without copying other inputs', () => {
        expect(resolveAfterApplyConfiguration(declaration, setup({
            network: { accessUrl: 'https://coder.example.com' }, password: 'recipe-only-value', unrelated: true,
        }))).toEqual({ endpoint: 'https://coder.example.com' });
    });

    it('does not hand off missing inputs or an unrelated recipe, kind, or revision', () => {
        expect(resolveAfterApplyConfiguration(declaration, setup({}))).toEqual({});
        const inputs = { network: { accessUrl: 'https://other.example.com' } };
        for (const item of [
            { kind: 'softwareRecipe' as const, selection: { ref: declaration.recipe, inputs } },
            { kind: 'setupRecipe' as const, selection: { ref: { ...declaration.recipe, revision: '2' }, inputs } },
            { kind: 'setupRecipe' as const, selection: { ref: { ...declaration.recipe, pluginId: 'other.recipes' }, inputs } },
            { kind: 'setupRecipe' as const, selection: { ref: { ...declaration.recipe, recipeId: 'other' }, inputs } },
        ]) expect(resolveAfterApplyConfiguration(declaration, { items: [item] })).toEqual({});
    });
});
