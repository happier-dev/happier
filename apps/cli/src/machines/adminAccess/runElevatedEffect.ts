import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { InteractiveSystemTaskContext } from '@happier-dev/cli-common/systemTasks/interactiveTaskKinds';
import { MachineAdminAccessFieldV1, MachineAdminAccessV1Schema,
    type MachineAdminAccessV1, type MachineAdminAccessObservationV1, type MachineElevatedResultV1 } from '@happier-dev/protocol';
import type { MachineFirewallRecoveryV1 } from '@happier-dev/protocol/machines/adminAccessV1';
import type { MachineElevatedEffectV1, MachineSetupEffectPlanV1, MachineRecipeStepV1, MachineRecipeCheckV1,
    MachineFirewallTransitionIntentV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readMachineSetupStepExecutionUserV1,
    type MachineSetupApplyResultV1, type MachineSetupStageDecisionV1 } from '@happier-dev/cli-common/machineSetup';
import { buildManagedSudoersSteps } from './managedSudoers';
import { MachineEffectInternalRecordSchema, type MachineEffectInternalRequest } from '../setup/effectInternalProtocol';
import type { MachineConnectorSecretGrantHostRequest } from '@/deployments/secrets/readEnvironmentSecretLaunchAdmissionForHost';
import { getFirstPartyComponentCatalogEntry, resolveFirstPartyInstallLayout, resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { MachineSetupObservationReasonV1Schema } from '@happier-dev/protocol/machines/setup/machineSetupObservationV1';

/** The managed install layout is shared by policy transitions and recipe work. */
export function resolveInstalledMachineEffectCli(): string {
    const channel = resolveManagedCliReleaseChannelSync().ringId;
    const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', channel });
    return join(layout.currentPath, getFirstPartyComponentCatalogEntry('happier-cli').binaryRelativePath);
}

export type MachineElevationProcess = Readonly<{
    stdin: Writable; stdout: Readable; stderr: Readable;
    settled: Promise<Readonly<{ code: number | null; signal: string | null }>>;
    terminate: () => Promise<void>;
}>;
export type MachineElevationSpawn = (input: Readonly<{
    executable: string; args: readonly string[]; installedCli?: string;
}>) => MachineElevationProcess;
export type RunElevatedEffectInput = Readonly<{
    machineId: string; operationId: string; signal?: AbortSignal;
    effect: MachineElevatedEffectV1;
    /** Notification before the single irreversible frame may reach the child. */
    onRebootDispatch?: () => void | Promise<void>;
    /** Successful root settlement, including an already-satisfied no-op. Host-only. */
    onSetupApplied?: (result: MachineSetupApplyResultV1) => void;
}>;
export type MachineElevationDependencies = Readonly<{
    installationId: string; installedCli: string;
    readPolicy: () => Promise<MachineAdminAccessV1>;
    observe: () => Promise<MachineAdminAccessObservationV1>;
    verifyCurrent: (boundary?: 'reboot_dispatch') => Promise<boolean>;
    prompt?: InteractiveSystemTaskContext['prompt'];
    emit?: InteractiveSystemTaskContext['emit'];
    spawn?: MachineElevationSpawn;
    /** Exact P21/P42 admitted invocation; keys and material remain inside the elevated child. */
    connectorSecretGrant?: MachineConnectorSecretGrantHostRequest;
}>;

class ManagedMachineCliUnavailableError extends Error {
    constructor(readonly executablePath: string) {
        super('Install or repair the managed Happier CLI on this Machine, then retry the operation.');
        this.name = 'ManagedMachineCliUnavailableError';
    }
}

/** The native process boundary owns executable availability, before sudo or stdin. */
const spawnElevation: MachineElevationSpawn = input => {
    if (input.installedCli) {
        try { accessSync(input.installedCli, constants.X_OK); }
        catch { throw new ManagedMachineCliUnavailableError(input.installedCli); }
    }
    const child = spawn(input.executable, [...input.args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const settled = new Promise<{ code: number | null; signal: string | null }>(resolve => {
        child.once('error', () => resolve({ code: null, signal: null }));
        child.once('close', (code, signal) => resolve({ code, signal }));
    });
    return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, settled,
        async terminate() { child.kill('SIGTERM'); await settled; } };
};

function hasPromptlessElevation(policy: MachineAdminAccessV1, observation: MachineAdminAccessObservationV1): boolean {
    return policy.mode === 'preauthorized' && observation.reasonCode !== 'platformUnsupported'
        && observation.passwordlessSudoToRoot === 'allowed';
}

/** Retention consumes the same daemon policy/native privilege decision as ordinary elevation.
 * Preparation has no OS effect; None/Ask or missing native permission keeps provider API Stop available. */
export async function prepareMachinePoweroff(dependencies: Pick<MachineElevationDependencies, 'readPolicy' | 'observe' | 'spawn'>,
    signal?: AbortSignal): Promise<(() => Promise<void>) | null> {
    signal?.throwIfAborted();
    const policy = await dependencies.readPolicy();
    if (policy.mode !== 'preauthorized') return null;
    const observation = await dependencies.observe();
    if (!hasPromptlessElevation(policy, observation)) return null;
    return async () => {
        signal?.throwIfAborted();
        const child = (dependencies.spawn ?? spawnElevation)({ executable: 'sudo', args: ['-n', '-u', 'root', '--', '/sbin/poweroff'] });
        child.stdin.end();
        child.stdout.resume();
        child.stderr.resume();
        const cancel = () => { void child.terminate(); };
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        try {
            const result = await child.settled;
            if (result.code !== 0 || signal?.aborted) throw Object.assign(new Error('native_intent_unconfirmed'), { code: 'native_intent_unconfirmed' });
        } finally { signal?.removeEventListener('abort', cancel); }
    };
}

function passwordFrame(answer: unknown): Buffer | null {
    if (!answer || typeof answer !== 'object' || !('password' in answer) || Object.keys(answer).length !== 1
        || typeof answer.password !== 'string' || answer.password.length === 0 || /[\r\n\0]/.test(answer.password)) return null;
    return Buffer.from(answer.password + '\n', 'utf8');
}
async function writeFrame(stream: Writable, frame: Buffer | string, end = false): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const done = (error?: Error | null) => error ? reject(error) : resolve();
        if (end) stream.end(frame, done); else stream.write(frame, done);
    });
}

