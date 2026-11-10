import { describe, expect, it } from 'vitest';
import { MachineSetupApplyInputV1Schema, MachineSetupApplyResultV1Schema, MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { HostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/types';
import type { MachinePrivateNetworkObservationV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { computeSshHostKeyFingerprint } from '@happier-dev/protocol/ssh/hostTrust';
import { projectBackupReceiverResults } from '@/machines/setup/backupReceiverResult';
import { createSavedSecretsCliHttpFixture } from '@/cli/actions/adapters/savedSecretsCliHttpFixture';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { prepareBackupAnotherMachineForHost } from './anotherMachineForHost';

const senderIdentity = { publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJXmQhNPw7NtvqN7BA5pjk3OmlG6GgD2uXfMWLNa7z5h',
    sshPrivateKey: { kind: 'secret' as const, ref: 'happier:shared-secret:v1:sender-key', resourceRevision: 1 },
    repositoryPassword: { kind: 'secret' as const, ref: 'happier:shared-secret:v1:repository-password', resourceRevision: 1 } };
const setup = { kind: 'anotherMachine' as const, machineId: 'receiver', expectedInstallationId: 'receiver-installation',
    receiverInputs: { username: 'archive', chrootPath: '/srv/archive', repositoryPath: '/srv/archive/repository',
        endpoint: { host: '100.100.1.2', port: 2222 }, connection: { host: 'sender', address: '100.100.1.1' },
        administrator: { username: 'root', host: 'administrator', address: '100.100.1.3' }, sshServiceUnit: 'ssh.service' }, senderIdentity };
const existing = { kind: 'direct' as const, setup: { scripts: [{ body: 'echo retained' }] } };
const network: MachinePrivateNetworkObservationV1 = { provider: { pluginId: 'happier.access.tailscale', localId: 'tailscale' },
    networkIdentity: 'private-network', displayName: null, dnsName: null, addresses: ['100.100.1.2'], state: 'ready',
    interfaceName: null, sourceRanges: [], magicDnsEnabled: null };
const host = { name: 'Backup', audience: {}, expectedScopeKey: 'account', signal: new AbortController().signal,
    readCredentials: async () => null, sourceMachineId: 'sender',
    readMachinePrivateNetworks: async (machineId: string) => ({ installationId: machineId === 'receiver'
        ? setup.expectedInstallationId : 'sender-installation', networks: [network] }) };
const plan = (sources = [existing]) => MachineSetupPlanResultV1Schema.parse({ desiredRevision: 1, sources,
    exclusions: [], support: [], recipePlans: [], backupReceivers: [{ sourceIndex: 0, itemIndex: 0,
        machineId: setup.machineId, installationId: setup.expectedInstallationId, status: 'unavailable', reason: 'host_key_unreadable' }] });

describe('Another Machine configuration through existing Setup children', () => {
    it('refuses the actual source Machine as receiver before custody or setup effects', async () => {
        const fixture = await createSavedSecretsCliHttpFixture();
        const requests: Parameters<HostReviewedChildPortV1['invoke']>[0][] = [];
        const invoke: HostReviewedChildPortV1['invoke'] = async request => {
            requests.push(request);
            return request.action === 'machines.setup.plan' ? { ok: true, result: plan() }
                : { ok: true, result: { operationId: 'receiver-operation' } };
        };
        try {
            const credentials = await fixture.deps.readCredentialsFn?.();
            if (!credentials) throw new Error('Fixture credentials unavailable');
            const candidate = { kind: setup.kind, machineId: setup.machineId,
                expectedInstallationId: setup.expectedInstallationId, receiverInputs: setup.receiverInputs };
            const result = await fixture.inHome(() => prepareBackupAnotherMachineForHost({ serverId: 'home', setup: candidate,
                context: { surface: 'agent', hostReviewedChild: { invoke } } }, { ...host,
                    sourceMachineId: setup.machineId, expectedScopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
                    readCredentials: async () => credentials }));
            expect(fixture.writes.length).toBe(0);
            expect(requests.length).toBe(0);
            expect(result).toMatchObject({ status: 'partial', errorCode: 'invalid_parameters' });
        } finally { await fixture.close(); }
    });

    it('retains existing setup, sends only the public key and uses settled SFTP-visible receiver facts', async () => {
        const requests: Parameters<HostReviewedChildPortV1['invoke']>[0][] = [];
        const invoke: HostReviewedChildPortV1['invoke'] = async request => {
            requests.push(request);
            if (request.action === 'machines.setup.plan') {
                const input = request.input as Record<string, unknown>;
                return { ok: true, result: plan(input.sources as typeof existing[] | undefined) };
            }
            const input = MachineSetupApplyInputV1Schema.parse(request.input);
            const backupReceivers = projectBackupReceiverResults({ machineId: setup.machineId,
                installationId: setup.expectedInstallationId,
                recipes: input.targets[0]!.sources.flatMap((source, sourceIndex) => (source.setup.items ?? [])
                    .flatMap((item, itemIndex) => item.kind === 'app' ? [] : [{ sourceIndex, itemIndex,
                        selection: item.selection, evidence: { status: 'ready' as const, publicKey: senderIdentity.publicKey,
                            fingerprint: computeSshHostKeyFingerprint(senderIdentity.publicKey.split(' ')[1]!) } }])) });
            return { ok: true, result: MachineSetupApplyResultV1Schema.parse({ operationId: 'receiver-operation',
                runId: 'receiver-run', backupReceivers }) };
        };
        const result = await prepareBackupAnotherMachineForHost({ serverId: 'home', setup,
            context: { surface: 'agent', hostReviewedChild: { invoke } } }, host);
        expect(result).toMatchObject({ status: 'ready', senderIdentity, setupOperation: { operationId: 'receiver-operation', runId: 'receiver-run' },
            config: { host: '100.100.1.2', port: 2222, username: 'archive', path: '/repository' } });
        const reviewed = requests.find(request => request.action === 'machines.setup.plan' && 'sources' in (request.input as object));
        expect(reviewed?.input).toMatchObject({ sources: [{ kind: 'direct', setup: { scripts: existing.setup.scripts,
            items: [{ kind: 'setupRecipe', selection: { inputs: { senderPublicKey: senderIdentity.publicKey } } }] } }] });
        expect(JSON.stringify(requests)).not.toContain(senderIdentity.sshPrivateKey.ref);
        expect(JSON.stringify(requests)).not.toContain(senderIdentity.repositoryPassword.ref);
    });

    it('retains sender refs and setup operation when a settled receiver has no host-key evidence', async () => {
        const invoke: HostReviewedChildPortV1['invoke'] = async request => request.action === 'machines.setup.plan'
            ? { ok: true, result: plan() } : { ok: true, result: { operationId: 'receiver-operation', runId: 'receiver-run' } };
        expect(await prepareBackupAnotherMachineForHost({ serverId: 'home', setup,
            context: { surface: 'ui', hostReviewedChild: { invoke } } }, host)).toMatchObject({ status: 'partial',
                errorCode: 'receiver_evidence_unavailable', senderIdentity, setupOperation: { operationId: 'receiver-operation', runId: 'receiver-run' } });
    });

    it('does not apply setup after the selected receiving installation changes', async () => {
        const requests: Parameters<HostReviewedChildPortV1['invoke']>[0][] = [];
        const invoke: HostReviewedChildPortV1['invoke'] = async request => {
            requests.push(request);
            return { ok: true, result: { ...plan(), backupReceivers: [{ sourceIndex: 0, itemIndex: 0,
                machineId: setup.machineId, installationId: 'another-installation', status: 'unavailable', reason: 'host_key_unreadable' }] } };
        };
        expect(await prepareBackupAnotherMachineForHost({ serverId: 'home', setup,
            context: { surface: 'agent', hostReviewedChild: { invoke } } }, host)).toMatchObject({ status: 'partial',
                errorCode: 'receiver_installation_changed', senderIdentity });
        expect(requests.some(request => request.action === 'machines.setup.apply')).toBe(false);
    });

    it('retains the ordinary setup links and actual failure when receiver apply fails', async () => {
        const invoke: HostReviewedChildPortV1['invoke'] = async request => request.action === 'machines.setup.plan'
            ? { ok: true, result: plan() } : { ok: false, errorCode: 'machine_setup_child_failed', error: 'Receiver setup failed',
                details: { setupOperation: { operationId: 'receiver-operation', runId: 'receiver-run' } } };
        expect(await prepareBackupAnotherMachineForHost({ serverId: 'home', setup,
            context: { surface: 'agent', hostReviewedChild: { invoke } } }, host)).toMatchObject({ status: 'partial',
                errorCode: 'machine_setup_child_failed', senderIdentity,
                setupOperation: { operationId: 'receiver-operation', runId: 'receiver-run' } });
    });

    it.each([
        { name: 'no ready observations', sender: [], receiver: [] },
        { name: 'different network identities', sender: [network], receiver: [{ ...network, networkIdentity: 'another-network' }] },
        { name: 'unknown network identities', sender: [{ ...network, networkIdentity: null }],
            receiver: [{ ...network, networkIdentity: null }] },
        { name: 'different providers', sender: [network], receiver: [{ ...network,
            provider: { pluginId: 'happier.access.netbird', localId: 'netbird' } }] },
        { name: 'unobserved endpoint', sender: [network], receiver: [{ ...network, addresses: ['100.100.1.9'] }] },
    ])('does not start receiver setup for $name', async ({ sender, receiver }) => {
        const requests: Parameters<HostReviewedChildPortV1['invoke']>[0][] = [];
        const invoke: HostReviewedChildPortV1['invoke'] = async request => { requests.push(request); return { ok: true, result: plan() }; };
        expect(await prepareBackupAnotherMachineForHost({ serverId: 'home', setup,
            context: { surface: 'agent', hostReviewedChild: { invoke } } }, { ...host,
            readMachinePrivateNetworks: async machineId => ({ installationId: machineId === 'receiver'
                ? setup.expectedInstallationId : 'sender-installation', networks: machineId === 'receiver' ? receiver : sender }) })).toMatchObject({
                    status: 'partial', errorCode: 'no_shared_private_network', senderIdentity });
        expect(requests).toEqual([]);
    });
});
