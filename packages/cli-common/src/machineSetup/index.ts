import { createHash } from 'node:crypto';
import { MachineAdministratorUsernameV1Schema } from '@happier-dev/protocol/machines/adminAccessV1';
import type { MachineFirewallRecoveryV1 as MachineSetupFirewallRecoveryV1,
    MachineFirewallRestorationV1 as MachineSetupFirewallRestorationV1 } from '@happier-dev/protocol/machines/adminAccessV1';
export type { MachineFirewallRecoveryV1 as MachineSetupFirewallRecoveryV1,
    MachineFirewallRestorationV1 as MachineSetupFirewallRestorationV1 } from '@happier-dev/protocol/machines/adminAccessV1';
import { MachineSetupEffectPlanV1Schema, MachineSetupElevatedEffectV1Schema, isMachineSetupBootstrapBasisV1, type MachineRecipeStepV1, type MachineRecipeCheckV1, type MachineSetupEffectPlanV1, type MachineSetupStepObservationV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

export type { MachineRecipeStepV1, MachineSetupEffectPlanV1, MachineSetupStepObservationV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
export { MachineSetupEffectPlanV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
export { createMachineSetupNativeBackend, runMachineSetupNativeCommand, type MachineSetupNativeCommand, type MachineSetupNativeCommandResult, type MachineSetupSecretGrantMaterial } from './nativeBackend.js';
export { createDockerEngineSetupSteps } from './dockerEngine.js';
export { parseNativeDockerEngineInfo, type NativeDockerEngineFacts } from './nativeDockerEngine.js';
export * from './effectInternalProtocol.js';
export { MANAGED_SUDOERS_PATH, buildManagedSudoersSteps, recognizeManagedSudoersDropIn } from './managedSudoers.js';
export { assertAgentIsolationLaunchPrincipal, buildAgentIsolationBootstrapSteps, buildAgentIsolationToolsRootStep } from './agentIsolationBootstrap.js';
export { buildUserManagerGroupRefreshStep } from './userManagerGroups.js';
export { createMachineFirewallTransitionObservationStepV1, readMachineFirewallTransitionFactsV1,
    materializeMachineFirewallTransitionV1, type MachineFirewallTransitionFactsV1,
    type MachineFirewallTransitionMaterializationV1 } from './nativeFirewallTransition.js';
export { nativeCaddyProfile, createNativeCaddySetupInput, createCaddyContainerSetupSteps, ensureNativeCaddyContainer, readCaddyContainerFirewallExposures, nativeCaddyImage,
    createNativeCaddyBindings, observeNativeCaddyContainer, connectNativeCaddyNetworks, type NativeCaddyObservationResult,
    createNativeCaddyAdminExchange, hashNativeCaddyPassword, type NativeCaddyAdminExchange,
    type NativeCaddyPublishedEndpoint, type NativeCaddyServerObservation,
    type NativeCaddySetupInput, type NativeCaddyFirewallExposure, type NativeCaddyContainerResult } from './nativeCaddy.js';

export { createCloudflareConnectorSetupSteps, createCloudflareConnectorRemovalSteps,
    observeNativeCloudflareConnector, ensureNativeCloudflareConnector, removeNativeCloudflareConnector,
    type NativeCloudflareConnectorSelection, type NativeCloudflareConnectorInput,
    type NativeCloudflareConnectorObservation, type NativeCloudflareConnectorResult,
    type NativeCloudflareConnectorRemovalResult } from './nativeCloudflare.js';

export type MachineSetupNativeStageV1 = Readonly<{
    recovery: MachineSetupFirewallRecoveryV1;
    verify(): Promise<boolean>;
    commit(): void;
    /** Resolves only after the native owner verifies its captured original state. */
    undo(): Promise<void>;
}>;
export type MachineSetupStageDecisionV1 = 'continue' | 'commit' | 'undo';
export type MachineSetupStagedFirewallV1 = Readonly<{
    planIndex: number; planDigest: string; recovery: MachineSetupFirewallRecoveryV1; verifyNative(): Promise<boolean>;
}>;

export interface MachineSetupBackend {
    observe(step: MachineRecipeStepV1 | MachineRecipeCheckV1): Promise<MachineSetupStepObservationV1>;
    /** Only the native useradd owner can report that this invocation created an account. */
    apply(step: MachineRecipeStepV1): Promise<void | Readonly<{ createdUser: true }>>;
    stage?(step: Extract<MachineRecipeStepV1, { kind: 'firewall' }>): Promise<MachineSetupNativeStageV1>;
    establishAdministrator?(input: Readonly<{ step: Extract<MachineRecipeStepV1, { kind: 'user' }>; password: Uint8Array }>): Promise<void>;
}
/** Package authority belongs to the native interpreter, not recipe or UI ids.
 * Unsupported identities/scopes still refuse through the native observer. */
export function readMachineSetupStepExecutionUserV1(step: MachineRecipeStepV1 | MachineRecipeCheckV1): 'administrator' | 'daemon' {
    switch (step.kind) {
        case 'package':
            return step.manager === 'brew' || step.manager === 'winget' ? 'daemon' : 'administrator';
        case 'user':
        case 'group':
        case 'directory':
        case 'workspaceAccess':
        case 'pathTraversal':
        case 'file':
        case 'command':
        case 'packageSource':
        case 'serviceUnit':
        case 'firewall':
        case 'kernel':
        case 'reboot':
            return 'administrator';
        default: {
            const exhaustive: never = step;
            return exhaustive;
        }
    }
}
/** Read-only alternative-manager probes do not make the selected program root work. */
export function machineSetupPlansRequireAdministratorV1(plans: readonly Pick<MachineSetupEffectPlanV1, 'steps'>[]): boolean {
    return plans.some(plan => plan.steps.some(step => readMachineSetupStepExecutionUserV1(step) === 'administrator'));
}
/** Host-private, one-use input. Never serialize this into a recipe, plan or event. */
export type MachineSetupAdministratorEstablishmentV1 = Readonly<{ stepId: string; username: string; password: Uint8Array }>;
export type MachineSetupProgressV1 = Readonly<{ stepId: string; phase: 'check' | 'apply' | 'verify'; status: string; reason?: string }>;
export type MachineSetupNativeEffectIntentV1 = Readonly<{
    basis: Extract<MachineSetupEffectPlanV1['basis'], { kind: 'adminAccess' | 'reboot' }>;
    steps: MachineRecipeStepV1[];
}>;
export type MachineSetupApplyResultV1 = Readonly<{
    status: 'applied' | 'plan_changed' | 'unsupported' | 'unavailable' | 'failed' | 'cancelled' | 'outcome_unknown';
    completedStepIds: readonly string[]; daemonRestartRequired: boolean; stepId?: string; reason?: string;
    restoration?: MachineSetupFirewallRestorationV1;
}>;

export class MachineSetupEffectError extends Error {
    constructor(readonly reasonCode: 'foreign_effect_conflict' | 'validation_failed' | 'native_effect_failed' | 'package_manager_busy' | 'required_fact_unavailable' | 'needs_admin_to_check') {
        super(reasonCode); this.name = 'MachineSetupEffectError';
    }
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        return `{${Object.keys(object).filter(key => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Setup plans contain only admitted JSON');
    return encoded;
}
export function createMachineSetupEffectPlan(input: Omit<MachineSetupEffectPlanV1, 'v' | 'planDigest'>): MachineSetupEffectPlanV1 {
    const value = { v: 1 as const, ...input };
    const operation = { v: value.v, basis: value.basis, steps: value.steps,
        ...(value.checks !== undefined ? { checks: value.checks } : {}),
        ...(value.selectedCheckIds !== undefined ? { selectedCheckIds: value.selectedCheckIds } : {}) };
    // Isolation's retained UID/home and retirement-lock proof still crosses
    // CHECK/APPLY. Keep that native custody fence until its owner moves the
    // exact pins into root-side admitted intent.
    const digested = value.basis.kind === 'agentIsolation' ? value : operation;
    return MachineSetupEffectPlanV1Schema.parse({ ...value, planDigest: createHash('sha256').update(canonicalJson(digested)).digest('hex') });
}
/** Read current and retained reviewed plans without rewriting their admitted contents. */
export function readMachineSetupEffectPlanV1(value: unknown): MachineSetupEffectPlanV1 | null {
    const parsed = MachineSetupEffectPlanV1Schema.safeParse(value);
    if (!parsed.success) return null;
    const plan = parsed.data;
    const { v: _version, planDigest: _digest, ...contents } = plan;
    // Retained Workflow/approval inputs may use the earlier full-plan hash.
    // The current writer still owns operation hashes and isolation's full-plan proof.
    if (createMachineSetupEffectPlan(contents).planDigest !== plan.planDigest
        && createHash('sha256').update(canonicalJson({ v: 1, ...contents })).digest('hex') !== plan.planDigest) return null;
    return plan;
}
/** Only the native package owner can establish an explicit fallback condition. */
export function isMachineSetupPackageUnavailableV1(step: MachineRecipeStepV1 | MachineRecipeCheckV1, fact: MachineSetupStepObservationV1): boolean {
    return step.kind === 'package' && fact.stepId === step.id && fact.status === 'unsupported'
        && fact.reason === 'required_fact_unavailable' && fact.facts.requiredFact === 'packageAvailability'
        && step.packages.some(pkg => pkg.name === fact.facts.package);
}
/** Missing manager executables are distinct from package, pin and authority failures. */
export function isMachineSetupPackageManagerUnavailableV1(step: MachineRecipeStepV1 | MachineRecipeCheckV1, fact: MachineSetupStepObservationV1): boolean {
    return step.kind === 'package' && fact.stepId === step.id && fact.status === 'unsupported'
        && fact.reason === 'required_fact_unavailable' && fact.facts.requiredFact === 'packageManager'
        && fact.facts.manager === step.manager;
}
/** A reviewed source change can establish later package availability. The
 * current pre-effect observation determines which dependent packages wait. */
function packageStepsAwaitingSource(plan: Pick<MachineSetupEffectPlanV1, 'steps' | 'nativeFacts'>): ReadonlySet<string> {
    const sources = new Set<string>(), packages = new Set<string>();
    for (const [index, fact] of plan.nativeFacts.entries()) {
        const step = plan.steps[index];
        if (step?.kind === 'packageSource' && fact.status === 'drifted') sources.add(step.manager);
        if (step?.kind === 'package' && sources.has(step.manager) && isMachineSetupPackageUnavailableV1(step, fact)) packages.add(step.id);
    }
    return packages;
}
/** Selection evidence stays in the digest even when an alternative is unavailable.
 * Only selected branches can block a nonempty program; an empty unresolved
 * selection must still refuse instead of claiming an installed no-op. */
export function findMachineSetupBlockingObservationV1(plan: Pick<MachineSetupEffectPlanV1,
    'steps' | 'nativeFacts' | 'checks' | 'checkFacts' | 'selectedCheckIds'>): MachineSetupStepObservationV1 | undefined {
    const selected = plan.selectedCheckIds === undefined ? undefined : new Set(plan.selectedCheckIds);
    const awaitingSource = packageStepsAwaitingSource(plan);
    return plan.nativeFacts.find(fact => (fact.status === 'unsupported' || fact.status === 'unavailable') && !awaitingSource.has(fact.stepId))
        ?? plan.checkFacts?.find((fact, index) => {
            if (fact.status !== 'unsupported' && fact.status !== 'unavailable') return false;
            const check = plan.checks?.[index];
            if (plan.steps.length && check && (isMachineSetupPackageUnavailableV1(check, fact)
                || isMachineSetupPackageManagerUnavailableV1(check, fact))) return false;
            return fact.status === 'unavailable' || !plan.steps.length || selected === undefined || selected.has(fact.stepId);
        });
}
export async function checkMachineSetupEffectPlan(input: Readonly<{
    basis: MachineSetupEffectPlanV1['basis']; steps: MachineRecipeStepV1[]; checks?: MachineRecipeCheckV1[]; selectedCheckIds?: string[]; backend: MachineSetupBackend;
}>): Promise<MachineSetupEffectPlanV1> {
    const checkFacts: MachineSetupStepObservationV1[] = [];
    for (const check of input.checks ?? []) checkFacts.push(await input.backend.observe(check));
    const nativeFacts: MachineSetupStepObservationV1[] = [];
    for (const step of input.steps) nativeFacts.push(await input.backend.observe(step));
    return createMachineSetupEffectPlan({ basis: input.basis, steps: input.steps, nativeFacts,
        ...(input.checks !== undefined ? { checks: input.checks, checkFacts } : {}),
        ...(input.selectedCheckIds !== undefined ? { selectedCheckIds: input.selectedCheckIds } : {}) });
}
/** The interpreter cannot mutate a satisfied prefix before its first effect.
 * Later steps/programs are re-observed and can be invalidated by earlier work,
 * so their potential effects must already be covered by native admission. */
export function readMachineSetupPotentialEffectStepsV1(input: Readonly<{
    plans: readonly Pick<MachineSetupEffectPlanV1, 'steps' | 'nativeFacts'>[];
    administratorEstablishment?: Pick<MachineSetupAdministratorEstablishmentV1, 'stepId'>;
}>): readonly (readonly MachineRecipeStepV1[])[] {
    return input.plans.map((plan, planIndex) => {
        let beforeFirstEffect = planIndex === 0;
        return plan.steps.filter((step, index) => {
            const fact = plan.nativeFacts[index];
            if (beforeFirstEffect && fact?.stepId === step.id && fact.status === 'satisfied'
                && input.administratorEstablishment?.stepId !== step.id) return false;
            beforeFirstEffect = false;
            return true;
        });
    });
}
export async function applyMachineSetupEffectPlan(input: Readonly<{
    plan: MachineSetupEffectPlanV1; backend: MachineSetupBackend;
    onProgress?: (event: MachineSetupProgressV1) => void; signal?: AbortSignal;
    daemonUsername?: string;
    administratorEstablishment?: MachineSetupAdministratorEstablishmentV1;
}>): Promise<MachineSetupApplyResultV1> {
    return applyMachineSetupEffectPlans({ ...input, plans: [{ plan: input.plan }],
        onProgress: input.onProgress ? ({ planIndex: _planIndex, ...event }) => input.onProgress!(event) : undefined });
}

/** One operation validates every original digest before executing any program. */
export async function applyMachineSetupEffectPlans(input: Readonly<{
    backend: MachineSetupBackend;
    onProgress?: (event: MachineSetupProgressV1 & Readonly<{ planIndex: number }>) => void;
    signal?: AbortSignal;
    daemonUsername?: string;
    administratorEstablishment?: MachineSetupAdministratorEstablishmentV1;
    /** The same invocation retains original undo across the entire reviewed list. */
    onStaged?: (stage: MachineSetupStagedFirewallV1) => Promise<MachineSetupStageDecisionV1>;
}> & (Readonly<{ plans: readonly Readonly<{ plan: MachineSetupEffectPlanV1 }>[] }>
    | Readonly<{ intent: MachineSetupNativeEffectIntentV1 }>)): Promise<MachineSetupApplyResultV1> {
    const completedStepIds: string[] = [];
    let daemonRestartRequired = false;
    let restoration: MachineSetupFirewallRestorationV1 | undefined;
    const result = (status: MachineSetupApplyResultV1['status'], stepId?: string, reason?: string): MachineSetupApplyResultV1 => ({
        status, completedStepIds: [...completedStepIds], daemonRestartRequired,
        ...(stepId ? { stepId } : {}), ...(reason ? { reason } : {}),
        ...(restoration ? { restoration } : {}),
    });
    const establishment = input.administratorEstablishment;
    const entries: readonly (Readonly<{ plan: MachineSetupEffectPlanV1 }> | Readonly<{ intent: MachineSetupNativeEffectIntentV1 }>)[] =
        'plans' in input ? input.plans : [{ intent: input.intent }];
    const stages: MachineSetupNativeStageV1[] = [];
    let stagesCommitted = false;
    const undoStages = async () => {
        const recovery = stages[0]?.recovery;
        let failed = false;
        for (const stage of [...stages].reverse()) { try { await stage.undo(); } catch { failed = true; } }
        stages.length = 0;
        if (!failed && recovery) restoration = { status: 'verified', recovery };
        return !failed;
    };
    try {
        if (input.signal?.aborted) return result('cancelled');
        if ('plans' in input && input.plans.length && !MachineSetupElevatedEffectV1Schema.shape.plans.safeParse(input.plans).success) return result('plan_changed', undefined, 'plan_stale');
        const programs: Array<Readonly<{ plan: MachineSetupEffectPlanV1; nativeFacts: MachineSetupStepObservationV1[];
            administratorStep?: Extract<MachineRecipeStepV1, { kind: 'user' }> }>> = [];
        if (establishment && entries.length !== 1) return result('failed', establishment.stepId, 'validation_failed');
        for (const [planIndex, entry] of entries.entries()) {
            let reviewed: MachineSetupEffectPlanV1 | undefined;
            if ('plan' in entry) {
                const admitted = readMachineSetupEffectPlanV1(entry.plan);
                if (!admitted) return result('plan_changed', undefined, 'plan_stale');
                reviewed = admitted;
            }
            const plan = 'intent' in entry ? entry.intent : reviewed!;
            if (input.onStaged && (plan.steps.length !== 1 || plan.steps[0]?.kind !== 'firewall' || !input.backend.stage
                || establishment)) return result('unsupported', undefined, 'required_fact_unavailable');
            let administratorStep: Extract<MachineRecipeStepV1, { kind: 'user' }> | undefined;
            if (establishment) {
                const target = plan.steps.find(step => step.id === establishment.stepId);
                if (!isMachineSetupBootstrapBasisV1(plan.basis) || !MachineAdministratorUsernameV1Schema.safeParse(establishment.username).success
                    || target?.kind !== 'user' || target.username !== establishment.username || target.locked === true
                    || plan.steps.filter(step => step.kind === 'user' && step.username === establishment.username).length !== 1
                    || !establishment.password.length || establishment.password.some(byte => byte === 0 || byte === 10 || byte === 13)
                    || plan.steps.slice(0, plan.steps.indexOf(target)).some(step => step.kind === 'file' && step.validate === 'sudoers' && step.state !== 'absent')) {
                    return result('failed', establishment.stepId, 'validation_failed');
                }
                if (!input.backend.establishAdministrator) return result('unsupported', target.id, 'required_fact_unavailable');
                administratorStep = target;
            }
            const checkFacts: MachineSetupStepObservationV1[] = [];
            for (const check of ('checks' in plan ? plan.checks : undefined) ?? []) {
                if (input.signal?.aborted) return result('cancelled');
                const fact = await input.backend.observe(check);
                checkFacts.push(fact);
                input.onProgress?.({ planIndex, stepId: check.id, phase: 'check', status: fact.status, ...(fact.reason ? { reason: fact.reason } : {}) });
            }
            const nativeFacts: MachineSetupStepObservationV1[] = [];
            // Re-observe every prerequisite in the executing process before its first
            // mutation. A daemon-only check cannot authorize this process's effects.
            for (const step of plan.steps) {
                if (input.signal?.aborted) return result('cancelled');
                const fact = await input.backend.observe(step);
                nativeFacts.push(fact);
                input.onProgress?.({ planIndex, stepId: step.id, phase: 'check', status: fact.status, ...(fact.reason ? { reason: fact.reason } : {}) });
            }
            const current = createMachineSetupEffectPlan({ basis: plan.basis, steps: plan.steps, nativeFacts,
                ...('checks' in plan && plan.checks !== undefined ? { checks: plan.checks, checkFacts } : {}),
                ...('selectedCheckIds' in plan && plan.selectedCheckIds !== undefined ? { selectedCheckIds: plan.selectedCheckIds } : {}) });
            if (reviewed?.basis.kind === 'agentIsolation' && current.planDigest !== reviewed.planDigest) return result('plan_changed', undefined, 'plan_stale');
            const blocked = findMachineSetupBlockingObservationV1(current);
            if (blocked) return result(blocked.status === 'unsupported' ? 'unsupported' : 'unavailable', blocked.stepId, blocked.reason);
            if (administratorStep) {
                const account = nativeFacts.find(fact => fact.stepId === administratorStep.id)!;
                if (account.facts.present !== false && (!Number.isSafeInteger(account.facts.uid) || Number(account.facts.uid) <= 0)) {
                    return result('failed', administratorStep.id, 'validation_failed');
                }
            }
            programs.push({ plan: reviewed ?? current, nativeFacts, ...(administratorStep ? { administratorStep } : {}) });
        }
        const potentialEffectSteps = readMachineSetupPotentialEffectStepsV1({
            plans: programs.map(({ plan, nativeFacts }) => ({ steps: plan.steps, nativeFacts })),
            ...(establishment ? { administratorEstablishment: establishment } : {}),
        });
        // Only these owner-local validated programs can enter execution. Later
        // programs may now observe prerequisites established by earlier ones;
        // they never re-author or replace their reviewed steps/selection.
        for (const [planIndex, { plan, nativeFacts, administratorStep }] of programs.entries()) {
            if (input.onStaged) {
                const step = plan.steps[0]!;
                if (step.kind !== 'firewall') return result('unsupported', step.id, 'required_fact_unavailable');
                if (input.signal?.aborted) return result(await undoStages() ? 'cancelled' : 'outcome_unknown', step.id, 'cancelled');
                try {
                    input.onProgress?.({ planIndex, stepId: step.id, phase: 'apply', status: 'started' });
                    const stage = await input.backend.stage!(step);
                    stages.push(stage); completedStepIds.push(step.id);
                    if (!await stage.verify()) throw new MachineSetupEffectError('required_fact_unavailable');
                    input.onProgress?.({ planIndex, stepId: step.id, phase: 'verify', status: 'satisfied' });
                    const decision = await input.onStaged({ planIndex, planDigest: plan.planDigest,
                        recovery: stage.recovery, verifyNative: stage.verify });
                    if (input.signal?.aborted || decision === 'undo') {
                        return result(await undoStages() ? 'cancelled' : 'outcome_unknown', step.id,
                            input.signal?.aborted ? 'cancelled' : 'required_fact_unavailable');
                    }
                    const final = planIndex === programs.length - 1;
                    if (decision !== (final ? 'commit' : 'continue')) throw new MachineSetupEffectError('validation_failed');
                    if (!await stage.verify()) throw new MachineSetupEffectError('required_fact_unavailable');
                    if (final) {
                        input.signal?.throwIfAborted();
                        // Releasing in-memory undo is synchronous: cancellation
                        // cannot split release of A from release of FINAL.
                        for (const retained of stages) retained.commit();
                        stagesCommitted = true;
                    }
                } catch (error) {
                    const restored = await undoStages();
                    return result(restored ? input.signal?.aborted ? 'cancelled' : 'failed' : 'outcome_unknown', step.id,
                        error instanceof MachineSetupEffectError ? error.reasonCode : 'required_fact_unavailable');
                }
                continue;
            }
            const daemonUsername = input.daemonUsername ?? (isMachineSetupBootstrapBasisV1(plan.basis) ? 'happier' : undefined);
            const awaitingSource = packageStepsAwaitingSource({ steps: plan.steps, nativeFacts });
            const potentialEffects = new Set(potentialEffectSteps[planIndex]);
            for (let index = 0; index < plan.steps.length; index++) {
                const step = plan.steps[index]!;
                if (input.signal?.aborted) return result('cancelled', step.id);
                if (!potentialEffects.has(step)) continue;
                const establishesAdministrator = step.id === administratorStep?.id;
                let observed: MachineSetupStepObservationV1;
                // Earlier effects can invalidate an initially satisfied step
                // in this same program (for example a user manager's groups).
                try { observed = planIndex === 0 && completedStepIds.length === 0 && !awaitingSource.has(step.id)
                    ? nativeFacts[index]! : await input.backend.observe(step); }
                catch { return result('outcome_unknown', step.id, input.signal?.aborted ? 'cancelled' : 'required_fact_unavailable'); }
                if (observed.status === 'unsupported' || observed.status === 'unavailable') return result(observed.status, step.id, observed.reason);
                if (observed.status === 'satisfied' && !establishesAdministrator) continue;
                // chpasswd establishes the verifier before the full locked:false user
                // declaration is verified. Never unlock an empty-verifier new account.
                const accountStep = establishesAdministrator && step.kind === 'user'
                    ? { ...step, locked: undefined } : step;
                input.onProgress?.({ planIndex, stepId: step.id, phase: 'apply', status: 'started' });
                try {
                    let createdUser = false;
                    if (observed.status !== 'satisfied') {
                        const applied = await input.backend.apply(accountStep);
                        createdUser = applied?.createdUser === true;
                        completedStepIds.push(step.id);
                    }
                    if (establishesAdministrator && createdUser && administratorStep && establishment) {
                        const account = await input.backend.observe(accountStep);
                        if (account.status !== 'satisfied') return result('failed', step.id, 'required_fact_unavailable');
                        await input.backend.establishAdministrator!({ step: administratorStep, password: establishment.password });
                    }
                } catch (error) {
                    if (input.signal?.aborted) return result('outcome_unknown', step.id, 'cancelled');
                    if (step.kind === 'reboot') return result('outcome_unknown', step.id, 'native_effect_failed');
                    if (error instanceof MachineSetupEffectError) return result('failed', step.id, error.reasonCode);
                    // A native exception does not prove that its effect did not occur.
                    // Keep completed effects and raw diagnostics inside this boundary.
                    return result('outcome_unknown', step.id, 'native_effect_failed');
                }
                if (step.kind === 'group' && daemonUsername && step.members.includes(daemonUsername)) daemonRestartRequired = true;
                // Native command acceptance is dispatch only. Restoration is
                // observed by the reboot Action after the Machine reconnects.
                if (step.kind === 'reboot') continue;
                let verified: MachineSetupStepObservationV1;
                try {
                    verified = await input.backend.observe(step);
                } catch {
                    // The effect already completed; lost verification (including an
                    // abort at native close) cannot prove rollback or authorize replay.
                    return result('outcome_unknown', step.id, input.signal?.aborted ? 'cancelled' : 'required_fact_unavailable');
                }
                input.onProgress?.({ planIndex, stepId: step.id, phase: 'verify', status: verified.status, ...(verified.reason ? { reason: verified.reason } : {}) });
                if (verified.status !== 'satisfied') return result('failed', step.id, verified.reason ?? 'required_fact_unavailable');
            }
        }
        return result('applied');
    } finally {
        if (!stagesCommitted && stages.length) await undoStages();
        establishment?.password.fill(0);
    }
}