export type RunElevatedAdminAccessTransitionInput = Readonly<{
    machineId: string; operationId: string; previousPolicy: MachineAdminAccessV1; policy: MachineAdminAccessV1;
    signal?: AbortSignal; verifyCurrent: () => Promise<boolean>;
}>;

type ElevatedRequest =
    | Readonly<{ kind: 'apply'; effect: MachineElevatedEffectV1; firewall?: MachineFirewallStageCallbacks }>
    | Readonly<{ kind: 'nativeApply'; basis: Extract<MachineSetupEffectPlanV1['basis'], { kind: 'adminAccess' | 'reboot' }>; steps: MachineRecipeStepV1[] }>
    | Readonly<{ kind: 'check'; basis: MachineSetupEffectPlanV1['basis']; steps: MachineRecipeStepV1[]; checks?: MachineRecipeCheckV1[] }>
    | Readonly<{ kind: 'checkApply'; basis: Extract<MachineSetupEffectPlanV1['basis'], { kind: 'setup' }>;
        firewallIntent: MachineFirewallTransitionIntentV1; firewall: MachineFirewallStageCallbacks }>
    | Readonly<{ kind: 'checkApply'; basis: MachineSetupEffectPlanV1['basis']; steps: MachineRecipeStepV1[]; checks?: MachineRecipeCheckV1[];
        acceptPlan?: (plan: MachineSetupEffectPlanV1) => Promise<boolean> }>;
export type MachineRebootElevatedResultV1 = Exclude<MachineElevatedResultV1, { outcome: 'applied' }>
    | Readonly<{ outcome: 'dispatched' }>;
type ElevatedProcessResult = MachineElevatedResultV1
    | Readonly<{ outcome: 'checked'; plan: MachineSetupEffectPlanV1 }>;

export type MachineFirewallStageCallbacks = Readonly<{
    onStage(input: Readonly<{ planIndex: number; planDigest: string; recovery: MachineFirewallRecoveryV1;
        verifyNative(): Promise<boolean>;
    }>): Promise<MachineSetupStageDecisionV1>;
}>;

/** One P10 invocation binds the complete reviewed list before Stage A. The
 * original undo remains held until FINAL verification and the caller's CAS. */
export type RunElevatedMachineFirewallPlansInput = Pick<RunElevatedEffectInput, 'machineId' | 'operationId' | 'signal'>
    & MachineFirewallStageCallbacks & (Readonly<{
        plans: Extract<MachineElevatedEffectV1, { kind: 'setupOperation' }>['plans'];
    }> | Readonly<{
        basis: Extract<MachineSetupEffectPlanV1['basis'], { kind: 'setup' }>;
        firewallIntent: MachineFirewallTransitionIntentV1;
    }>);
export async function runElevatedMachineFirewallPlans(input: RunElevatedMachineFirewallPlansInput,
    dependencies: MachineElevationDependencies): Promise<MachineElevatedResultV1> {
    if ('firewallIntent' in input) {
        const result = await runElevatedProcess(input, dependencies, { kind: 'checkApply',
            basis: input.basis, firewallIntent: input.firewallIntent, firewall: input });
        return result.outcome === 'checked' ? { outcome: 'outcome_unknown' } : result;
    }
    if (!input.plans.length || input.plans.some(entry => entry.plan.steps.length !== 1 || entry.plan.steps[0]?.kind !== 'firewall')) {
        return { outcome: 'not_applied', reasonCode: 'denied' };
    }
    const result = await runElevatedProcess(input, dependencies, { kind: 'apply',
        effect: { kind: 'setupOperation', plans: input.plans }, firewall: input });
    return result.outcome === 'checked' ? { outcome: 'outcome_unknown' } : result;
}

/** Ordinary effects always use current desired policy, including None refusal. */
export async function runElevatedEffect(input: RunElevatedEffectInput, dependencies: MachineElevationDependencies): Promise<MachineElevatedResultV1> {
    const result = await runElevatedProcess(input, dependencies, { kind: 'apply', effect: input.effect });
    return result.outcome === 'checked' ? { outcome: 'outcome_unknown' } : result;
}

/** Host-built setup intent already admitted by its existing operation owner.
 * Ask uses the same transient task prompt and one root CHECK -> APPLY dialogue;
 * it does not require a passwordless preview or invent another approval route.
 */
