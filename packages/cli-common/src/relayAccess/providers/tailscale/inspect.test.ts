import { describe, expect, it } from 'vitest';
import { AccessProviderRoleResultV1Schema } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import type { TailscaleCommandRequest } from '../../../tailscale/commandRunner.js';
import { inspectBuiltinTailscaleAccessProvider } from './inspect.js';

function fixture(status: unknown, nativeScope = true) {
    const commands: TailscaleCommandRequest[] = [];
    return {
        commands,
        deps: {
            resolveCommandOnPath: () => '/fixture/tailscale',
            readNetworkInterfaces: () => nativeScope ? {
                'actual-vpn-9': [{ address: '100.92.0.7', family: 'IPv4' as const, internal: false }],
            } : {},
            runCommand: async (request: TailscaleCommandRequest) => {
                commands.push(request);
                return { command: request.command, args: request.args, exitCode: 0, stderr: '',
                    stdout: JSON.stringify(status) };
            },
        },
    };
}

const running = {
    BackendState: 'Running', HaveNodeKey: true, TUN: true,
    TailscaleIPs: ['100.92.0.7'], Self: { DNSName: 'host.example.ts.net.' },
    CurrentTailnet: { Name: 'example.ts.net', MagicDNSEnabled: false },
};

describe('built-in Tailscale native role observation', () => {
    it('projects the real native interface through the strict role consumer using only a status read', async () => {
        const f = fixture(running);
        const result = AccessProviderRoleResultV1Schema.parse(await inspectBuiltinTailscaleAccessProvider({}, f.deps));
        expect(result).toEqual({ kind: 'confirmed', facts: { state: 'ready', privateNetwork: {
            provider: { kind: 'builtin', id: 'tailscale' }, state: 'ready',
            networkIdentity: 'example.ts.net', displayName: 'example.ts.net',
            dnsName: 'host.example.ts.net', addresses: ['100.92.0.7'],
            interfaceName: 'actual-vpn-9', sourceRanges: ['100.64.0.0/10'], magicDnsEnabled: false,
        } } });
        expect(f.commands.map(command => command.args)).toEqual([['status', '--json']]);
    });

    it.each([
        ['Stopped', true, 'stopped'],
        ['NeedsLogin', false, 'needsAuth'],
    ] as const)('keeps %s distinct from a running network', async (backend, signedIn, state) => {
        const f = fixture({ BackendState: backend, HaveNodeKey: signedIn, TUN: true,
            ...(signedIn ? { TailscaleIPs: ['100.92.0.7'], CurrentTailnet: running.CurrentTailnet } : {}) });
        const result = AccessProviderRoleResultV1Schema.parse(await inspectBuiltinTailscaleAccessProvider({}, f.deps));
        expect(result).toMatchObject({ kind: 'confirmed', facts: { state, privateNetwork: {
            state, interfaceName: null, sourceRanges: [],
        } } });
    });

    it('retains readable membership while leaving unobserved native scope unknown', async () => {
        const f = fixture(running, false);
        const result = AccessProviderRoleResultV1Schema.parse(await inspectBuiltinTailscaleAccessProvider({}, f.deps));
        expect(result).toMatchObject({ kind: 'confirmed', facts: { state: 'ready', privateNetwork: {
            networkIdentity: 'example.ts.net', interfaceName: null, sourceRanges: [],
        } } });
    });

    it('preserves the native unavailable-daemon result without inventing a login requirement', async () => {
        const f = fixture(running);
        const result = await inspectBuiltinTailscaleAccessProvider({}, { ...f.deps,
            runCommand: async request => ({ command: request.command, args: request.args, exitCode: 1,
                stdout: '', stderr: 'failed to connect to local tailscaled' }),
        });
        expect(AccessProviderRoleResultV1Schema.parse(result)).toMatchObject({ kind: 'confirmed', facts: {
            state: 'unavailable', privateNetwork: { state: 'unavailable', networkIdentity: null,
                addresses: [], interfaceName: null, sourceRanges: [], magicDnsEnabled: null },
        } });
    });

    it('preserves the existing failure code and never returns native error contents', async () => {
        const f = fixture(running);
        const result = await inspectBuiltinTailscaleAccessProvider({}, { ...f.deps,
            runCommand: async () => { throw new Error('ENOENT secret=not-for-result'); },
        });
        expect(AccessProviderRoleResultV1Schema.parse(result)).toEqual({ kind: 'unknown', code: 'provider_not_installed' });
    });

    it('lets the operation cancellation propagate instead of converting it into an unknown observation', async () => {
        const controller = new AbortController();
        const cancelled = new Error('operation cancelled');
        const f = fixture(running);
        await expect(inspectBuiltinTailscaleAccessProvider({ signal: controller.signal }, { ...f.deps,
            runCommand: async () => { controller.abort(cancelled); throw cancelled; },
        })).rejects.toBe(cancelled);
    });
});
