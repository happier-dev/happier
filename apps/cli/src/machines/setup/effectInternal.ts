import type { Readable, Writable } from 'node:stream';
import * as machineSetup from '@happier-dev/cli-common/machineSetup';
import {
    MachineEffectInternalRequestSchema,
    MachineAdministratorEstablishFrameSchema,
    MachineEffectInternalFirewallControlSchema,
    type MachineEffectInternalRecord,
    type MachineEffectInternalResult,
    type MachineEffectInternalRequest,
} from './effectInternalProtocol';
import { createMachineSetupDaemonUserRunner } from './effectInternalDaemonUser';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { isMachineSetupBootstrapBasisV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

type ProcessIo = Readonly<{
    stdin?: Readable;
    stdout?: Writable;
    signal?: AbortSignal;
    runNative?: (command: machineSetup.MachineSetupNativeCommand) => Promise<machineSetup.MachineSetupNativeCommandResult>;
    /** OS boundaries; tests must supply runNative and never reach a real reboot. */
    platform?: NodeJS.Platform;
    readNativeInit?: () => Promise<string>;
    readUid?: () => number;
}>;

function invocation(args: readonly string[]) {
    if (args.length < 1 || args.length > 2) return null;
    const operation = args.find(arg => arg.startsWith('--operation-id='))?.slice('--operation-id='.length);
    const installation = args.find(arg => arg.startsWith('--installation-id='))?.slice('--installation-id='.length);
    return operation && (args.length === 1 || installation) && !/[\r\n\0]/u.test(operation + (installation ?? ''))
        ? { operationId: operation, installationId: installation } : null;
}

async function* readFrames(stdin: Readable): AsyncGenerator<string> {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let remaining = '';
    for await (const chunk of stdin as AsyncIterable<unknown>) {
        if (typeof chunk === 'string') remaining += chunk;
        else if (chunk instanceof Uint8Array) {
            try { remaining += decoder.decode(chunk, { stream: true }); }
            finally { chunk.fill(0); }
        }
        else throw new TypeError('invalid_request');
        let end: number;
        while ((end = remaining.indexOf('\n')) !== -1) {
            yield remaining.slice(0, end);
            remaining = remaining.slice(end + 1);
        }
    }
    remaining += decoder.decode();
    if (remaining) yield remaining;
}

function parseFrame(frame: string) {
    try { return JSON.parse(frame) as unknown; } catch { return undefined; }
}

/** Fixed root interpreter; ordinary JSON+EOF or an explicit reviewed CHECK→APPLY dialogue. */
export async function runMachineSetupEffectInternal(args: readonly string[], io: ProcessIo = {}): Promise<number> {
    const stdin = io.stdin ?? process.stdin;
    const stdout = io.stdout ?? process.stdout;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const stopReading = () => { stdin.destroy(); };
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    io.signal?.addEventListener('abort', cancel, { once: true });
    controller.signal.addEventListener('abort', stopReading, { once: true });
    if (io.signal?.aborted) cancel();
    const emit = (record: MachineEffectInternalRecord) => { stdout.write(JSON.stringify(record) + '\n'); };
    const finish = (result: MachineEffectInternalResult) => {
        emit({ type: 'result', result: result.status === 'checked'
            ? result : { ...result, completedStepIds: [...result.completedStepIds] } });
        return result.status === 'applied' || result.status === 'checked' ? 0 : 1;
    };
    const refused = (status: machineSetup.MachineSetupApplyResultV1['status'], reason: string) =>
        finish({ status, reason, completedStepIds: [], daemonRestartRequired: false });
    let mutationStarted = false;
    let administratorEstablishment: machineSetup.MachineSetupAdministratorEstablishmentV1 | undefined;
    let connectorSession: import('./effectInternalSecretGrant').MachineConnectorSecretGrantSession | undefined;
    let connectorMaterializer: ReturnType<typeof import('./effectInternalSecretGrant').bindMachineConnectorSecretGrantMaterializer> | undefined;
    const frames = readFrames(stdin);
    try {
        if (controller.signal.aborted) return refused('cancelled', 'cancelled');
        const currentInvocation = invocation(args);
        if (!currentInvocation) return refused('unavailable', 'invalid_invocation');
        const readUid = io.readUid ?? process.getuid;
        if (!readUid) return refused('unsupported', 'platform_unsupported');
        if (readUid() !== 0) return refused('unavailable', 'needs_admin_to_check');
        // Sudo must consume its password frame before this process announces
        // readiness; the caller sends the plan only after observing this record.
        emit({ type: 'ready' });
        const first = await frames.next();
        if (controller.signal.aborted) return refused('cancelled', 'cancelled');
        if (first.done || !first.value.trim()) return refused('unavailable', 'input_closed');
        const parsed = MachineEffectInternalRequestSchema.safeParse(parseFrame(first.value));
        if (!parsed.success) return refused('unavailable', 'invalid_request');
        let request = parsed.data;
        const continues = request.mode === 'check' && 'continueWithApply' in request && request.continueWithApply === true;
        const firewallDialogue = 'firewallStages' in request && request.firewallStages === true;
        const connectorDialogue = 'connectorSecretGrant' in request && request.connectorSecretGrant === true;
        if (firewallDialogue && (connectorDialogue || !('machineId' in request)
            || !('firewallIntent' in request) && (!('plans' in request)
                || request.plans.some(entry => entry.plan.steps.length !== 1 || entry.plan.steps[0]?.kind !== 'firewall')))) {
            return refused('unavailable', 'invalid_request');
        }
        if (connectorDialogue && 'machineId' in request) {
            const grantModule = await import('./effectInternalSecretGrant');
            const next = await frames.next();
            if (next.done) return refused('unavailable', 'input_closed');
            connectorSession = grantModule.MachineConnectorSecretGrantSessionSchema.parse(parseFrame(next.value));
            next.value = '';
            connectorMaterializer = grantModule.bindMachineConnectorSecretGrantMaterializer({ session: connectorSession,
                machineId: request.machineId, installationId: request.installationId, operationId: currentInvocation.operationId,
                steps: 'firewallIntent' in request ? []
                    : 'plans' in request ? request.plans.flatMap(entry => entry.plan.steps) : request.mode === 'check' ? request.steps : request.intent.steps, signal: controller.signal,
                async exchange(control) {
                    controller.signal.throwIfAborted();
                    stdout.write(JSON.stringify(control) + '\n');
                    const reply = await frames.next();
                    if (reply.done) throw new Error('input_closed');
                    const value = grantModule.MachineConnectorSecretGrantReplySchema.parse(parseFrame(reply.value));
                    if (value.operation !== control.operation) throw new Error('invalid_request');
                    controller.signal.throwIfAborted();
                    return value;
                },
            });
        }
        if (!continues && !connectorDialogue && !firewallDialogue) {
            if (request.mode === 'apply' && 'administrator' in request && request.administrator) {
                const next = await frames.next();
                if (next.done) return refused('unavailable', 'invalid_request');
                const credential = MachineAdministratorEstablishFrameSchema.safeParse(parseFrame(next.value));
                if (!credential.success) return refused('unavailable', 'invalid_request');
                const selector = request.administrator;
                const entry = request.plans[0]!;
                const target = entry.plan.steps.find(step => step.id === selector.stepId);
                if (!isMachineSetupBootstrapBasisV1(entry.plan.basis) || credential.data.operationId !== entry.plan.basis.operationId
                    || credential.data.planDigest !== entry.plan.planDigest
                    || credential.data.stepId !== selector.stepId || credential.data.username !== selector.username
                    || target?.kind !== 'user' || target.username !== selector.username) return refused('unavailable', 'invalid_request');
                administratorEstablishment = { ...selector, password: Buffer.from(credential.data.password, 'utf8') };
                // JS strings cannot be zeroized. Drop the parsed credential
                // reference; the owned mutable bytes are erased in finally.
                credential.data.password = '';
            }
            // Ordinary requests still require EOF before effects, rejecting a
            // second frame even if it arrived in the first native read.
            for await (const extra of frames) if (extra.trim()) return refused('unavailable', 'invalid_request');
        }
        const matchesInvocation = (value: MachineEffectInternalRequest) => {
            const bases = 'plans' in value ? value.plans.map(entry => entry.plan.basis) : value.mode === 'check' ? [value.basis] : [value.intent.basis];
            return bases.every(basis => isMachineSetupBootstrapBasisV1(basis)
                ? currentInvocation.installationId === undefined
                : 'installationId' in value && value.installationId === currentInvocation.installationId && basis.machineId === value.machineId);
        };
        // The live caller owns operation admission. Keep installation and
        // Machine binding here; operation ids are correlation only.
        if (!matchesInvocation(request)) return refused('plan_changed', 'plan_stale');
        if (request.mode === 'check' && 'plans' in request) {
            const plans: { plan: machineSetup.MachineSetupEffectPlanV1 }[] = [];
            for (const entry of request.plans) {
                const plan = machineSetup.readMachineSetupEffectPlanV1(entry.plan);
                if (!plan) return refused('plan_changed', 'plan_stale');
                plans.push({ plan });
            }
            request = { ...request, plans };
        }
        const nativePrograms = 'firewallIntent' in request ? []
            : 'plans' in request ? request.plans.map(entry => entry.plan) : request.mode === 'check' ? [request] : [request.intent];
        const needsDaemonContext = nativePrograms.some(program => [...(('checks' in program ? program.checks : undefined) ?? []), ...program.steps]
            .some(step => machineSetup.readMachineSetupStepExecutionUserV1(step) === 'daemon'));
        const runAsDaemonUser = needsDaemonContext ? await createMachineSetupDaemonUserRunner({
            username: 'daemonUsername' in request ? request.daemonUsername : undefined,
            context: 'daemonExecutionContext' in request ? request.daemonExecutionContext : undefined,
            platform: io.platform ?? process.platform,
            sudoUsername: process.env.SUDO_USER, sudoUid: process.env.SUDO_UID,
            signal: controller.signal, runNative: io.runNative ?? machineSetup.runMachineSetupNativeCommand,
        }) : undefined;
        const backend = machineSetup.createMachineSetupNativeBackend({ signal: controller.signal,
            ...(io.platform ? { platform: io.platform } : {}),
            ...(io.readNativeInit ? { readNativeInit: io.readNativeInit } : {}),
            ...('machineId' in request ? { daemonUsername: 'daemonUsername' in request ? request.daemonUsername ?? null : null } : {}),
            ...(io.runNative ? { run: io.runNative } : {}),
            ...(runAsDaemonUser ? { runAsDaemonUser } : {}),
            ...(connectorMaterializer ? { materializeSecretGrant: connectorMaterializer.materialize } : {}) });
        if (request.mode === 'check') {
            const plans: { plan: machineSetup.MachineSetupEffectPlanV1 }[] = [];
            if ('firewallIntent' in request) {
                const observation = await backend.observe(machineSetup.createMachineFirewallTransitionObservationStepV1(request.firewallIntent));
                const native = machineSetup.readMachineFirewallTransitionFactsV1(observation);
                const materialized = machineSetup.materializeMachineFirewallTransitionV1(request.firewallIntent, native);
                if (materialized.status === 'review_required') return refused('plan_changed', materialized.reason);
                for (const step of materialized.steps) {
                    plans.push({ plan: await machineSetup.checkMachineSetupEffectPlan({ basis: request.basis, steps: [step], backend }) });
                }
            } else if ('plans' in request) {
                for (const { plan } of request.plans) {
                    plans.push({ plan: await machineSetup.checkMachineSetupEffectPlan({
                        basis: plan.basis, steps: plan.steps,
                        ...(plan.checks !== undefined ? { checks: plan.checks } : {}),
                        ...(plan.selectedCheckIds !== undefined ? { selectedCheckIds: plan.selectedCheckIds } : {}), backend,
                    }) });
                }
            } else {
                plans.push({ plan: await machineSetup.checkMachineSetupEffectPlan({ basis: request.basis, steps: request.steps,
                    ...(request.checks !== undefined ? { checks: request.checks } : {}), backend }) });
            }
            if (controller.signal.aborted) return refused('cancelled', 'cancelled');
            finish('plans' in request || 'firewallIntent' in request ? { status: 'checked', plans } : { status: 'checked', plan: plans[0]!.plan });
            if (!continues) return 0;
            const next = await frames.next();
            if (next.done) return refused('cancelled', 'input_closed');
            const followup = MachineEffectInternalRequestSchema.safeParse(parseFrame(next.value));
            if (!followup.success || followup.data.mode !== 'apply' || !('plans' in followup.data)) return refused('unavailable', 'invalid_request');
            if (!connectorDialogue && !firewallDialogue) for await (const extra of frames) if (extra.trim()) return refused('unavailable', 'invalid_request');
            if (!matchesInvocation(followup.data) || followup.data.plans.length !== plans.length
                || ('daemonUsername' in followup.data ? followup.data.daemonUsername : undefined)
                    !== ('daemonUsername' in request ? request.daemonUsername : undefined)
                || !sameStrictJsonValue('daemonExecutionContext' in followup.data ? followup.data.daemonExecutionContext ?? null : null,
                    'daemonExecutionContext' in request ? request.daemonExecutionContext ?? null : null)
                || ('connectorSecretGrant' in followup.data && followup.data.connectorSecretGrant === true) !== connectorDialogue
                || ('firewallStages' in followup.data && followup.data.firewallStages === true) !== firewallDialogue
                || followup.data.plans.some((entry, index) => entry.plan.planDigest !== plans[index]!.plan.planDigest)) return refused('plan_changed', 'plan_stale');
            request = followup.data;
        }
        const result = await machineSetup.applyMachineSetupEffectPlans({
            ...('intent' in request ? { intent: request.intent } : { plans: request.plans }),
            backend,
            signal: controller.signal,
            ...('daemonUsername' in request && request.daemonUsername ? { daemonUsername: request.daemonUsername } : {}),
            ...(administratorEstablishment ? { administratorEstablishment } : {}),
            ...(firewallDialogue ? { onStaged: async ({ planIndex, planDigest, recovery, verifyNative }: machineSetup.MachineSetupStagedFirewallV1) => {
                emit({ type: 'firewall.staged', planIndex, planDigest, recovery });
                while (!controller.signal.aborted) {
                    const next = await frames.next();
                    if (next.done) return 'undo' as const;
                    const control = MachineEffectInternalFirewallControlSchema.safeParse(parseFrame(next.value));
                    if (!control.success || control.data.planIndex !== planIndex || control.data.planDigest !== planDigest) return 'undo' as const;
                    if (control.data.type === 'firewall.verify') {
                        emit({ type: 'firewall.verified', planIndex, planDigest, ok: await verifyNative() });
                    } else {
                        if (!('machineId' in request) || control.data.machineId !== request.machineId
                            || control.data.installationId !== request.installationId || control.data.operationId !== request.operationId) return 'undo' as const;
                        return control.data.decision;
                    }
                }
                return 'undo' as const;
            } } : {}),
            onProgress: event => {
                if (event.phase === 'apply') mutationStarted = true;
                emit({ type: 'progress', ...event });
            },
        });
        return finish(result);
    } catch {
        // Native stderr, parse diagnostics and thrown payloads are never part
        // of the retained operation channel.
        return refused(mutationStarted ? 'outcome_unknown' : controller.signal.aborted ? 'cancelled' : 'unavailable',
            controller.signal.aborted ? 'cancelled' : 'native_effect_failed');
    } finally {
        administratorEstablishment?.password.fill(0);
        connectorMaterializer?.dispose();
        if (connectorSession) connectorSession.token = '';
        // This private entry owns its input. A typed refusal must release the
        // pipe even when the caller was waiting for the terminal before EOF.
        stdin.destroy();
        try { await frames.return(undefined); } catch { /* The input is already closed; never expose raw cleanup errors. */ }
        process.removeListener('SIGINT', cancel);
        process.removeListener('SIGTERM', cancel);
        io.signal?.removeEventListener('abort', cancel);
        controller.signal.removeEventListener('abort', stopReading);
    }
}
