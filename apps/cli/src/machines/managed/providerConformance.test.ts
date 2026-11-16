import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { compilePluginJsonSchema, parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { JsonValue } from '@happier-dev/protocol';
import { ManagedMachineV1Schema, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { projectManagedEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineProvisionerContributionV1Schema, MachineProvisionerOptionsResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { AcquireResultV1Schema, ProviderObservationV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { createManagedNativeBootstrapIO, executeManagedMachineAcquire, executeManagedMachinePowerIntent, reconcileManagedMachine,
    type ManagedMachineReconciliation, type ManagedNativeInvocation } from '@happier-dev/cli-common/machines/managed';
import { cloudFixture, MANAGED_ID, NATIVE_EXPIRY, PRIVATE_BINDING, PUBLIC_KEY } from './providerConformance.testkit';

const modalWorker = vi.hoisted(() => ({ preload: '', state: '', entry: '' }));
// Thread creation is an OS boundary. Run the current real worker with only its vendor SDK import replaced.
vi.mock('node:worker_threads', async importOriginal => {
    const actual = await importOriginal<typeof import('node:worker_threads')>();
    return { ...actual, Worker: class extends actual.Worker {
        constructor(_entry: string, options: import('node:worker_threads').WorkerOptions) {
            super(modalWorker.entry, {
                ...options, execArgv: ['--import', pathToFileURL(modalWorker.preload).href],
                env: { ...(typeof options.env === 'object' ? options.env : {}), PROVIDER_CONFORMANCE_STATE: modalWorker.state },
            });
        }
    } };
});
const pluginRoot = new URL('../../../../../packages/plugins/', import.meta.url);
// Discover source declarations, not the generated catalog: a new leaf cannot silently escape this suite.
const leaves = readdirSync(pluginRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
    const path = new URL(`${entry.name}/src/manifest.ts`, pluginRoot);
    try { return /\bmachineProvisioners\s*:/.test(readFileSync(path, 'utf8')) ? [entry.name] : []; }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []; throw error; }
});

for (const leaf of leaves) {
    const source: Record<string, unknown> = await import(/* @vite-ignore */ fileURLToPath(new URL(`${leaf}/src/index.ts`, pluginRoot)));
    const manifestModule: Record<string, unknown> = await import(/* @vite-ignore */ fileURLToPath(new URL(`${leaf}/src/manifest.ts`, pluginRoot)));
    const definition = Object.values(manifestModule).find((value): value is { manifest: unknown } =>
        !!value && typeof value === 'object' && 'manifest' in value);
    const parsed = parsePluginManifest(definition?.manifest ?? source.manifest ?? source.PLUGIN_MANIFEST);
    if (!parsed.ok) throw new Error(`${leaf}: ${JSON.stringify(parsed.diagnostics)}`);
    const manifest = parsed.manifest;
    for (const declared of manifest.contributes.machineProvisioners ?? []) {
        const provisioner = MachineProvisionerContributionV1Schema.parse(declared);
        describe(`${leaf}/${provisioner.id} shared provider conformance`, () => {
            async function host(options: Readonly<{ accountOnly?: boolean }> = {}) {
                const vendor = cloudFixture(leaf, provisioner.id);
                if (leaf === 'machine-modal') Object.assign(modalWorker, { preload: vendor.modalPreload, state: vendor.modalState, entry: vendor.modalEntry });
                const kit = await createPluginTestkit({ manifest, module: { ...definition, ...source } as NonNullable<Parameters<typeof createPluginTestkit>[0]['module']>, services: vendor.services,
                    ...(options.accountOnly ? { resolveCurrentPluginMaterializationRef: () => null } : {}) });
                const forwarder = definePlugin({ id: 'test.provider.account-conformance', version: '1.0.0', actions: {
                    forward: { title: 'Invoke the retained provider role', surfaces: ['plugin'], dangerLevel: 'destructive',
                        confirmation: { title: 'Run the fixture provider role?', body: 'Vendor effects use the HTTP fixture.' },
                        execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
                        async run(input, context) {
                            if (!input || typeof input !== 'object' || Array.isArray(input)
                                || typeof input.action !== 'string' || input.body === undefined) throw new Error('Invalid fixture invocation');
                            return context.services.actions.execute({ pluginId: manifest.id, localId: input.action, typeProjection: undefined }, input.body);
                        },
                    },
                } });
                const accountCaller = options.accountOnly ? await createPluginTestkit({ manifest: forwarder.manifest,
                    module: forwarder, actionTargets: [kit], resolveCurrentPluginMaterializationRef: () => null }) : undefined;
                const outputs: unknown[] = [];
                const invoke: ManagedNativeInvocation = async (role, body) => {
                    const id = role === 'exec' ? provisioner.bootstrapTransport?.exec
                        : role === 'putFile' ? provisioner.bootstrapTransport?.putFile
                        : role === 'reconcile' ? provisioner.reconciliation?.action
                        : role === 'cleanup' ? provisioner.reconciliation?.cleanup
                        : provisioner.actions[role as keyof typeof provisioner.actions];
                    if (!id) throw new Error(`Undeclared ${role} for ${leaf}/${provisioner.id}`);
                    try { const value = accountCaller
                        ? await accountCaller.invokeAction('forward', { action: id, body: JSON.parse(JSON.stringify(body)) as JsonValue }, { surface: 'plugin' })
                        : await kit.invokeAction(id, JSON.parse(JSON.stringify(body)) as JsonValue, { surface: 'plugin' }); outputs.push(value); return value; }
                    catch (error) { outputs.push(error instanceof Error ? { ...error, message: error.message } : error); throw error; }
                };
                let reviewedEffectDigest: string | undefined;
                if (leaf === 'devcontainer') {
                    const options = await invoke('options', vendor.launch);
                    const reviewed = MachineProvisionerOptionsResultV1Schema.parse(options).base;
                    if (!reviewed?.launch || !reviewed.effectReview) throw new Error('Missing reviewed Devcontainer launch');
                    Object.assign(vendor.launch, reviewed.launch);
                    reviewedEffectDigest = reviewed.effectReview.reviewedEffectDigest;
                }
                let row = ManagedMachineV1Schema.parse({ id: MANAGED_ID, homeId: 'conformance-home', custodianAccountId: 'owner',
                    ...(options.accountOnly ? {} : { controller: { machineId: 'controller', installationId: 'installation' } }),
                    launch: { provider: { pluginId: manifest.id, localId: provisioner.id }, schemaVersion: provisioner.schemaVersion, name: 'Conformance', choices: vendor.launch },
                    allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
                    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
                    ...(reviewedEffectDigest ? { reviewedFacts: {
                        launch: { provider: { pluginId: manifest.id, localId: provisioner.id }, schemaVersion: provisioner.schemaVersion,
                            name: 'Conformance', choices: vendor.launch },
                        provisioner, reviewedEffectDigest, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
                        retentionCapabilities: provisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
                    } } : {}) });
                const correlation: ManagedMachineReconciliation['home']['correlation'] = machine => ({ homeId: machine.homeId, managedId: machine.id,
                    expectedIntentRevision: machine.intentRevision, requestId: 'conformance', controller: machine.controller });
                // The Home transport is a persistence boundary. Keep its row replies separate from real provider results.
                const report = async (machine: ManagedMachineV1, result: unknown) => {
                    const fact = AcquireResultV1Schema.parse(result);
                    if (fact.kind === 'bound') row = { ...machine, allocation: 'bound', resource: fact.resource };
                    else if (fact.kind === 'pending') row = { ...machine, nativeOperationRef: fact.nativeOperationRef };
                    else if (fact.kind === 'unknown') row = { ...machine, recovery: fact.recovery };
                    else row = { ...machine, allocation: 'confirmed-absent' };
                    return row;
                };
                const input: ManagedMachineReconciliation = {
                    machine: row, requestId: 'conformance', action: 'machines.managed.acquire', provisioner,
                    home: { correlation, projectEnrollmentCorrelation: projectManagedEnrollmentCorrelationV1,
                        submit: async machine => ({ submitted: true, machine: row = { ...machine, allocation: 'may-exist' } }),
                        reportIssuedAcquireFact: report, preparePendingAcquireBoundReport: async machine => result => report(machine, result),
                        row: async (path, body) => {
                            outputs.push(body);
                            if (path === 'report') {
                                const parsed = body as { result: unknown; observation?: unknown };
                                await report(row, parsed.result);
                                if (parsed.observation) row = ManagedMachineV1Schema.parse({ ...row,
                                    observation: ProviderObservationV1Schema.parse(parsed.observation) });
                            }
                            return row;
                        } },
                    createNative: () => ({ bootstrapCredentialKind: provisioner.bootstrapCredential?.kind ?? (provisioner.bootstrapTransport ? undefined : 'ssh'),
                        prepareRoles: async () => {}, invoke }),
                    bootstrap: { preflight: async () => {},
                        prepareCredential: async machine => ({ machine: row = { ...machine, bootstrapCredentialRef: { kind: 'shared_resource', resourceId: 'bootstrap-key' } },
                            publicKey: PUBLIC_KEY, guestHostPublicKey: PUBLIC_KEY, credentialRevision: 1 }),
                        readCredential: async () => ({ publicKey: PUBLIC_KEY, guestHostPublicKey: PUBLIC_KEY, revision: 1 }),
                        enroll: async enrollment => {
                            expect(enrollment.carrier.kind).toBe(provisioner.bootstrapTransport?.kind ?? 'ssh');
                            if (enrollment.carrier.kind === 'ssh') expect(provisioner.browserReachable).not.toBe(true);
                            outputs.push(enrollment.carrier); return row = { ...enrollment.machine, enrolledMachineId: 'ordinary-machine' }; } },
                    waitForObservation: async () => { throw new Error('Fixture did not settle native readiness'); },
                };
                async function acquire() {
                    return executeManagedMachineAcquire({ host: 'native', provisioner, admit: async () => row,
                        onAccepted: () => {}, run: machine => reconcileManagedMachine({ ...input, machine }) });
                }
                return { vendor, invoke, outputs, input, acquire, correlation, read: () => row,
                    loseAcquireResponse(retained = row.resource) {
                        const acceptsResource = retained && provisioner.reconciliation
                            && compilePluginJsonSchema(provisioner.reconciliation.nativeOperationSchema)(retained.value);
                        row = ManagedMachineV1Schema.parse({ ...row, allocation: 'may-exist', resource: undefined,
                            enrolledMachineId: undefined, observation: undefined,
                            nativeOperationRef: acceptsResource ? { contributionRef: retained.contributionRef,
                                schemaVersion: retained.schemaVersion, value: retained.value } : undefined });
                    },
                    async dispose() { await accountCaller?.dispose(); await kit.dispose(); vendor.cleanup(); } };
            }

            if (['machine-digitalocean', 'machine-hetzner'].includes(leaf)) it('composes Account acquire and pinned bootstrap without an execution Machine', async () => {
                const h = await host({ accountOnly: true });
                try {
                    const acquired = await h.acquire();
                    expect(acquired.result.enrolledMachineId).toBe('ordinary-machine');
                    expect(h.read().controller).toBeUndefined();
                    const carrier = await h.invoke('bootstrap', { resource: h.read().resource!.value,
                        credentialRef: h.read().bootstrapCredentialRef, guestHostPublicKey: PUBLIC_KEY });
                    expect(carrier).toMatchObject({ kind: 'ssh', credentialRef: h.read().bootstrapCredentialRef,
                        hostKeyEvidence: { hostKey: expect.stringContaining(PUBLIC_KEY), fingerprint: expect.stringMatching(/^SHA256:/) } });
                    const retainedWithoutPin = await h.invoke('bootstrap', { resource: h.read().resource!.value,
                        credentialRef: h.read().bootstrapCredentialRef });
                    expect(retainedWithoutPin).toMatchObject({ kind: 'ssh', credentialRef: h.read().bootstrapCredentialRef });
                    expect(retainedWithoutPin).not.toHaveProperty('hostKeyEvidence');
                    expect(h.vendor.processes).toHaveLength(0);
                    const allocationPath = leaf === 'machine-hetzner' ? '/v1/servers' : '/v2/droplets';
                    const allocations = h.vendor.calls.filter(call => call.method === 'POST' && new URL(call.url).pathname === allocationPath);
                    expect(allocations).toHaveLength(1);
                    // Vendor JSON/cloud-init are the real external serialization boundary.
                    const allocation = JSON.parse(new TextDecoder().decode(allocations[0]!.body));
                    expect(JSON.parse(allocation.user_data.replace(/^#cloud-config\n/u, ''))).toMatchObject({
                        ssh_keys: { ed25519_private: 'private-guest-host-key', ed25519_public: PUBLIC_KEY },
                    });
                    expect(JSON.stringify({ outputs: h.outputs, logs: h.vendor.logs })).not.toContain(PRIVATE_BINDING);
                } finally { await h.dispose(); }
            });

            it('validates discovery results against declared schemas with absent optional metadata', async () => {
                const h = await host();
                try {
                    for (const role of ['check', 'options'] as const) {
                        const declaration = manifest.contributes.actions.find(action => action.id === provisioner.actions[role]);
                        if (!declaration?.resultSchema || !declaration.inputSchema) throw new Error(`Missing ${role} schema`);
                        const validate = compilePluginJsonSchema(declaration.resultSchema);
                        const inputValid = compilePluginJsonSchema(declaration.inputSchema);
                        const properties = declaration.inputSchema.properties ?? {};
                        const projected = Object.fromEntries(Object.entries(h.vendor.launch).filter(([key]) => key in properties));
                        const candidates = role === 'check' ? [{}] : [{}, inputValid(h.vendor.launch) ? h.vendor.launch : projected];
                        const queries = candidates.filter((query, index) => inputValid(query) && candidates.findIndex(value => JSON.stringify(value) === JSON.stringify(query)) === index);
                        expect(queries.length, `No admitted ${role} query for ${leaf}/${provisioner.id}`).toBeGreaterThan(0);
                        for (const query of queries) {
                            const result = await h.invoke(role, query);
                            expect(validate(result), JSON.stringify({ leaf, contribution: provisioner.id, role, query, result })).toBe(true);
                            if (role === 'options' && ['machine-hetzner', 'machine-digitalocean'].includes(leaf)) {
                                const options = MachineProvisionerOptionsResultV1Schema.parse(result);
                                expect(options.dimensions.image).toHaveLength(2);
                                for (const option of options.dimensions.image!) {
                                    expect(option.nativeFacts?.image).toBeDefined();
                                    expect(option.nativeFacts?.image).not.toHaveProperty('description');
                                }
                            }
                        }
                    }
                } finally { await h.dispose(); }
            });

            if (provisioner.reconciliation) it('reconciles a lost acquisition response and records an absent or unavailable outcome without allocating again', async () => {
                const h = await host();
                try {
                    await h.acquire();
                    const allocations = h.vendor.allocationCount;
                    expect(allocations).toBeGreaterThan(0);
                    const resource = h.read().resource!;
                    h.loseAcquireResponse(resource);
                    const recovered = await reconcileManagedMachine({ ...h.input, machine: h.read(), action: 'machines.managed.inspect' });
                    expect(h.vendor.allocationCount).toBe(allocations);
                    if (recovered.allocation === 'bound') {
                        expect(recovered.resource).toEqual(resource);
                        expect(provisioner.retention.supportedIntents).toContain('delete');
                    } else {
                        expect(recovered.allocation).toBe('may-exist');
                        expect(recovered.observation).toMatchObject({ availability: 'unavailable', reason: expect.any(String) });
                    }
                    await h.invoke('destroy', { resource: resource.value });
                    h.loseAcquireResponse(resource);
                    const checked = await reconcileManagedMachine({ ...h.input, machine: h.read(), action: 'machines.managed.inspect' });
                    expect(h.vendor.allocationCount).toBe(allocations);
                    if (['machine-lima', 'machine-lume', 'machine-docker-sandboxes'].includes(leaf)) {
                        expect(checked.allocation).toBe('confirmed-absent');
                        expect(checked.observation).toMatchObject({ availability: 'absent', reason: 'managed_not_found' });
                    } else if (checked.allocation === 'bound') {
                        // An async deletion can still expose the same owned resource; keep its existing Delete path.
                        expect(checked.resource).toEqual(resource);
                        expect(checked.observation?.availability).toBe('present');
                    } else {
                        expect(checked.observation).toMatchObject({
                            availability: checked.allocation === 'confirmed-absent' ? 'absent' : 'unavailable', reason: expect.any(String),
                        });
                    }
                } finally { await h.dispose(); }
            });

            it('acquires, bootstraps, inspects, changes declared power and destroys only its owned resources', async () => {
                const h = await host();
                try {
                    const acquired = await h.acquire();
                    h.outputs.push(acquired);
                    expect(h.vendor.foreignPresent).toBe(true);
                    expect(acquired.result.enrolledMachineId).toBe('ordinary-machine');
                    expect(h.read().allocation).toBe('bound');
                    expect(h.read().resource?.contributionRef).toEqual({ pluginId: manifest.id, localId: provisioner.id });
                    await reconcileManagedMachine({ ...h.input, machine: h.read(), action: 'machines.managed.inspect' });
                    const resource = h.read().resource!;
                    const observation = ProviderObservationV1Schema.parse(await h.invoke('inspect', { resource: resource.value }));
                    expect(observation).toMatchObject({ availability: 'present', power: leaf === 'machine-crabbox' && provisioner.id === 'crabbox-coordinator' ? 'unknown' : 'running' });
                    // The native port carries byte views and UTF-8 exactly, including BOM and nonzero exits.
                    if (provisioner.bootstrapTransport?.kind === 'native') {
                        const io = createManagedNativeBootstrapIO({ ...h.correlation(h.read()), resource }, h.invoke);
                        const path = join(h.vendor.directory, "private bytes'雪");
                        await io.putFile({ path, bytes: new Uint8Array([7, 0, 255, 128, 42]).subarray(1, 4) });
                        expect(await readFile(path)).toEqual(Buffer.from([0, 255, 128]));
                        expect(await io.exec({ command: 'cat', input: '\uFEFF秘密\n' })).toEqual({ status: 0, stdout: '\uFEFF秘密\n', stderr: '' });
                        expect(await io.exec({ command: 'printf out; printf err >&2; exit 17' })).toEqual({ status: 17, stdout: 'out', stderr: 'err' });
                        if (leaf === 'machine-vercel' || leaf === 'machine-e2b' || leaf === 'machine-daytona' || leaf === 'machine-superserve' || leaf === 'machine-freestyle' || leaf === 'machine-railway') {
                            await io.exec({ command: `mkdir -p '${h.vendor.directory}/.happier'` });
                            await io.exec({ command: 'true', processConfig: { environment: { HOME: h.vendor.directory, HAPPIER_HOME_DIR: `${h.vendor.directory}/.happier` }, detachedDaemonStartArgv: ['true'] } });
                        }
                    }
                    const intents = provisioner.retention.supportedIntents;
                    const stop = intents.includes('stop') ? 'stop' : intents.includes('suspend') ? 'suspend' : undefined;
                    if (stop) {
                        const stopped = await executeManagedMachinePowerIntent({ machine: { ...h.read(), desired: stop }, invoke: h.invoke });
                        expect(stopped.result.kind).toBe('confirmed');
                        expect(stopped.observation).toMatchObject({ availability: 'present', power: stop === 'suspend' ? 'suspended' : 'stopped' });
                        const resume = intents.includes('resume') ? 'resume' : intents.includes('start') ? 'start' : undefined;
                        if (resume) {
                            const resumed = await executeManagedMachinePowerIntent({ machine: { ...h.read(), desired: resume }, invoke: h.invoke });
                            expect(resumed.result.kind).toBe('confirmed');
                            expect(resumed.observation).toMatchObject({ availability: 'present', power: 'running' });
                        }
                    }
                    if (intents.includes('delete')) {
                        let destroyed = await h.invoke('destroy', { resource: resource.value });
                        if (destroyed && typeof destroyed === 'object' && 'nativeOperationRef' in destroyed) {
                            const operation = destroyed.nativeOperationRef;
                            if (!operation || typeof operation !== 'object' || !('value' in operation)) throw new Error('Missing retained cleanup identity');
                            destroyed = await h.invoke('destroy', { nativeOperation: operation.value });
                        }
                        expect(destroyed).toMatchObject({ kind: 'confirmed' });
                        expect(h.vendor.present).toBe(false);
                        expect([...h.vendor.owned]).toEqual([]);
                        expect(h.vendor.foreignPresent).toBe(true);
                    }
                    expect(JSON.stringify({ outputs: h.outputs, logs: h.vendor.logs })).not.toContain(PRIVATE_BINDING);
                } finally { await h.dispose(); }
            });

            it('keeps failed native reads and cleanup unconfirmed without exposing credentials', async () => {
                const h = await host();
                try {
                    await h.acquire();
                    h.vendor.setFailure(true);
                    const failed = await h.invoke('inspect', { resource: h.read().resource!.value }).catch(() => undefined);
                    if (failed !== undefined) expect(ProviderObservationV1Schema.parse(failed).availability).toBe('unavailable');
                    const cleanup = await h.invoke('destroy', { resource: h.read().resource!.value }).catch(() => undefined);
                    if (cleanup !== undefined) expect(cleanup).not.toMatchObject({ kind: 'confirmed' });
                    expect(h.vendor.present).toBe(true);
                    expect(JSON.stringify({ outputs: h.outputs, logs: h.vendor.logs })).not.toContain(PRIVATE_BINDING);
                } finally { await h.dispose(); }
            });

            it('reports deletion timing from native evidence and never invents it', async () => {
                const h = await host();
                try {
                    await h.acquire();
                    const resource = h.read().resource!.value;
                    const without = ProviderObservationV1Schema.parse(await h.invoke('inspect', { resource }));
                    if (leaf === 'machine-e2b') expect(without.nativeExpiry).toBe(NATIVE_EXPIRY);
                    else expect(without.nativeExpiry).toBeUndefined();
                    expect(without.deletionNotices?.flatMap(notice => notice.at === undefined ? [] : [notice.at]) ?? []).toEqual([]);
                    h.vendor.setEvidence(true);
                    const withEvidence = ProviderObservationV1Schema.parse(await h.invoke('inspect', { resource }));
                    if (leaf === 'machine-e2b' || leaf === 'machine-daytona' || leaf === 'machine-superserve' || leaf === 'machine-freestyle' || leaf === 'machine-crabbox' || leaf === 'machine-vercel' || (leaf === 'machine-cua' && provisioner.id === 'byoc')) expect(withEvidence.nativeExpiry).toBe(NATIVE_EXPIRY);
                    if (leaf === 'machine-boat') {
                        expect(withEvidence.nativeExpiry).toBe(NATIVE_EXPIRY);
                        await h.invoke('power', { resource, intent: 'stop' });
                        const stopped = ProviderObservationV1Schema.parse(await h.invoke('inspect', { resource }));
                        expect(stopped.deletionNotices?.length).toBeGreaterThan(0);
                        expect(stopped.deletionNotices).toContainEqual(expect.objectContaining({ kind: 'stopped-storage', at: Date.parse('2026-11-15T12:00:00Z') }));
                    }
                } finally { await h.dispose(); }
            });

            it.skipIf(provisioner.bootstrapTransport?.kind === 'native')('refuses SSH-only browser allocation before admission', async () => {
                expect(provisioner.browserReachable).not.toBe(true);
                let admissions = 0;
                await expect(executeManagedMachineAcquire({ host: 'browser', provisioner,
                    admit: async () => { admissions++; throw new Error('Unexpected allocation'); }, onAccepted: () => {}, run: async () => {} }))
                    .rejects.toMatchObject({ code: 'provider_unavailable' });
                expect(admissions).toBe(0);
            });
        });
    }
}
