import { isRecord } from '@happier-dev/protocol/common/records';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { buildMachineProvisionerShellCommand } from '@happier-dev/plugin-sdk/machine-provisioners';
import { compilePluginJsonSchema, parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { JsonValue } from '@happier-dev/protocol';
import { createPluginAccountBundledSelectionV1, resolvePluginAccountExecutionSelectionV1 } from '@happier-dev/protocol/plugins/availability';
import { ManagedMachineV1Schema, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { projectManagedEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MACHINE_PROVISIONER_SIZE_DIMENSIONS_V1, MachineProvisionerContributionV1Schema, MachineProvisionerOptionsResultV1Schema,
    requiresMachineProvisionerEffectReviewV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { AcquireResultV1Schema, ManagedBootstrapCarrierV1Schema, ProviderObservationV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { createManagedNativeBootstrapIO, executeManagedMachineAcquire, executeManagedMachinePowerIntent, executeManagedMachineResize,
    prepareManagedMachineDeleteIntent, projectAccountManagedProvisioners, reconcileManagedMachine, settleManagedMachineDeleteIntent,
    type ManagedMachineReconciliation, type ManagedNativeInvocation, type ManagedNativeRole } from '@happier-dev/cli-common/machines/managed';
import { cloudFixture, loadProviderConformanceExpectedFailures, MANAGED_ID, NATIVE_EXPIRY, PRIVATE_BINDING, PUBLIC_KEY,
    type ProviderConformanceCase } from './providerConformance.testkit';

const providerWorker = vi.hoisted(() => ({ preload: '', state: '', entry: '' }));

it('machine-upstash-box native fixture preserves guest bytes through its text exec response', async () => {
    const vendor = await cloudFixture({ leaf: 'machine-upstash-box', pluginId: 'happier.machine.upstash-box', contribution: 'upstash-box' });
    try {
        const command = buildMachineProvisionerShellCommand(['sh', '-c', 'printf "\\000\\377"; printf guest-stderr >&2; exit 7'], '');
        const response = await vendor.services.http!.request!({ url: 'https://us-east-1.box.upstash.com/v2/box/box-owned/exec',
            method: 'POST', headers: {}, body: new TextEncoder().encode(JSON.stringify({ command: ['sh', '-c', command] })) });
        const native = JSON.parse(new TextDecoder().decode(response.body));
        expect(native).toMatchObject({ exit_code: 0, error: '' });
        expect(JSON.parse(native.output)).toEqual({ exitCode: 7, stdoutBase64: 'AP8=', stderrBase64: 'Z3Vlc3Qtc3RkZXJy' });
    } finally { vendor.cleanup(); }
});
// Thread creation is an OS boundary. A provider fixture that supplies a worker (Modal's SDK worker)
// runs that current real worker with only its vendor SDK import replaced; every other worker is untouched.
vi.mock('node:worker_threads', async importOriginal => {
    const actual = await importOriginal<typeof import('node:worker_threads')>();
    return { ...actual, Worker: class extends actual.Worker {
        constructor(entry: string | URL, options: import('node:worker_threads').WorkerOptions = {}) {
            if (!providerWorker.entry) { super(entry, options); return; }
            super(providerWorker.entry, {
                ...options, execArgv: ['--import', pathToFileURL(providerWorker.preload).href],
                env: { ...(typeof options.env === 'object' ? options.env : {}), PROVIDER_CONFORMANCE_STATE: providerWorker.state },
            });
        }
    } };
});
const pluginRoot = new URL('../../../../../packages/plugins/', import.meta.url);
// Discover source declarations, not the generated catalog: a new leaf cannot silently escape this suite.
// Each leaf contributes its vendor fake from `packages/plugins/<leaf>/testkit/providerConformance.ts`.
const leaves = readdirSync(pluginRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
    const path = new URL(`${entry.name}/src/manifest.ts`, pluginRoot);
    try { return /\bmachineProvisioners\s*:/.test(readFileSync(path, 'utf8')) ? [entry.name] : []; }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []; throw error; }
});
const errorCode = (error: unknown) => isRecord(error) && typeof error.code === 'string' ? error.code : undefined;

for (const leaf of leaves) {
    const source: Record<string, unknown> = await import(/* @vite-ignore */ fileURLToPath(new URL(`${leaf}/src/index.ts`, pluginRoot)));
    const manifestModule: Record<string, unknown> = await import(/* @vite-ignore */ fileURLToPath(new URL(`${leaf}/src/manifest.ts`, pluginRoot)));
    const definition = Object.values(manifestModule).find((value): value is { manifest: unknown } =>
        !!value && typeof value === 'object' && 'manifest' in value);
    const parsed = parsePluginManifest(definition?.manifest ?? source.manifest ?? source.PLUGIN_MANIFEST);
    if (!parsed.ok) throw new Error(`${leaf}: ${JSON.stringify(parsed.diagnostics)}`);
    const manifest = parsed.manifest;
    const packageName = String(JSON.parse(readFileSync(new URL(`${leaf}/package.json`, pluginRoot), 'utf8')).name);
    // Account placement is the canonical discovery projection of the declared acquire Action target;
    // a plugin without Account execution cannot be Account-placed.
    const accountExecution = resolvePluginAccountExecutionSelectionV1({ pluginId: manifest.id, intentRead: null,
        bundled: createPluginAccountBundledSelectionV1({ packageName, manifest }) });
    const accountPlaced = new Set(accountExecution.kind === 'available' ? projectAccountManagedProvisioners([accountExecution])
        .filter(entry => entry.acquireExecutionTarget === 'account').map(entry => entry.contribution.localId) : []);
    const hostAccessOf = (actionId: string) => {
        const declared = manifest.contributes.actions?.find(action => action.id === actionId)?.hostAccess ?? [];
        return [...manifest.hostAccess.required, ...manifest.hostAccess.optional].filter(access => declared.includes(access.id));
    };
    const expectedFailures = await loadProviderConformanceExpectedFailures(leaf);
    for (const declared of manifest.contributes.machineProvisioners ?? []) {
        const provisioner = MachineProvisionerContributionV1Schema.parse(declared);
        // A provider's fixture names each case it is known to fail and the owner fixing it; the case still runs and must fail.
        const known = (key: ProviderConformanceCase) => expectedFailures[provisioner.id]?.[key] ? it.fails : it;
        const checkAccess = hostAccessOf(provisioner.actions.check);
        // The vendor credential is a connected account presented over the network: a vendor 401 is a credential refusal.
        const presentsVendorCredential = checkAccess.some(access => access.capability === 'connectedAccounts')
            && checkAccess.some(access => access.capability === 'network');
        describe(`${leaf}/${provisioner.id} shared provider conformance`, () => {
            async function host(options: Readonly<{ accountOnly?: boolean }> = {}) {
                const vendor = await cloudFixture({ leaf, pluginId: manifest.id, contribution: provisioner.id });
                Object.assign(providerWorker, vendor.worker ?? { preload: '', state: '', entry: '' });
                const kit = await createPluginTestkit({ manifest, module: { ...definition, ...source } as NonNullable<Parameters<typeof createPluginTestkit>[0]['module']>, services: vendor.services,
                    ...(options.accountOnly ? { resolveCurrentPluginMaterializationRef: () => null } : {}) });
                const nativeFetch = globalThis.fetch;
                // Vendor HTTP is the boundary: retain every other caller's real fetch.
                const dataFetch = vendor.dataFetch;
                const dataBoundary = dataFetch ? vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
                    new URL(input instanceof Request ? input.url : String(input)).origin === vendor.dataOrigin
                        ? dataFetch(input, init) : nativeFetch(input, init)) : undefined;
                const forwarder = definePlugin({ id: 'test.provider.account-conformance', version: '1.0.0', actions: {
                    forward: { title: 'Invoke the retained provider role', surfaces: ['plugin'], dangerLevel: 'destructive',
                        confirmation: { title: 'Run the fixture provider role?', body: 'Vendor effects use the HTTP fixture.' },
                        execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
                        async run(input, context) {
                            if (!isRecord(input)
                                || typeof input.action !== 'string' || input.body === undefined) throw new Error('Invalid fixture invocation');
                            return context.services.actions.execute({ pluginId: manifest.id, localId: input.action, typeProjection: undefined }, input.body);
                        },
                    },
                } });
                const accountCaller = options.accountOnly ? await createPluginTestkit({ manifest: forwarder.manifest,
                    module: forwarder, actionTargets: [kit], resolveCurrentPluginMaterializationRef: () => null }) : undefined;
                const outputs: unknown[] = [];
                const roles: ManagedNativeRole[] = [];
                const invoke: ManagedNativeInvocation = async (role, body) => {
                    roles.push(role);
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
                // The declaration owns which launch variants need an author-reviewed source effect.
                if (requiresMachineProvisionerEffectReviewV1(provisioner, vendor.launch)) {
                    const options = await invoke('options', vendor.launch);
                    const reviewed = MachineProvisionerOptionsResultV1Schema.parse(options).base;
                    if (!reviewed?.launch || !reviewed.effectReview) throw new Error(`Missing reviewed launch for ${leaf}/${provisioner.id}`);
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
                // Home is a persistence boundary. This fake keeps only the row transitions Home owns
                // (bound/pending/unknown/absent reports, Cancel during allocation, Delete settlement).
                let cancelDuringAllocation = false;
                const report = async (machine: ManagedMachineV1, result: unknown) => {
                    const fact = AcquireResultV1Schema.parse(result);
                    // Cancel settled at Home while the provider allocated: the late fact keeps cleanup custody.
                    const canceled = cancelDuringAllocation && (fact.kind === 'bound' || fact.kind === 'pending')
                        ? { creationState: 'canceled' as const, desired: 'delete' as const, desiredWhen: 'now' as const } : {};
                    if (fact.kind === 'bound') row = { ...machine, ...canceled, allocation: 'bound', resource: fact.resource };
                    else if (fact.kind === 'pending') row = { ...machine, ...canceled, nativeOperationRef: fact.nativeOperationRef };
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
                /** Home admits Delete now; the core Delete owners recover identity, then settle native cleanup through Home. */
                async function deleteThroughCore() {
                    row = ManagedMachineV1Schema.parse({ ...row, desired: 'delete', desiredWhen: 'now', intentRevision: row.intentRevision + 1 });
                    const prepared = await prepareManagedMachineDeleteIntent({ machine: row, requestId: 'conformance-delete', provisioner, invoke,
                        home: { correlation, row: input.home.row } });
                    if (prepared.allocation === 'confirmed-absent') return prepared;
                    // Observation bound of this harness only: an asynchronous delete settles within two observation
                    // rounds of its fake vendor, so a third unsettled report means Delete cannot settle.
                    const observing = new AbortController();
                    let unsettled = 0;
                    const settled = settleManagedMachineDeleteIntent({ machine: prepared, invoke, io: { signal: observing.signal },
                        report: async ({ result, observation }) => {
                            outputs.push(result);
                            if (result.kind === 'accepted' || result.kind === 'pending') {
                                unsettled++;
                                if (unsettled > 2) observing.abort();
                            }
                            const nativeOperationRef = 'nativeOperationRef' in result ? result.nativeOperationRef : undefined;
                            return row = ManagedMachineV1Schema.parse(result.kind === 'confirmed'
                                ? { ...row, allocation: 'confirmed-absent', resource: undefined, nativeOperationRef: undefined, ...(observation ? { observation } : {}) }
                                : { ...row, ...(nativeOperationRef ? { nativeOperationRef } : {}), ...(observation ? { observation } : {}) });
                        },
                        onNativeFailureReportError: error => { throw error; } });
                    return await settled.catch((error: unknown) => {
                        if (!observing.signal.aborted) throw error;
                        throw new Error(`Delete reported ${unsettled} unsettled results while the vendor ${vendor.present ? 'still holds' : 'no longer holds'} the resource`, { cause: error });
                    });
                }
                return { vendor, invoke, roles, outputs, input, acquire, correlation, deleteThroughCore, read: () => row,
                    cancelDuringAllocation() { cancelDuringAllocation = true; },
                    /** The row Home holds when the acquire call itself failed after submit (reconcile.ts acquire catch: unknown + recovery). */
                    failAcquireReply() {
                        row = ManagedMachineV1Schema.parse({ ...row, allocation: 'may-exist', resource: undefined, enrolledMachineId: undefined,
                            observation: undefined, nativeOperationRef: undefined,
                            recovery: { reference: row.id, reason: 'native_acquisition_unconfirmed' } });
                    },
                    loseAcquireResponse(retained = row.resource) {
                        const acceptsResource = retained && provisioner.reconciliation
                            && compilePluginJsonSchema(provisioner.reconciliation.nativeOperationSchema)(retained.value);
                        row = ManagedMachineV1Schema.parse({ ...row, allocation: 'may-exist', resource: undefined,
                            enrolledMachineId: undefined, observation: undefined,
                            nativeOperationRef: acceptsResource ? { contributionRef: retained.contributionRef,
                                schemaVersion: retained.schemaVersion, value: retained.value } : undefined });
                    },
                    leaked: () => JSON.stringify({ outputs, logs: vendor.logs }).includes(PRIVATE_BINDING),
                    async dispose() { dataBoundary?.mockRestore(); await accountCaller?.dispose(); await kit.dispose(); vendor.cleanup(); } };
            }

            if (accountPlaced.has(provisioner.id)) known('accountPlacement')('composes an Account-placed acquire and bootstrap without an execution Machine (breaks if the declared Account target needs a controller)', async () => {
                const h = await host({ accountOnly: true });
                try {
                    const acquired = await h.acquire();
                    expect(acquired.result.enrolledMachineId).toBe('ordinary-machine');
                    expect(h.read().controller).toBeUndefined();
                    expect(h.vendor.allocationCount).toBe(1);
                    // Process host access is a declaration fact of the acquire and bootstrap Actions.
                    if (![provisioner.actions.acquire, provisioner.actions.bootstrap].some(id => hostAccessOf(id).some(access => access.capability === 'process'))) {
                        expect(h.vendor.processes).toHaveLength(0);
                    }
                    const userData = h.vendor.facts.allocationUserData?.(h.vendor.calls);
                    if (userData !== undefined) {
                        // The reviewed guest host key reaches the vendor in its allocation user data and pins bootstrap evidence.
                        expect(userData).toEqual([expect.objectContaining({
                            ssh_keys: { ed25519_private: 'private-guest-host-key', ed25519_public: PUBLIC_KEY },
                        })]);
                        const carrier = await h.invoke('bootstrap', { resource: h.read().resource!.value,
                            credentialRef: h.read().bootstrapCredentialRef, guestHostPublicKey: PUBLIC_KEY });
                        expect(carrier).toMatchObject({ kind: 'ssh', credentialRef: h.read().bootstrapCredentialRef,
                            hostKeyEvidence: { hostKey: expect.stringContaining(PUBLIC_KEY), fingerprint: expect.stringMatching(/^SHA256:/) } });
                        const retainedWithoutPin = await h.invoke('bootstrap', { resource: h.read().resource!.value,
                            credentialRef: h.read().bootstrapCredentialRef });
                        expect(retainedWithoutPin).toMatchObject({ kind: 'ssh', credentialRef: h.read().bootstrapCredentialRef });
                        expect(retainedWithoutPin).not.toHaveProperty('hostKeyEvidence');
                    }
                    expect(h.leaked()).toBe(false);
                } finally { await h.dispose(); }
            });

            it('validates discovery results against declared schemas with absent optional metadata', async () => {
                if (provisioner.bootstrapTransport?.kind !== 'native') expect(provisioner.browserReachable).not.toBe(true);
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
                            const blank = h.vendor.facts.blankImageDescriptions;
                            if (role === 'options' && blank !== undefined) {
                                // Blank vendor text is never projected as an image fact.
                                const images = MachineProvisionerOptionsResultV1Schema.parse(result).dimensions.image ?? [];
                                expect(images).toHaveLength(blank);
                                for (const option of images) {
                                    expect(option.nativeFacts?.image).toBeDefined();
                                    expect(option.nativeFacts?.image).not.toHaveProperty('description');
                                }
                            }
                        }
                    }
                } finally { await h.dispose(); }
            });

            if (provisioner.reconciliation) known('deleteAfterLostReply')('recovers a lost acquisition reply without allocating again, and Delete from that state either verifies absence or refuses without deleting (breaks on a blind re-create or an unverified absence)', async () => {
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
                    h.failAcquireReply();
                    const deleted = await h.deleteThroughCore().then(machine => ({ machine }), (error: unknown) => ({ error }));
                    expect(h.vendor.allocationCount).toBe(allocations);
                    expect(h.vendor.foreignPresent).toBe(true);
                    if ('error' in deleted) {
                        // Uncertain identity fails closed before any native delete: nothing was deleted on a guess.
                        expect(errorCode(deleted.error), String(deleted.error)).toEqual(expect.any(String));
                        expect(h.roles).not.toContain('destroy');
                        expect(h.vendor.present).toBe(true);
                        return;
                    }
                    expect(deleted.machine.allocation).toBe('confirmed-absent');
                    expect(h.vendor.present).toBe(false);
                    h.loseAcquireResponse(resource);
                    const checked = await reconcileManagedMachine({ ...h.input, machine: h.read(), action: 'machines.managed.inspect' });
                    expect(h.vendor.allocationCount).toBe(allocations);
                    if (h.vendor.facts.provesAbsenceAfterDelete) {
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

            known('nativeLifecycle')('acquires, bootstraps, inspects, carries native bytes and changes declared power on its owned resource', async () => {
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
                    expect(observation).toMatchObject({ availability: 'present', power: h.vendor.facts.inspectPower ?? 'running' });
                    // The native port carries byte views and UTF-8 exactly, including BOM and nonzero exits.
                    if (provisioner.bootstrapTransport?.kind === 'native') {
                        const io = createManagedNativeBootstrapIO({ ...h.correlation(h.read()), resource }, h.invoke);
                        const path = join(h.vendor.directory, "private bytes'雪");
                        try {
                            await io.putFile({ path, bytes: new Uint8Array([7, 0, 255, 128, 42]).subarray(1, 4) });
                        } catch (error) {
                            throw new Error(`File-write boundary evidence: ${JSON.stringify(h.vendor.diagnostics() ?? null)}`, { cause: error });
                        }
                        expect(await readFile(path)).toEqual(Buffer.from([0, 255, 128]));
                        expect(await io.exec({ command: 'cat', input: '﻿秘密\n' })).toEqual({ status: 0, stdout: '﻿秘密\n', stderr: '' });
                        expect(await io.exec({ command: 'printf out; printf err >&2; exit 17' })).toEqual({ status: 17, stdout: 'out', stderr: 'err' });
                        // A carrier that names a guest home receives the core's detached daemon process configuration.
                        const carrier = ManagedBootstrapCarrierV1Schema.parse(await h.invoke('bootstrap', { resource: resource.value }));
                        if (carrier.kind === 'native' && carrier.guestHome) {
                            const { homeDir, happyHomeDir } = carrier.guestHome;
                            await io.exec({ command: `mkdir -p '${happyHomeDir}'` });
                            await io.exec({ command: 'true', processConfig: { environment: { HOME: homeDir, HAPPIER_HOME_DIR: happyHomeDir }, detachedDaemonStartArgv: ['true'] } });
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
                    expect(h.leaked()).toBe(false);
                } finally { await h.dispose(); }
            });

            if (provisioner.retention.supportedIntents.includes('delete')) it('deletes through the core Delete owners and settles absent only after the vendor holds no owned resource (breaks if Delete confirms before native absence or touches a foreign resource)', async () => {
                const h = await host();
                try {
                    await h.acquire();
                    expect(h.vendor.present).toBe(true);
                    const deleted = await h.deleteThroughCore();
                    expect(deleted.allocation).toBe('confirmed-absent');
                    expect(h.vendor.present).toBe(false);
                    expect([...h.vendor.owned]).toEqual([]);
                    expect(h.vendor.foreignPresent).toBe(true);
                    expect(h.roles.filter(role => role === 'acquire')).toHaveLength(1);
                    expect(h.leaked()).toBe(false);
                } finally { await h.dispose(); }
            });

            it('stops a creation canceled at Home before its bound report without guest IO, and Delete then leaves no allocated resource (breaks if bootstrap continues after Cancel or the late resource loses cleanup custody)', async () => {
                const h = await host();
                try {
                    h.cancelDuringAllocation();
                    const canceled = await h.acquire().then(() => undefined, (error: unknown) => error);
                    expect(errorCode(canceled)).toBe('cancelled');
                    expect(h.roles).not.toEqual(expect.arrayContaining(['bootstrap']));
                    expect(h.roles.filter(role => role === 'exec' || role === 'putFile')).toEqual([]);
                    expect(h.read()).toMatchObject({ creationState: 'canceled', allocation: 'bound', resource: expect.anything() });
                    expect(h.read().enrolledMachineId).toBeUndefined();
                    expect(h.vendor.present).toBe(true);
                    const deleted = await h.deleteThroughCore();
                    expect(deleted.allocation).toBe('confirmed-absent');
                    expect(h.vendor.present).toBe(false);
                    expect([...h.vendor.owned]).toEqual([]);
                    expect(h.vendor.foreignPresent).toBe(true);
                    expect(h.leaked()).toBe(false);
                } finally { await h.dispose(); }
            });

            const stopIntent = (['stop', 'suspend'] as const).find(intent => provisioner.retention.supportedIntents.includes(intent));
            if (stopIntent) known('powerReplyLost')('settles a power change whose vendor reply is lost as one outcome that never claims no effect, without resubmitting power (breaks if the core power owner throws past settlement, reports refused, or retries the effect)', async () => {
                const h = await host();
                try {
                    await h.acquire();
                    // The vendor applies the stop, then its reply is lost.
                    h.vendor.setFailure('effect-reply-lost');
                    const issued = h.roles.length;
                    const settled = await executeManagedMachinePowerIntent({ machine: { ...h.read(), desired: stopIntent }, invoke: h.invoke })
                        .then(power => ({ power }), (error: unknown) => ({ error: errorCode(error) ?? String(error) }));
                    expect(h.roles.slice(issued).filter(role => role === 'power')).toHaveLength(1);
                    expect(settled).toMatchObject({ power: { result: { kind: expect.stringMatching(/^(unknown|confirmed)$/) } } });
                    if ('power' in settled && settled.power.result.kind === 'confirmed') {
                        // Confirmation is an observation of the applied state, never the lost acknowledgement.
                        expect(settled.power.observation).toMatchObject({ availability: 'present', power: stopIntent === 'suspend' ? 'suspended' : 'stopped' });
                    }
                    expect(h.leaked()).toBe(false);
                } finally { await h.dispose(); }
            });

            const resizeDimension = MACHINE_PROVISIONER_SIZE_DIMENSIONS_V1.find(dimension => provisioner.resize?.[dimension].kind === 'supported');
            if (provisioner.actions.resize && resizeDimension) it('resizes through the core resize owner and confirms only from the observed native size (breaks if resize confirms without the guest size changing or leaves a restarted guest stopped)', async () => {
                const h = await host();
                try {
                    await h.acquire();
                    const before = ProviderObservationV1Schema.parse(await h.invoke('inspect', { resource: h.read().resource!.value }));
                    const step = resizeDimension === 'cpuCores' ? 1 : 1024 ** 3;
                    const target = (before.size?.[resizeDimension] ?? step) + step;
                    const resized = await executeManagedMachineResize({ machine: h.read(), size: { [resizeDimension]: target }, provisioner, invoke: h.invoke });
                    expect(resized.result).toEqual({ kind: 'confirmed' });
                    expect(resized.observation).toMatchObject({ availability: 'present', power: before.power, size: { [resizeDimension]: target } });
                    expect(h.leaked()).toBe(false);
                } finally { await h.dispose(); }
            });

            if (presentsVendorCredential) known('credentialRefusal')('surfaces a vendor 401 as credential_unavailable from check and acquire (breaks if a revoked key reads as Unavailable instead of offering Connect)', async () => {
                const h = await host();
                try {
                    h.vendor.setFailure('credential');
                    const contacted = () => h.vendor.calls.length + h.vendor.processes.length;
                    const checked = await h.invoke('check', {}).then(result => ({ result }), (error: unknown) => ({ code: errorCode(error) }));
                    // A check that reached the vendor reports its refusal as the credential state the readiness owner keys on.
                    if (contacted() > 0 || !('result' in checked) || !isRecord(checked.result) || checked.result.available !== true) {
                        expect('result' in checked && isRecord(checked.result) ? checked.result.code : 'code' in checked ? checked.code : undefined).toBe('credential_unavailable');
                    }
                    // The acquire input the core sends (reconcile.ts): SSH carriers also receive the bootstrap and guest host keys.
                    const sshCarrier = (provisioner.bootstrapCredential?.kind ?? (provisioner.bootstrapTransport ? undefined : 'ssh')) === 'ssh';
                    const acquired = await h.invoke('acquire', { managedId: MANAGED_ID, launch: h.vendor.launch,
                        ...(sshCarrier ? { bootstrapPublicKey: PUBLIC_KEY, guestHostPublicKey: PUBLIC_KEY } : {}) })
                        .then(result => isRecord(result) ? { kind: result.kind, code: result.code } : { kind: undefined }, (error: unknown) => ({ code: errorCode(error) }));
                    expect(acquired).toMatchObject({ code: 'credential_unavailable' });
                    expect(h.vendor.allocationCount).toBe(0);
                    expect(h.leaked()).toBe(false);
                } finally { await h.dispose(); }
            });

            it('keeps failed native reads and cleanup unconfirmed without exposing credentials', async () => {
                const h = await host();
                try {
                    await h.acquire();
                    h.vendor.setFailure('outage');
                    const failed = await h.invoke('inspect', { resource: h.read().resource!.value }).catch(() => undefined);
                    if (failed !== undefined) expect(ProviderObservationV1Schema.parse(failed).availability).toBe('unavailable');
                    const cleanup = await h.invoke('destroy', { resource: h.read().resource!.value }).catch(() => undefined);
                    if (cleanup !== undefined) expect(cleanup).not.toMatchObject({ kind: 'confirmed' });
                    expect(h.vendor.present).toBe(true);
                    expect(h.leaked()).toBe(false);
                } finally { await h.dispose(); }
            });

            it('reports deletion timing from native evidence and never invents it', async () => {
                const h = await host();
                try {
                    await h.acquire();
                    const resource = h.read().resource!.value;
                    const facts = h.vendor.facts;
                    const without = ProviderObservationV1Schema.parse(await h.invoke('inspect', { resource }));
                    expect(without.nativeExpiry).toBe(facts.nativeExpiry === 'always' ? NATIVE_EXPIRY : undefined);
                    expect(without.deletionNotices?.flatMap(notice => notice.at === undefined ? [] : [notice.at]) ?? []).toEqual([]);
                    h.vendor.setEvidence(true);
                    const withEvidence = ProviderObservationV1Schema.parse(await h.invoke('inspect', { resource }));
                    if (facts.nativeExpiry) expect(withEvidence.nativeExpiry).toBe(NATIVE_EXPIRY);
                    // A declared after-stop deletion rule is dated from the vendor's stop time.
                    const afterStop = provisioner.retention.deletionNotices?.filter(notice => notice.rule.kind === 'after-stop') ?? [];
                    if (afterStop.length && provisioner.retention.supportedIntents.includes('stop') && facts.stoppedAt !== undefined) {
                        await h.invoke('power', { resource, intent: 'stop' });
                        const stopped = ProviderObservationV1Schema.parse(await h.invoke('inspect', { resource }));
                        for (const notice of afterStop) {
                            expect(stopped.deletionNotices).toContainEqual(expect.objectContaining({ kind: notice.kind,
                                at: facts.stoppedAt + (notice.rule.kind === 'after-stop' ? notice.rule.afterMs : 0) }));
                        }
                    }
                } finally { await h.dispose(); }
            });
        });
    }
}
