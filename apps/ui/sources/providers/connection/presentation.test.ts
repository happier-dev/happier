import { describe, expect, it } from 'vitest';
import { DaemonProviderConnectionViewV1Schema } from '@happier-dev/protocol/rpc';

import { presentProviderConnection, presentProviderConnectionIdentity } from './presentation';
import { providerModelConnectionTitle } from '@/providers/models/providerModelConnectionTitle';

const base = DaemonProviderConnectionViewV1Schema.parse({
    connectionId: 'pc_a', contributionKey: 'acme/a', displayName: 'Acme', providerName: 'Acme', icon: null,
    role: 'default' as const, displayNameMode: 'automatic' as const, sourceStatus: 'available' as const,
    grants: { accountEnabled: true, enabledMachineIds: [] }, scope: 'account' as const,
    probeCapability: 'none' as const, manualModelPolicy: 'allowed' as const, compatibility: [],
    credential: null,
    endpoints: [],
    authorized: true, authorizationError: null, revision: 0,
    runtime: { health: 'available' as const, modelCount: 3, checkedAt: 1 },
});

describe('provider connection presentation', () => {
    it('names a source once when its connection name already says its provider', () => {
        const identity = (displayName: string) => presentProviderConnectionIdentity({
            providerName: 'Vercel AI Gateway', displayName, role: 'named', displayNameMode: 'custom',
        }).sourceLabel;
        expect(identity('Work Vercel AI Gateway')).toBe('Work Vercel AI Gateway');
        expect(identity('Work')).toBe('Vercel AI Gateway · Work');
    });

    it.each([
        { accountEnabled: true, enabledMachineIds: [] },
        { accountEnabled: false, enabledMachineIds: ['another-machine'] },
    ])('keeps connection enablement distinct from inspected-machine access and idle custody: %j', (grants) => {
        const presentation = presentProviderConnection({ ...base,
            grants: { ...base.grants, ...grants, effectiveState: 'absent', machineState: 'absent' },
            authorized: false,
            runtime: { ...base.runtime, health: 'not_checked', gateway: { status: 'idle', reachability: 'not_checked' } },
        });
        expect(presentation).toMatchObject({ enabled: true, status: 'notChecked' });
        expect(presentProviderConnection({ ...base,
            grants: { ...base.grants, accountEnabled: false, enabledMachineIds: [] },
        })).toMatchObject({ enabled: false, status: 'disabled' });
    });

    it('collapses only one automatic default to the provider name', () => {
        expect(presentProviderConnection(base).title).toBe('Acme');
        expect(presentProviderConnection({ ...base, role: 'named', displayName: 'Work' }).subtitle)
            .toContain('Acme');
        expect(providerModelConnectionTitle({ providerName: 'OpenRouter', connectionName: 'Old display name',
            connectionRole: 'default', connectionDisplayNameMode: 'automatic' })).toBe('OpenRouter');
    });

    it('keeps a custom source identity once while distinguishing separately named connections', () => {
        const custom = { ...base, role: 'named' as const, displayNameMode: 'custom' as const };
        expect(presentProviderConnection(custom)).toMatchObject({ title: 'Acme', subtitle: '' });
        expect(providerModelConnectionTitle({ providerName: 'Acme', connectionName: 'Acme',
            connectionRole: 'named', connectionDisplayNameMode: 'custom' })).toBe('Acme');
        expect(providerModelConnectionTitle({ providerName: 'QA custom live', connectionName: ' qa custom live ',
            connectionRole: 'named', connectionDisplayNameMode: 'custom' })).toBe('QA custom live');
        expect(providerModelConnectionTitle({ providerName: 'Acme', connectionName: 'Work',
            connectionRole: 'named', connectionDisplayNameMode: 'custom' })).toBe('Acme · Work');
        expect(providerModelConnectionTitle({ providerName: 'OpenRouter', connectionName: 'Work',
            connectionRole: 'named', connectionDisplayNameMode: 'custom' })).toBe('OpenRouter · Work');
        expect(presentProviderConnection({ ...custom, displayName: 'Work' })).toMatchObject({ title: 'Work', subtitle: 'Acme' });
    });

    it('keeps source availability and endpoint health distinct', () => {
        expect(presentProviderConnection({ ...base, sourceStatus: 'unavailable' }).status).toBe('sourceUnavailable');
        expect(presentProviderConnection({
            ...base, authorized: false,
            authorizationError: { v: 1, code: 'provider_endpoint_unreachable', retryable: true, action: 'retry' },
        }).status).toBe('unreachable');
        expect(presentProviderConnection({
            ...base, runtime: { ...base.runtime, health: 'partial' },
        }).status).toBe('partial');
    });
});
