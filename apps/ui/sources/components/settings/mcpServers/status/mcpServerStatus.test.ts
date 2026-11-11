import { describe, expect, it, vi } from 'vitest';
import { McpServerCatalogEntryV1Schema, type McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { SavedSecretCatalogEntryV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { materializeSavedSecretResources } from '@/sync/engine/settings/materializeSavedSecretResources';
import { SavedSecretSchema } from '@/sync/domains/settings/savedSecretTypes';
import { applySavedSecretCatalogPage, invalidateSavedSecretCatalog, resetSavedSecretCatalogSnapshotsForTests, resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';

import { pickMostBlockingCapabilityStatus, presentCapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';

import { mcpServerAttentionStatus, mcpServerMachineStatuses, mcpServerStatus, type McpServerStatusInput } from './mcpServerStatus';

const remote: McpServerCatalogEntryV1 = McpServerCatalogEntryV1Schema.parse({
    id: 'sentry', name: 'sentry', transport: 'http', env: {}, createdAt: 1, updatedAt: 1,
    remote: { url: 'https://mcp.sentry.dev/mcp', headers: {}, auth: { kind: 'oauth' } },
});
const local: McpServerCatalogEntryV1 = McpServerCatalogEntryV1Schema.parse({
    id: 'postgres', name: 'postgres', transport: 'stdio', createdAt: 1, updatedAt: 1,
    stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] },
    env: { DATABASE_URL: { t: 'template', template: 'postgres://app:{password}@db/app', vars: { password: { t: 'savedSecret', secretId: 'pg-pass' } } } },
});
const personalSecret = SavedSecretSchema.parse({ id: 'pg-pass', name: 'Postgres', kind: 'password',
    encryptedValue: { _isSecretValue: true, value: 'test-value' }, createdAt: 1, updatedAt: 1 });
const NO_SECRETS = { resolveReference: (ref: string) => resolveSavedSecretReference(null, [], ref) };

function input(overrides: Partial<McpServerStatusInput>): McpServerStatusInput {
    return {
        entry: local,
        signIn: null,
        tests: {},
        machines: [{ machineId: 'mbp', name: 'MacBook Pro', online: true }],
        savedSecretCatalog: { resolveReference: ref => resolveSavedSecretReference(null, [personalSecret], ref) },
        fixes: { signIn: vi.fn(), reconnect: vi.fn(), grantAccess: vi.fn(), addKey: vi.fn(), howToFix: vi.fn(), tryAgain: vi.fn() },
        ...overrides,
    };
}

const headline = (statuses: ReturnType<typeof mcpServerStatus>) => {
    const top = pickMostBlockingCapabilityStatus(statuses, 'row');
    return top ? presentCapabilityStatus(top, 'row').pill?.label ?? null : null;
};

describe('mcpServerStatus', () => {
    it('offers existing sign-in for an unmarked remote server challenged during Test', () => {
        const current = input({ entry: { ...remote, remote: { ...remote.remote!, auth: undefined } }, signIn: null,
            tests: { mbp: { ok: false, errorCode: 'mcp_sign_in_required', checkedAt: 1 } } });
        const status = mcpServerMachineStatuses(current).get('mbp');
        expect(status).toMatchObject({ kind: 'signin', fix: { kind: 'sign_in' } });
        status?.fix?.onPress();
        expect(current.fixes.signIn).toHaveBeenCalledOnce();
    });
    it('does not label an unobserved machine offline or reuse its previous test as a live failure', () => {
        const status = mcpServerMachineStatuses(input({
            machines: [{ machineId: 'unknown', name: 'Unknown machine', online: null }],
            tests: { unknown: { ok: false, errorCode: 'exited', checkedAt: 1 } },
        }));
        expect(status.has('unknown')).toBe(false);
    });
    it('lets current sign-in progress and a connected grant supersede an old sign-in-required Session notice', () => {
        const current = input({ entry: remote, sessionNotices: [{ v: 1, items: [
            { kind: 'mcp_server', itemId: remote.id, name: remote.name, code: 'mcp_sign_in_required' },
        ] }] });
        expect(pickMostBlockingCapabilityStatus(mcpServerStatus({ ...current, signIn: { state: 'signing' } }))?.kind).toBe('signing');
        expect(headline(mcpServerStatus({ ...current, signIn: { state: 'connected' } }))).toBeNull();
    });
    it('shows only this server\'s Session runtime failures, even when the Account Test passed', () => {
        const current = input({ entry: remote, signIn: { state: 'connected' },
            sessionNotices: [{ v: 1, items: [{ kind: 'mcp_server', itemId: remote.id, name: remote.name, code: 'spawn_failed' },
                { kind: 'mcp_server', itemId: 'other', name: 'other', code: 'other_failed' }] }],
            tests: { mbp: { ok: true, toolCount: 1, checkedAt: 1 } } });
        const failure = pickMostBlockingCapabilityStatus(mcpServerStatus(current));
        expect(failure).toMatchObject({ kind: 'error', machineName: 'MacBook Pro' });
        // A bare producer code is not words: the status says where it stopped, never "spawn_failed".
        expect(failure?.detail).toBeUndefined();
        failure?.fix?.onPress();
        expect(current.fixes.tryAgain).toHaveBeenCalledWith('mbp');
        expect(mcpServerStatus({ ...current, entry: local }).some(status => status.kind === 'error')).toBe(false);
    });
    it('reads a runtime notice\'s reason as the status it is: sign-in, a missing key, or words', () => {
        const notices = (detail: string) => [{ v: 1 as const, items: [{ kind: 'mcp_server' as const, itemId: remote.id, name: remote.name, code: 'mcp_unavailable', detail }] }];
        const signIn = mcpServerStatus(input({ entry: remote, sessionNotices: notices('mcp_sign_in_required') }));
        expect(pickMostBlockingCapabilityStatus(signIn)?.kind).toBe('signin');
        expect(mcpServerStatus(input({ entry: remote, signIn: { state: 'connected' }, sessionNotices: notices('mcp_sign_in_required') }))
            .some(status => status.kind === 'signin' || status.kind === 'error')).toBe(false);
        const key = input({ entry: remote, sessionNotices: notices('env:LINEAR_API_KEY') });
        const keyStatus = pickMostBlockingCapabilityStatus(mcpServerStatus(key));
        expect(keyStatus).toMatchObject({ kind: 'key', detail: 'LINEAR_API_KEY' });
        keyStatus?.fix?.onPress();
        expect(key.fixes.addKey).toHaveBeenCalled();
        const bridge = pickMostBlockingCapabilityStatus(mcpServerStatus(input({ entry: remote, sessionNotices: notices('remote bridge unavailable') })));
        expect(bridge?.kind).toBe('error');
        expect(bridge?.detail).not.toMatch(/_|:/);
    });
    it('uses Saved Secret catalog references and availability for direct and template bindings', async () => {
        const ref = formatSharedSavedSecretRefV1('bound-key');
        const entry = McpServerCatalogEntryV1Schema.parse({ ...local,
            env: { TOKEN: { t: 'savedSecret', secretId: ref } },
            transport: 'http', stdio: undefined,
            remote: { url: 'https://mcp.example.test', headers: { Authorization: {
                t: 'template', template: 'Bearer {key}', vars: { key: { t: 'savedSecret', secretId: ref } },
            } } },
        });
        const secret = SavedSecretCatalogEntryV1Schema.parse({ ref, source: 'shared_resource', relationship: 'owner',
            name: 'Existing key', kind: 'apiKey', revision: 1, materialStatus: 'ready',
            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } });
        const scope = { serverId: 'mcp-status', accountId: 'owner' };
        const produced = await materializeSavedSecretResources({ resources: [{ resourceId: 'bound-key',
            encryptionMode: 'plain', entry: secret, recipientEnvelope: null,
            storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'bound-key', mode: 'plain',
                content: { v: 1, name: 'Existing key', kind: 'apiKey', value: 'test-value' } }),
        }], decryptDataKeyEnvelope: async () => null });
        const available = {
            resolveReference: (reference: string) => resolveSavedSecretReference(scope, [], reference) };
        try {
            applySavedSecretCatalogPage({ scope, ...produced, observedAt: 1 });
            expect(headline(mcpServerStatus(input({ entry, savedSecretCatalog: available })))).toBeNull();
            // Metadata alone is not proof of usable material (e.g. a just-acknowledged resource).
            applySavedSecretCatalogPage({ scope, ...produced, materializedSecrets: [], observedAt: 2 });
            expect(headline(mcpServerStatus(input({ entry, savedSecretCatalog: available })))).toBe('Needs a key');
            for (const entries of [[], [{ ...secret, materialStatus: 'temporarily_unavailable' as const }],
                [{ ...secret, capabilities: { ...secret.capabilities, use: false } }]]) {
                applySavedSecretCatalogPage({ scope, ...produced, entries, observedAt: 3 });
                expect(headline(mcpServerStatus(input({ entry, savedSecretCatalog: available })))).toBe('Needs a key');
            }
            applySavedSecretCatalogPage({ scope, ...produced, observedAt: 4 });
            invalidateSavedSecretCatalog(scope);
            expect(headline(mcpServerStatus(input({ entry, savedSecretCatalog: available })))).toBe('Needs a key');
        } finally { resetSavedSecretCatalogSnapshotsForTests(); }
    });

    it('is quiet for a healthy server', () => {
        const statuses = mcpServerStatus(input({ tests: { mbp: { ok: true, toolCount: 41, checkedAt: 1 } } }));
        expect(headline(statuses)).toBeNull();
    });

    it('says each degraded state with its one fix', () => {
        expect(headline(mcpServerStatus(input({ entry: remote, signIn: { state: 'not_connected' } })))).toBe('Needs sign-in');
        expect(headline(mcpServerStatus(input({ entry: remote, signIn: { state: 'needs_more_access' } })))).toBe('Needs more access');
        const expired = mcpServerStatus(input({ entry: remote, signIn: { state: 'expired', reason: 'expired', at: 'Oct 10' } }));
        expect(pickMostBlockingCapabilityStatus(expired)).toMatchObject({ kind: 'expired', detail: 'Oct 10', fix: { kind: 'reconnect' } });
        expect(headline(mcpServerStatus(input({ savedSecretCatalog: NO_SECRETS })))).toBe('Needs a key');
        expect(headline(mcpServerStatus(input({ tests: { mbp: { ok: false, errorCode: 'spawn_failed', runtimeMissing: 'uv', checkedAt: 1 } } }))))
            .toBe('Can’t run on MacBook Pro');
        expect(headline(mcpServerStatus(input({ tests: { mbp: { ok: false, errorCode: 'exited', checkedAt: 1 } } })))).toBe('Stopped on MacBook Pro');
        expect(headline(mcpServerStatus(input({ machines: [{ machineId: 'win', name: 'Windows desktop', online: false, lastSeen: 'Oct 9' }] }))))
            .toBe('Offline');
    });

    it('lets the more blocking problem lead when there are two', () => {
        const statuses = mcpServerStatus(input({
            savedSecretCatalog: NO_SECRETS,
            machines: [
                { machineId: 'mbp', name: 'MacBook Pro', online: true },
                { machineId: 'win', name: 'Windows desktop', online: false },
            ],
            tests: { mbp: { ok: false, errorCode: 'exited', checkedAt: 1 } },
        }));
        expect(pickMostBlockingCapabilityStatus(statuses)?.kind).toBe('error');
        const keyOverOffline = mcpServerStatus(input({ savedSecretCatalog: NO_SECRETS, machines: [{ machineId: 'win', name: 'Windows desktop', online: false }] }));
        expect(pickMostBlockingCapabilityStatus(keyOverOffline)?.kind).toBe('key');
    });

    it('keys machine statuses by machine id, so two machines with one name stay apart', () => {
        const byMachine = mcpServerMachineStatuses(input({
            machines: [{ machineId: 'a', name: 'nl2', online: true }, { machineId: 'b', name: 'nl2', online: true }],
            tests: { b: { ok: false, errorCode: 'exited', checkedAt: 1 } },
        }));
        expect(byMachine.has('a')).toBe(false);
        expect(byMachine.get('b')?.kind).toBe('error');
    });
});