export async function runElevatedMachineSetupIntent(input: Pick<RunElevatedEffectInput, 'machineId' | 'operationId' | 'signal' | 'onSetupApplied'> & Readonly<{
    basis: MachineSetupEffectPlanV1['basis']; steps: MachineRecipeStepV1[];
    /** Host-only retained-identity guard over root CHECK, before any APPLY. */
    acceptPlan?: (plan: MachineSetupEffectPlanV1) => Promise<boolean>;
}>, dependencies: MachineElevationDependencies): Promise<MachineElevatedResultV1> {
    const result = await runElevatedProcess(input, dependencies, { kind: 'checkApply', basis: input.basis, steps: input.steps,
        ...(input.acceptPlan ? { acceptPlan: input.acceptPlan } : {}) });
    return result.outcome === 'checked' ? { outcome: 'outcome_unknown' } : result;
}

/** P30 retains reboot admission and recovery. Its admitted native operation
 * reaches the root interpreter in one APPLY frame. */
export async function runElevatedMachineReboot(input: Pick<RunElevatedEffectInput,
    'machineId' | 'operationId' | 'signal' | 'onRebootDispatch'>,
    dependencies: MachineElevationDependencies): Promise<MachineRebootElevatedResultV1> {
    const result = await runElevatedProcess(input, dependencies, { kind: 'nativeApply',
        basis: { kind: 'reboot', machineId: input.machineId, operationId: input.operationId },
        steps: [{ id: 'reboot', kind: 'reboot' }] });
    return result.outcome === 'applied' ? { outcome: 'dispatched' }
        : result.outcome === 'checked' ? { outcome: 'outcome_unknown' } : result;
}

/** Safe review uses the same fixed root entry, never APPLY or an Ask prompt. */
export async function checkElevatedMachineSetupPlan(input: Pick<RunElevatedEffectInput, 'machineId' | 'operationId' | 'signal'> & Readonly<{
    basis: MachineSetupEffectPlanV1['basis']; steps: MachineRecipeStepV1[]; checks?: MachineRecipeCheckV1[];
}>, dependencies: MachineElevationDependencies): Promise<MachineSetupEffectPlanV1 | null> {
    const result = await checkElevatedMachineSetupPlanResult(input, dependencies);
    return result.outcome === 'checked' ? result.plan : null;
}

/** Inspect retains the existing elevation owner's typed refusal and recovery. */
export async function checkElevatedMachineSetupPlanResult(input: Parameters<typeof checkElevatedMachineSetupPlan>[0],
    dependencies: MachineElevationDependencies): Promise<ElevatedProcessResult> {
    return runElevatedProcess(input, dependencies, { kind: 'check', basis: input.basis, steps: input.steps,
        ...(input.checks !== undefined ? { checks: input.checks } : {}) });
}

/** Only this exact admitted policy transition may use its previous authority. */
export async function runElevatedAdminAccessTransition(input: RunElevatedAdminAccessTransitionInput,
    dependencies: Omit<MachineElevationDependencies, 'verifyCurrent'>): Promise<MachineElevatedResultV1> {
    try {
        const previousPolicy = MachineAdminAccessV1Schema.parse(input.previousPolicy);
        const policy = MachineAdminAccessV1Schema.parse(input.policy);
        const verifyCurrent = async () => await input.verifyCurrent()
            && MachineAdminAccessFieldV1.equal(policy, await dependencies.readPolicy());
        if (input.signal?.aborted) return { outcome: 'not_applied', reasonCode: 'cancelled' };
        if (!await verifyCurrent()) return { outcome: 'not_applied', reasonCode: 'plan_stale' };
        const observation = await dependencies.observe();
        if (input.signal?.aborted) return { outcome: 'not_applied', reasonCode: 'cancelled' };
        if (observation.reasonCode === 'platformUnsupported') return { outcome: 'not_applied', reasonCode: 'platform_unsupported' };
        if (previousPolicy.mode === 'none' && policy.mode === 'none') {
            return observation.managedDropIn !== 'absent' || observation.reasonCode === 'observationFailed'
                ? { outcome: 'not_applied', reasonCode: 'denied' } : { outcome: 'applied', observation };
        }
        if (!observation.daemonUsername) return { outcome: 'not_applied', reasonCode: 'denied' };
        const steps = buildManagedSudoersSteps({ daemonUsername: observation.daemonUsername, previousPolicy, policy });
        const result = await runElevatedProcess(input, { ...dependencies, verifyCurrent }, {
            kind: 'nativeApply', steps,
            basis: { kind: 'adminAccess', machineId: input.machineId, operationId: input.operationId, previousPolicy, policy },
        }, previousPolicy.mode === 'ask' ? previousPolicy : { version: 1, mode: 'preauthorized' }, observation);
        return result.outcome === 'checked' ? { outcome: 'outcome_unknown' } : result;
    } catch { return { outcome: 'not_applied', reasonCode: input.signal?.aborted ? 'cancelled' : 'denied' }; }
}

/** One target-daemon operation, using the existing task's transient prompt custody. */
async function runElevatedProcess(input: Pick<RunElevatedEffectInput, 'machineId' | 'operationId' | 'signal' | 'onRebootDispatch' | 'onSetupApplied'>,
    dependencies: MachineElevationDependencies, request: ElevatedRequest,
    transitionAuthentication?: MachineAdminAccessV1, transitionObservation?: MachineAdminAccessObservationV1): Promise<ElevatedProcessResult> {
    const result = await runElevatedProcessInternal(input, dependencies, request, transitionAuthentication, transitionObservation);
    if (result.outcome !== 'applied' && result.outcome !== 'checked') {
        // One retained daemon diagnostic; never retain private stdout/stderr,
        // native facts, credentials, or executable/recovery paths.
        logger.warnLocalFile('[machine-elevation] settled', { operationId: input.operationId, outcome: result.outcome,
            ...('reasonCode' in result ? { reasonCode: result.reasonCode } : {}),
            ...('failure' in result && result.failure ? { failure: result.failure } : {}) });
    }
    return result;
}

