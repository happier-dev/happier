import { afterAll, beforeAll, expect, it } from 'vitest';
import { prepareExternalActionResponseEnvelopeV1 } from '@happier-dev/protocol/actions';
import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { checkMachineSetupEffectPlan, createNativeCaddySetupInput } from '@happier-dev/cli-common/machineSetup';
import { machineNativeEffectAdmission } from '../../../../../../cli/src/daemon/local/services/launch/machineNativeEffectAdmission';
import { settleMachineCaddyFirewallForHost } from '../../../../../../cli/src/machines/reachability/machineReachabilityHost';
import { observeOwnDaemonReachability } from '../../../../../../cli/src/machines/reachability/observeOwnDaemonReachability';
import { MachineEffectInternalRequestSchema } from '../../../../../../cli/src/machines/setup/effectInternalProtocol';
import type { MachineElevationSpawn } from '../../../../../../cli/src/machines/adminAccess/runElevatedEffect';

// The privileged OS process is the boundary. Keep the real CHECK/APPLY stream,
// daemon observation, rollback settlement and Domain presenter beneath HTTP.
const spawn: MachineElevationSpawn = () => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const settled = (async () => {
        const lines = createInterface({ input: stdin });
        try {
            const frames = lines[Symbol.asyncIterator]();
            stdout.write('{"type":"ready"}\n');
            const request = MachineEffectInternalRequestSchema.parse(JSON.parse((await frames.next()).value!));
            if (request.mode !== 'check' || !('firewallIntent' in request)) throw new Error('Expected firewall CHECK');
            const plan = await checkMachineSetupEffectPlan({ basis: request.basis,
                steps: [{ id: 'firewall', kind: 'firewall', rules: 'table inet happier {}' }],
                backend: { async observe(step) { return { stepId: step.id, status: 'drifted', facts: {} }; },
                    async apply() { throw new Error('OS boundary supplies the APPLY result'); } } });
            stdout.write(JSON.stringify({ type: 'result', result: { status: 'checked', plans: [{ plan }, { plan }] } }) + '\n');
            await frames.next();
            stdout.write(JSON.stringify({ type: 'progress', stepId: 'firewall', phase: 'apply', status: 'started' }) + '\n');
            const recovery = { rules: { kind: 'absent' }, unit: { kind: 'absent' }, table: null,
                boot: { present: false, enabled: false, running: false } };
            stdout.write(JSON.stringify({ type: 'firewall.staged', planIndex: 0, planDigest: plan.planDigest, recovery }) + '\n');
            expect(JSON.parse((await frames.next()).value!)).toMatchObject({ type: 'firewall.settle', decision: 'undo' });
            stdout.write(JSON.stringify({ type: 'result', result: { status: 'cancelled', completedStepIds: ['firewall'],
                daemonRestartRequired: false, restoration: { status: 'verified', recovery } } }) + '\n');
            return { code: 1, signal: null };
        } finally { lines.close(); stdout.end(); stderr.end(); }
    })();
    return { stdin, stdout, stderr, settled, terminate: async () => { stdin.destroy(); await settled; } };
};

let database: LightSqliteHarness;
beforeAll(async () => {
    database = await createLightSqliteHarness({ tempDirPrefix: 'happier-domain-action-result-',
        env: { HAPPIER_FEATURE_DEPLOYMENTS__ENABLED: '1' } });
});
afterAll(async () => { await database?.close(); });

it('preserves the missing Home-routed daemon ACK in the public Domain action response', async () => {
    const failure = { kind: 'daemon_reachability_unavailable', reason: 'required_fact_unavailable',
        requiredFact: 'homeRoutedDaemonAck' };
    // HTTP dispatch stands in for the network hop to the guest. The guest's
    // actual Domain settlement runs here, rather than supplying a canned error.
    const app = createAuthenticatedTestApp();
    registerExternalActionRoutes(app, { dispatch: async request => {
        try {
            await machineNativeEffectAdmission.run({ operation: { operationId: 'domain-daemon-ack', kind: request.actionId },
                keys: [{ kind: 'machineSetup' }] }, native => settleMachineCaddyFirewallForHost({
                machineId: 'machine-1', installationId: 'installed-1', operationId: 'domain-daemon-ack', native,
                basis: { kind: 'setup', machineId: 'machine-1', desiredRevision: 0 },
                caddy: createNativeCaddySetupInput({ daemonGroup: 'happier', daemonGroupId: 1000, routedNetworks: [],
                    initialConfig: '{}', bindings: { publicBindings: [{ requirementId: 'http', protocol: 'tcp', exposure: 'public',
                        hostAddress: '0.0.0.0', hostPort: 80, containerPort: 80 }] } }),
                port: { read: async () => ({ status: 'ready', metadataVersion: 1, metadata: { reachabilityPosture: {
                    revision: 0, management: { providers: [], publicSsh: { kind: 'closed' } }, defaultServiceIngress: { kind: 'none' },
                } } }), compareAndSwap: async () => { throw new Error('Domain cannot change the posture'); } },
                elevation: { installationId: 'installed-1', installedCli: '/managed/happier', spawn,
                    readPolicy: async () => ({ version: 1, mode: 'preauthorized' }),
                    observe: async () => ({ version: 1, observedAt: 0, daemonUid: 1000, daemonUsername: 'happier',
                        daemonIdentity: 'nonRoot', rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed',
                        managedDropIn: 'valid', tailscaledOperator: { authorization: 'unknown' } }) },
                readDaemonProof: async () => observeOwnDaemonReachability({ client: {
                    isMachineControlRegistrationReady: () => true,
                    async callConnectedClientRpc() { return { ok: false, error: 'Cannot call RPC on the same socket' }; },
                } }),
            }));
            throw new Error('Missing daemon ACK must refuse Domain staging');
        } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || !('details' in error)) throw error;
            return { kind: 'response', prepared: prepareExternalActionResponseEnvelopeV1({ v: 1,
                actionId: request.actionId, requestId: request.envelope.requestId,
                execution: { ok: false, errorCode: String(error.code), error: String(error.code), details: error.details } }) };
        }
    } });
    try {
        const response = await app.inject({ method: 'POST', url: '/v1/actions/deployments.domains.add', headers: {
            authorization: 'Bearer pat-secret', 'x-test-user-id': 'account-1', 'x-test-auth-token-kind': 'api_token',
            'x-test-api-token-account-id': 'account-1', 'x-test-api-token-principal-id': 'principal-1',
            'x-test-api-token-credential-id': 'credential-1',
        }, payload: { v: 1, requestId: 'domain-daemon-ack', target: { kind: 'machine', machineId: 'machine-1' }, input: {} } });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ v: 1, actionId: 'deployments.domains.add', requestId: 'domain-daemon-ack', execution: {
            ok: false, errorCode: 'required_fact_unavailable', details: { failure, restoration: { status: 'verified' },
                remedy: expect.stringContaining('homeRoutedDaemonAck') },
        } });
    } finally { await app.close(); }
});