describe('mcpServerAttentionStatus', () => {
    const catalog = { resolveReference: (ref: string) => resolveSavedSecretReference(null, [], ref) };
    const attention = (entry: McpServerCatalogEntryV1, signIn: McpServerStatusInput['signIn']) =>
        mcpServerAttentionStatus({ entry, signIn, savedSecretCatalog: catalog });

    it('names what blocks a sign-in server in the page\'s own vocabulary, with its time', () => {
        expect(attention(remote, { state: 'not_connected' })?.kind).toBe('signin');
        expect(attention(remote, { state: 'no_machine_online' })?.kind).toBe('signin');
        expect(attention(remote, { state: 'revoked' })?.kind).toBe('revoked');
        expect(attention(remote, { state: 'expired', reason: 'expired', at: 'Oct 10' })).toEqual({ kind: 'expired', detail: 'Oct 10' });
    });
    it('stays quiet while signing in or connected, and for a server that does not sign in', () => {
        expect(attention(remote, { state: 'signing' })).toBeNull();
        expect(attention(remote, { state: 'connected' })).toBeNull();
        expect(attention({ ...local, env: {} }, null)).toBeNull();
    });
    it('a missing Saved Secret is a key status, drawn fix-less (the list action column owns the fix)', () => {
        const status = attention(local, null);
        expect(status).toEqual({ kind: 'key' });
    });
});