async function runElevatedProcessInternal(input: Pick<RunElevatedEffectInput, 'machineId' | 'operationId' | 'signal' | 'onRebootDispatch' | 'onSetupApplied'>,
    dependencies: MachineElevationDependencies, request: ElevatedRequest,
    transitionAuthentication?: MachineAdminAccessV1, transitionObservation?: MachineAdminAccessObservationV1): Promise<ElevatedProcessResult> {
    type Refusal = Extract<MachineElevatedResultV1, { outcome: 'not_applied' }>;
    const refused = (reasonCode: Refusal['reasonCode']): MachineElevatedResultV1 => ({ outcome: 'not_applied', reasonCode });
    let nativeFailure: Refusal['failure'];
    const rememberNativeFailure = (kind: NonNullable<Refusal['failure']>['kind'], nativeReason?: string, requiredFact?: string, remedy?: string,
        context?: Pick<NonNullable<Refusal['failure']>, 'stepId' | 'phase'>) => {
        const reason = MachineSetupObservationReasonV1Schema.safeParse(nativeReason);
        const missingFact = requiredFact ?? (nativeReason === 'needs_admin_to_check' ? 'administrator'
            : nativeReason === 'required_fact_unavailable' ? 'nativeSetupObservation' : undefined);
        nativeFailure ??= { kind, ...(reason.success ? { reason: reason.data } : {}), ...(missingFact ? {
            requiredFact: missingFact,
            remedy: `Required native fact ${missingFact} is unavailable. Check this Machine's administrator access and the named prerequisite, then retry the operation.`,
        } : {}), ...(remedy ? { remedy } : {}), ...context };
        return nativeReason === 'platform_unsupported' ? 'platform_unsupported' : nativeFailure.kind;
    };
    const nativeRefused = (reasonCode: Refusal['reasonCode']): MachineElevatedResultV1 => ({
        outcome: 'not_applied', reasonCode, ...(nativeFailure ? { failure: nativeFailure } : {}),
    });
    if (input.signal?.aborted) return refused('cancelled');
    let grantModule: typeof import('../setup/effectInternalSecretGrant') | undefined;
    let connectorSession: ReturnType<typeof import('../setup/effectInternalSecretGrant').createMachineConnectorSecretGrantSession>;
    const firewall = 'firewall' in request ? request.firewall : undefined;
    const reboot = request.kind === 'apply' ? request.effect.plans.some(entry => entry.plan.basis.kind === 'reboot')
        : request.basis.kind === 'reboot';
    const steps = request.kind === 'apply' ? request.effect.plans.flatMap(entry => entry.plan.steps)
        : 'steps' in request ? request.steps : [];
    const checks = request.kind === 'apply' ? request.effect.plans.flatMap(entry => entry.plan.checks ?? [])
        : 'checks' in request ? request.checks ?? [] : [];
    const needsDaemonContext = [...steps, ...checks].some(step => readMachineSetupStepExecutionUserV1(step) === 'daemon');
    const daemonExecutionContext = needsDaemonContext && typeof process.env.HOME === 'string' && typeof process.env.PATH === 'string'
        ? { home: process.env.HOME, path: process.env.PATH } : undefined;
    if (dependencies.connectorSecretGrant && steps.some(step => step.kind === 'file' && step.content?.kind === 'secretGrant')) {
        try {
            grantModule = await import('../setup/effectInternalSecretGrant');
            connectorSession = grantModule.createMachineConnectorSecretGrantSession({ machineId: input.machineId,
                installationId: dependencies.installationId, operationId: input.operationId, steps,
                verifyCurrent: dependencies.verifyCurrent }, dependencies.connectorSecretGrant);
        } catch { return refused('denied'); }
    }
    const currentRefusal = async (finalRebootDispatch = false) => {
        try {
            if (input.signal?.aborted || connectorSession?.signal.aborted) return 'cancelled' as const;
            if (connectorSession) return undefined;
            const current = finalRebootDispatch
                ? await dependencies.verifyCurrent('reboot_dispatch') : await dependencies.verifyCurrent();
            return current ? undefined : 'plan_stale' as const;
        } catch { return input.signal?.aborted || connectorSession?.signal.aborted ? 'cancelled' as const : 'denied' as const; }
    };
    // Policy transitions were admitted before their native observation above.
    // One connector invocation is admitted here. Its later private header
    // exchange signs the exact new request and keeps only local cancel checks.
    if (connectorSession) {
        try { await connectorSession.assertCurrent(); }
        catch { return refused(input.signal?.aborted || connectorSession.signal.aborted ? 'cancelled' : 'denied'); }
    }
    const initialRefusal = transitionAuthentication ? undefined : await currentRefusal();
    if (initialRefusal) return refused(initialRefusal);
    const policy = transitionAuthentication ?? await dependencies.readPolicy();
    if (policy.mode === 'none') return refused('mode_none');
    const observation = transitionObservation ?? await dependencies.observe();
    if (observation.reasonCode === 'platformUnsupported') return refused('platform_unsupported');
    if (policy.mode === 'preauthorized' && !hasPromptlessElevation(policy, observation)) return refused('not_preauthorized');
    const ask = policy.mode === 'ask';
    if (request.kind === 'check' && ask) return refused('not_preauthorized');
    if (ask && !dependencies.prompt) return { outcome: 'needs_attendance', operationId: input.operationId,
        prompt: { kind: 'sudo.password', adminUsername: policy.administratorUsername } };
    let password: Buffer | null = null;
    if (ask) {
        try {
            password = passwordFrame(await dependencies.prompt!({ kind: 'sudo.password',
                message: `Sudo password for ${policy.administratorUsername}`,
                data: { machineId: input.machineId, installationId: dependencies.installationId,
                    operationId: input.operationId, administratorUsername: policy.administratorUsername } }));
        } catch { return refused(input.signal?.aborted ? 'cancelled' : 'denied'); }
        if (!password) return refused('denied');
    }
    const admissionRefusal = firewall ? undefined : await currentRefusal();
    if (input.signal?.aborted || admissionRefusal) {
        password?.fill(0);
        return refused(input.signal?.aborted ? 'cancelled' : admissionRefusal!);
    }
    let child: MachineElevationProcess;
    try {
        child = (dependencies.spawn ?? spawnElevation)({ executable: 'sudo', installedCli: dependencies.installedCli, args: [
            ...(ask ? ['-k', '-S', '-p', '[happier-sudo-password:%p]\n'] : ['-n']), '-u', 'root', '--',
            dependencies.installedCli, 'machine', 'effect-internal', `--operation-id=${input.operationId}`,
            `--installation-id=${dependencies.installationId}`,
        ] });
    } catch (error) {
        password?.fill(0);
        return error instanceof ManagedMachineCliUnavailableError
            ? { outcome: 'not_applied', reasonCode: 'managed_cli_unavailable',
                recovery: { kind: 'install_managed_cli', executablePath: error.executablePath } }
            : refused('denied');
    }
    // Diagnostics and password authentication remain private OS streams. Only
    // the closed interpreter records below may enter retained task events.
    child.stdin.on('error', () => {});
    let submitted = false;
    let requestSent = false;
    let planSent = false;
    let effectStarted = false;
    let protocolFailed = false;
    let stopReason: Refusal['reasonCode'] | undefined;
    let termination: Promise<void> | undefined;
    let terminal: Extract<ReturnType<typeof MachineEffectInternalRecordSchema.parse>, { type: 'result' }> | undefined;
    let checkedFirewallPlans: readonly Readonly<{ plan: MachineSetupEffectPlanV1 }>[] | undefined;
    let stageIndex = -1;
    let stageTask: Promise<void> | undefined;
    let verifyReply: ((ok: boolean) => void) | undefined;
    let verifyPending: Promise<boolean> | undefined;
    const stop = (reason: typeof stopReason) => {
        stopReason ??= reason;
        termination ??= child.terminate().catch(() => { protocolFailed = true; });
        return termination;
    };
    const abort = () => { void stop('cancelled'); };
    input.signal?.addEventListener('abort', abort, { once: true });
    connectorSession?.signal.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    if (connectorSession?.signal.aborted) abort();
    const stderr = createInterface({ input: child.stderr, terminal: false, crlfDelay: Infinity });
    const stdout = createInterface({ input: child.stdout, terminal: false, crlfDelay: Infinity });
    try {
        const auth = (async () => {
            for await (const line of stderr) {
                if (!ask || !line.includes('[happier-sudo-password:')) continue;
                if (line !== `[happier-sudo-password:${policy.administratorUsername}]` || submitted || stopReason || !password) {
                    await stop('denied'); continue;
                }
                submitted = true;
                try { await writeFrame(child.stdin, password); }
                finally { password.fill(0); password = null; }
            }
        })();
        const records = (async () => {
            for await (const line of stdout) {
                let value: unknown;
                try { value = JSON.parse(line); } catch { protocolFailed = true; await stop(stopReason ?? rememberNativeFailure('native_protocol_invalid')); continue; }
                // These child requests never enter the retained operation/event channel.
                if (value && typeof value === 'object' && 'type' in value && value.type === 'connector.secretGrant.control') {
                    const control = grantModule?.MachineConnectorSecretGrantControlSchema.safeParse(value);
                    if (!connectorSession || !control?.success || !requestSent || terminal || stopReason) {
                        protocolFailed = true; await stop(stopReason ?? rememberNativeFailure('native_protocol_invalid')); continue;
                    }
                    // A pending live authority/header callback cannot hold a
                    // cancelled or exited child operation open.
                    const reply = await Promise.race([connectorSession.reply(control.data), child.settled.then(() => undefined)]);
                    if (reply) await writeFrame(child.stdin, JSON.stringify(reply) + '\n');
                    continue;
                }
                const parsed = MachineEffectInternalRecordSchema.safeParse(value);
                if (!parsed.success || terminal) { protocolFailed = true; await stop(stopReason ?? rememberNativeFailure('native_protocol_invalid')); continue; }
                const record = parsed.data;
                // Cancellation can precede the root owner's stop refusal.
                // Retain that physical uncertainty even while draining stopped IO.
                if (requestSent && record.type === 'result' && record.result.status === 'outcome_unknown'
                    && record.result.reason === 'plugin_exec_termination_incomplete') { terminal = record; continue; }
                if (record.type === 'ready') {
                    if (ask && !submitted) { await stop('denied'); continue; }
                    if (requestSent || stopReason) { protocolFailed = true; await stop(stopReason ?? rememberNativeFailure('native_protocol_invalid')); continue; }
                    // CHECK prepares the already-admitted operation. Its
                    // authority boundary is the resulting APPLY frame below.
                    const requestRefusal = firewall || request.kind === 'checkApply' && !connectorSession ? undefined : await currentRefusal();
                    if (input.signal?.aborted || requestRefusal) { await stop(input.signal?.aborted ? 'cancelled' : requestRefusal); continue; }
                    requestSent = true;
                    const frame = request.kind === 'apply'
                        ? request.firewall ? { v: 1, mode: 'check', machineId: input.machineId,
                            installationId: dependencies.installationId, operationId: input.operationId, daemonUsername: observation.daemonUsername,
                            ...(daemonExecutionContext ? { daemonExecutionContext } : {}),
                            firewallStages: true, continueWithApply: true, plans: request.effect.plans } satisfies MachineEffectInternalRequest
                        : { v: 1, mode: 'apply', machineId: input.machineId,
                            installationId: dependencies.installationId, operationId: input.operationId, daemonUsername: observation.daemonUsername,
                            ...(daemonExecutionContext ? { daemonExecutionContext } : {}),
                            ...(connectorSession ? { connectorSecretGrant: true as const } : {}),
                            plans: request.effect.plans } satisfies MachineEffectInternalRequest
                        : request.kind === 'nativeApply' ? { v: 1, mode: 'apply', machineId: input.machineId,
                            installationId: dependencies.installationId, operationId: input.operationId, daemonUsername: observation.daemonUsername,
                            ...(daemonExecutionContext ? { daemonExecutionContext } : {}), intent: { basis: request.basis, steps: request.steps } } satisfies MachineEffectInternalRequest
                        : 'firewallIntent' in request ? { v: 1, mode: 'check', machineId: input.machineId,
                            installationId: dependencies.installationId, operationId: input.operationId, daemonUsername: observation.daemonUsername,
                            firewallStages: true, continueWithApply: true, basis: request.basis,
                            firewallIntent: request.firewallIntent } satisfies MachineEffectInternalRequest
                        : { v: 1, mode: 'check', machineId: input.machineId,
                            installationId: dependencies.installationId, operationId: input.operationId, daemonUsername: observation.daemonUsername,
                            ...(daemonExecutionContext ? { daemonExecutionContext } : {}),
                            ...(connectorSession ? { connectorSecretGrant: true as const } : {}),
                            basis: request.basis, steps: request.steps,
                            ...(request.checks !== undefined ? { checks: request.checks } : {}),
                            ...(request.kind === 'checkApply' ? { continueWithApply: true } : {}) } satisfies MachineEffectInternalRequest;
                    if (reboot && (request.kind === 'apply' || request.kind === 'nativeApply')) {
                        await input.onRebootDispatch?.();
                        const finalRefusal = await currentRefusal(true);
                        if (finalRefusal) { await stop(finalRefusal); continue; }
                    }
                    planSent = request.kind === 'apply' && !request.firewall || request.kind === 'nativeApply';
                    try {
                        await writeFrame(child.stdin, JSON.stringify(frame) + '\n', !connectorSession && !firewall && (planSent || request.kind === 'check'));
                        if (connectorSession) {
                            try { await writeFrame(child.stdin, JSON.stringify(connectorSession.frame) + '\n'); }
                            finally { connectorSession.frame.token = ''; }
                        }
                    }
                    catch {
                        // Child exit can close stdin after accepting the full
                        // request. Keep draining its authoritative result; a
                        // missing terminal record still settles as unknown.
                    }
                } else if (!requestSent || stopReason && !(firewall && stopReason === 'cancelled')) { protocolFailed = true; await stop(stopReason ?? rememberNativeFailure('native_protocol_invalid')); }
                else if (record.type === 'firewall.verified') {
                    if (!firewall || !verifyReply || record.planIndex !== stageIndex
                        || record.planDigest !== checkedFirewallPlans?.[stageIndex]?.plan.planDigest) {
                        protocolFailed = true; await stop(stopReason ?? rememberNativeFailure('native_protocol_invalid')); continue;
                    }
                    verifyReply(stopReason ? false : record.ok); verifyReply = undefined; verifyPending = undefined;
                }
                else if (record.type === 'firewall.staged') {
                    if (!firewall || record.planIndex !== stageIndex + 1 || record.planDigest !== checkedFirewallPlans?.[record.planIndex]?.plan.planDigest) {
                        protocolFailed = true; await stop(stopReason ?? rememberNativeFailure('native_protocol_invalid')); continue;
                    }
                    stageIndex = record.planIndex;
                    if (stopReason) continue;
                    const callbacks = firewall;
                    let open = true;
                    const verifyNative = async () => {
                        if (!open || stopReason || input.signal?.aborted) return false;
                        let pending = verifyPending;
                        if (!verifyPending) {
                            verifyPending = new Promise<boolean>(resolve => { verifyReply = resolve; });
                            pending = verifyPending;
                            await writeFrame(child.stdin, JSON.stringify({ type: 'firewall.verify', planIndex: record.planIndex, planDigest: record.planDigest }) + '\n');
                        }
                        return await Promise.race([pending!, child.settled.then(() => false)]);
                    };
                    stageTask = (async () => {
                        let decision: MachineSetupStageDecisionV1 = 'undo';
                        try {
                            if (!stopReason && !input.signal?.aborted) decision = await Promise.race([
                                callbacks.onStage({ planIndex: record.planIndex, planDigest: record.planDigest, recovery: record.recovery, verifyNative }),
                                child.settled.then(() => 'undo' as const),
                            ]);
                            if (stopReason || input.signal?.aborted) decision = 'undo';
                        } catch { decision = 'undo'; }
                        finally { open = false; }
                        await writeFrame(child.stdin, JSON.stringify({ type: 'firewall.settle', machineId: input.machineId,
                            installationId: dependencies.installationId, operationId: input.operationId,
                            planIndex: record.planIndex, planDigest: record.planDigest, decision }) + '\n');
                    })().catch(async () => { await stop('denied'); });
                }
                else if (record.type === 'result' && record.result.status === 'checked' && 'plans' in record.result) {
                    if (!firewall || planSent) { protocolFailed = true; await stop(stopReason ?? rememberNativeFailure('native_protocol_invalid')); continue; }
                    const plans = record.result.plans;
                    const matches = request.kind === 'apply'
                        ? plans.length === request.effect.plans.length && plans.every(({ plan }, index) => {
                            const admitted = request.effect.plans[index]!.plan;
                            return sameStrictJsonValue(plan.basis, admitted.basis)
                                && sameStrictJsonValue(plan.steps, admitted.steps) && sameStrictJsonValue(plan.checks, admitted.checks)
                                && sameStrictJsonValue(plan.selectedCheckIds, admitted.selectedCheckIds);
                        })
                        : 'firewallIntent' in request && plans.length === 2 && plans.every(({ plan }) =>
                            sameStrictJsonValue(plan.basis, request.basis) && plan.steps.length === 1 && plan.steps[0]?.kind === 'firewall');
                    if (!matches) { await stop('plan_stale'); continue; }
                    if (stopReason) continue;
                    const unavailable = plans.flatMap(entry => entry.plan.nativeFacts)
                        .find(fact => fact.status === 'unavailable' || fact.status === 'unsupported');
                    if (unavailable) { await stop(rememberNativeFailure(unavailable.status === 'unsupported'
                        ? 'native_check_unsupported' : 'native_check_unavailable', unavailable.reason,
                        typeof unavailable.facts.requiredFact === 'string' ? unavailable.facts.requiredFact : unavailable.stepId,
                        typeof unavailable.facts.remedy === 'string' ? unavailable.facts.remedy : undefined)); continue; }
                    dependencies.emit?.({ type: 'machine.setup.checked', data: { plans } });
                    if (input.signal?.aborted || stopReason) { await stop(input.signal?.aborted ? 'cancelled' : stopReason); continue; }
                    checkedFirewallPlans = plans;
                    planSent = true;
                    const frame = { v: 1, mode: 'apply', machineId: input.machineId,
                        installationId: dependencies.installationId, operationId: input.operationId, daemonUsername: observation.daemonUsername,
                        ...(daemonExecutionContext ? { daemonExecutionContext } : {}),
                        firewallStages: true, plans } satisfies MachineEffectInternalRequest;
                    try { await writeFrame(child.stdin, JSON.stringify(frame) + '\n'); } catch { /* Drain the authoritative result. */ }
                }
                else if (record.type === 'result' && record.result.status === 'checked' && 'plan' in record.result) {
                    if (request.kind === 'apply' || request.kind === 'nativeApply' || 'firewallIntent' in request || planSent) { protocolFailed = true; await stop(stopReason ?? rememberNativeFailure('native_protocol_invalid')); continue; }
                    const plan = record.result.plan;
                    if (!sameStrictJsonValue(plan.basis, request.basis) || !sameStrictJsonValue(plan.steps, request.steps)
                        || !sameStrictJsonValue(plan.checks, request.checks)) {
                        await stop('plan_stale'); continue;
                    }
                    if (request.kind === 'check') { terminal = record; if (connectorSession) child.stdin.end(); continue; }
                    const unavailable = plan.nativeFacts.find(fact => fact.status === 'unavailable' || fact.status === 'unsupported');
                    if (unavailable) { await stop(rememberNativeFailure(unavailable.status === 'unsupported'
                        ? 'native_check_unsupported' : 'native_check_unavailable', unavailable.reason,
                        typeof unavailable.facts.requiredFact === 'string' ? unavailable.facts.requiredFact : unavailable.stepId,
                        typeof unavailable.facts.remedy === 'string' ? unavailable.facts.remedy : undefined)); continue; }
                    if (request.acceptPlan && !await request.acceptPlan(plan)) { await stop('denied'); continue; }
                    dependencies.emit?.({ type: 'machine.setup.checked', data: { plan } });
                    const requestRefusal = await currentRefusal();
                    if (input.signal?.aborted || requestRefusal) { await stop(input.signal?.aborted ? 'cancelled' : requestRefusal); continue; }
                    if (reboot) {
                        await input.onRebootDispatch?.();
                        // Publication may await network facts. Recheck at the
                        // actual APPLY edge after that awaited boundary.
                        const finalRefusal = await currentRefusal(true);
                        if (finalRefusal) { await stop(finalRefusal); continue; }
                    }
                    const frame = { v: 1, mode: 'apply', machineId: input.machineId,
                        installationId: dependencies.installationId, operationId: input.operationId, daemonUsername: observation.daemonUsername,
                        ...(daemonExecutionContext ? { daemonExecutionContext } : {}),
                        ...(connectorSession ? { connectorSecretGrant: true as const } : {}),
                        plans: [{ plan }] } satisfies MachineEffectInternalRequest;
                    planSent = true;
                    try { await writeFrame(child.stdin, JSON.stringify(frame) + '\n', !connectorSession); } catch { /* Drain the authoritative result. */ }
                }
                else if (!planSent) {
                    if (record.type === 'result' && record.result.status !== 'checked' && record.result.status !== 'applied'
                        && record.result.completedStepIds.length === 0) terminal = record;
                    else { protocolFailed = true; await stop(stopReason ?? rememberNativeFailure('native_protocol_invalid')); }
                }
                else if (record.type === 'progress') {
                    if (stopReason) continue;
                    if (record.phase === 'apply' && record.status === 'started') effectStarted = true;
                    dependencies.emit?.({ type: 'machine.setup.progress', stepId: record.stepId,
                        data: { phase: record.phase, status: record.status,
                            ...(record.planIndex !== undefined ? { planIndex: record.planIndex } : {}),
                            ...(record.reason ? { reason: record.reason } : {}) } });
                }
                else { terminal = record; if (connectorSession || firewall) child.stdin.end(); dependencies.emit?.({ type: 'machine.setup.result', data: record.result }); }
            }
        })();
        const settled = await child.settled;
        const readers = await Promise.allSettled([auth, records]);
        verifyReply?.(false);
        await stageTask;
        if (readers.some(reader => reader.status === 'rejected')) protocolFailed = true;
        await termination;
        if (terminal?.result.status === 'outcome_unknown' && terminal.result.reason === 'plugin_exec_termination_incomplete') {
            throw Object.assign(new Error('Native process termination could not be verified'), { code: terminal.result.reason });
        }
        if (protocolFailed || !terminal) {
            if (!stopReason && ask && !requestSent && !protocolFailed) return refused('denied');
            if (!stopReason) rememberNativeFailure('native_protocol_invalid');
            return planSent ? { outcome: 'outcome_unknown', ...(nativeFailure ? { failure: nativeFailure } : {}) }
                : nativeRefused(stopReason ?? 'native_protocol_invalid');
        }
        const result = terminal.result;
        if (reboot && result.status === 'unsupported' && result.reason === 'platform_unsupported') return refused('platform_unsupported');
        if (result.status === 'checked') return request.kind === 'check' && settled.code === 0 && 'plan' in result
            ? { outcome: 'checked', plan: result.plan } : { outcome: 'outcome_unknown' };
        const failureContext = 'stepId' in result && result.stepId
            ? { stepId: result.stepId, phase: effectStarted ? 'apply' as const : 'check' as const } : undefined;
        if (!nativeFailure && result.failure) {
            const failure = result.failure;
            rememberNativeFailure(failure.kind, failure.reason, failure.requiredFact, failure.remedy, failureContext);
            nativeFailure = { ...(nativeFailure ?? {}), ...failure };
        }
        if (result.status === 'applied') {
            if (settled.code !== 0 || settled.signal !== null) return { outcome: 'outcome_unknown' };
            input.onSetupApplied?.(result);
            if (reboot) return { outcome: 'applied', observation };
            try { return { outcome: 'applied', observation: await dependencies.observe() }; }
            catch { return { outcome: 'outcome_unknown' }; }
        }
        const requiredFact = result.requiredFact ?? (result.reason === 'required_fact_unavailable' || result.reason === 'needs_admin_to_check'
            ? result.stepId : undefined);
        if (result.status === 'plan_changed') return refused('plan_stale');
        if (result.status === 'unavailable' && !effectStarted && result.completedStepIds.length === 0) {
            return nativeRefused(rememberNativeFailure('native_check_unavailable', result.reason, requiredFact, undefined, failureContext));
        }
        if (result.status === 'cancelled' && (result.completedStepIds.length === 0 || result.restoration)) {
            return { outcome: 'not_applied', reasonCode: 'cancelled', ...(result.restoration ? { restoration: result.restoration } : {}) };
        }
        // A missing prerequisite before any completed step is a known refusal.
        // A failed native command may have partly run despite zero completed steps.
        if (result.status === 'failed' && result.reason === 'required_fact_unavailable' && result.completedStepIds.length === 0) {
            return nativeRefused(rememberNativeFailure('native_effect_failed', result.reason, requiredFact, undefined, failureContext));
        }
        if (result.status === 'outcome_unknown' || effectStarted || result.completedStepIds.length > 0) {
            rememberNativeFailure('native_effect_failed', result.reason, requiredFact, undefined, failureContext);
            return { outcome: 'outcome_unknown', failure: nativeFailure, ...(result.restoration ? { restoration: result.restoration } : {}) };
        }
        return nativeRefused(rememberNativeFailure(result.reason === 'invalid_request' ? 'native_protocol_invalid' : 'native_effect_failed',
            result.reason, requiredFact, undefined, failureContext));
    } catch (error) {
        if (error !== null && typeof error === 'object' && 'code' in error
            && error.code === 'plugin_exec_termination_incomplete') throw error;
        await stop(rememberNativeFailure('native_protocol_invalid'));
        return planSent ? { outcome: 'outcome_unknown', failure: nativeFailure } : nativeRefused(stopReason ?? 'native_protocol_invalid');
    }
    finally {
        password?.fill(0);
        if (connectorSession) connectorSession.frame.token = '';
        input.signal?.removeEventListener('abort', abort);
        connectorSession?.signal.removeEventListener('abort', abort);
        stdout.close(); stderr.close();
    }
}
