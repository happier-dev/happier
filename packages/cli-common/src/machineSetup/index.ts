import { readMachineSetupInitialPresenceV1 } from './initialPresence.js';
export { readMachineSetupInitialPresenceV1 } from './initialPresence.js';
import { MachineSetupEffectError } from './effectError.js';
export { MachineSetupEffectError } from './effectError.js';
import { MachineAdministratorUsernameV1Schema, MachineElevationFailureV1Schema } from '@happier-dev/protocol/machines/adminAccessV1';
import { MachineSetupSshHostKeyEvidenceV1Schema, type MachineSetupNativeSshHostKeyV1 } from '@happier-dev/protocol/machines/setup/backupReceiverV1';
import type { MachineElevationFailureV1, MachineFirewallRecoveryV1 as MachineSetupFirewallRecoveryV1,
    MachineFirewallRestorationV1 as MachineSetupFirewallRestorationV1 } from '@happier-dev/protocol/machines/adminAccessV1';
export type { MachineFirewallRecoveryV1 as MachineSetupFirewallRecoveryV1,
    MachineFirewallRestorationV1 as MachineSetupFirewallRestorationV1 } from '@happier-dev/protocol/machines/adminAccessV1';
import { MachineSetupElevatedEffectV1Schema, isMachineSetupBootstrapBasisV1, type MachineRecipeStepV1, type MachineRecipeCheckV1, type MachineSetupEffectPlanV1, type MachineSetupStepObservationV1, type MachineRecipeTargetFactKeyV1, type MachineRecipeTargetFactsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { createMachineSetupEffectPlan, readMachineSetupEffectPlanV1, compareMachineSetupEffectPlansV1,
    type MachineSetupPlanComparisonV1 } from './planReview.js';
export { createMachineSetupEffectPlan, readMachineSetupEffectPlanV1, compareMachineSetupEffectPlansV1,
    type MachineSetupPlanComparisonV1 } from './planReview.js';

export type { MachineRecipeStepV1, MachineSetupEffectPlanV1, MachineSetupStepObservationV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
export { MachineSetupEffectPlanV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

export { createMachineSetupNativeBackend, runMachineSetupNativeCommand, type MachineSetupNativeCommand, type MachineSetupNativeCommandResult, type MachineSetupSecretGrantMaterial } from './nativeBackend.js';
export { createDockerEngineSetupSteps } from './dockerEngine.js';
export { parseNativeDockerEngineInfo, type NativeDockerEngineFacts } from './nativeDockerEngine.js';
export { observeNativeUpdates, createNativeUpdatesSteps, createNativeUpdateHoldStep,
    type NativeUpdatesObservation, type NativeUpdatesCandidates } from './nativeUpdates.js';
export * from './effectInternalProtocol.js';
export { MANAGED_SUDOERS_PATH, resolveManagedSudoersPath, buildManagedSudoersSteps, recognizeManagedSudoersDropIn } from './managedSudoers.js';
export { assertAgentIsolationLaunchPrincipal, buildAgentIsolationBootstrapSteps, buildAgentIsolationToolsRootStep } from './agentIsolationBootstrap.js';
export { buildUserManagerGroupRefreshStep } from './userManagerGroups.js';
export { machineStateRootStep } from './stateRoot.js';

/** Both declarations can change the daemon account's supplementary groups. */
export function machineSetupStepChangesDaemonGroupsV1(step: MachineRecipeStepV1, daemonUsername: string): boolean {
    return step.kind === 'group' ? step.members.includes(daemonUsername)
        : step.kind === 'user' && step.username === daemonUsername && step.supplementaryGroups !== undefined;
}
export { createMachineFirewallTransitionObservationStepV1, readMachineFirewallTransitionFactsV1,
    materializeMachineFirewallTransitionV1, type MachineFirewallTransitionFactsV1,
    type MachineFirewallTransitionMaterializationV1 } from './nativeFirewallTransition.js';
export { nativeCaddyProfile, createNativeCaddySetupInput, createCaddyContainerSetupSteps, ensureNativeCaddyContainer, readCaddyContainerFirewallExposures, nativeCaddyImage,
    checkNativeCaddyPortAvailability,
    createNativeCaddyBindings, observeNativeCaddyContainer, observeNativeCaddyFirewallBindings, connectNativeCaddyNetworks, disconnectNativeCaddyNetworks,
    observeNativeCaddyRetainedNetwork, type NativeCaddyObservationResult,
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

function isUnconfirmedNativeProcessStop(error: unknown): boolean {
    return error !== null && typeof error === 'object' && 'code' in error
        && error.code === 'plugin_exec_termination_incomplete';
}

export interface MachineSetupBackend {
    observe(step: MachineRecipeStepV1 | MachineRecipeCheckV1): Promise<MachineSetupStepObservationV1>;
    /** Only the native useradd owner can report that this invocation created an account. */
    apply(step: MachineRecipeStepV1, observed?: MachineSetupStepObservationV1): Promise<void | Readonly<{ createdUser: true }>>;
    /** Retire private files owned by this finite invocation, including on cancellation. */
    finishInvocation?(): Promise<void>;
    /** Native OS metadata only; daemon identity stays with the captured P10 owner. */
    readTargetFacts?(facts: readonly MachineRecipeTargetFactKeyV1[]): Promise<MachineRecipeTargetFactsV1>;
    onChange?(service: Extract<MachineRecipeStepV1, { kind: 'serviceUnit' }>, action: 'reload' | 'restart'): Promise<void>;
    stage?(step: Extract<MachineRecipeStepV1, { kind: 'firewall' }>): Promise<MachineSetupNativeStageV1>;
    establishAdministrator?(input: Readonly<{ step: Extract<MachineRecipeStepV1, { kind: 'user' }>; password: Uint8Array }>): Promise<void>;
}
/** Package authority belongs to the native interpreter, not recipe or UI ids.
 * Unsupported identities/scopes still refuse through the native observer. */
export function readMachineSetupStepExecutionUserV1(step: MachineRecipeStepV1 | MachineRecipeCheckV1): 'administrator' | 'daemon' {
    switch (step.kind) {
        case 'package':
            return step.manager === 'brew' || step.manager === 'winget' ? 'daemon' : 'administrator';
        case 'packageHold':
        case 'user':
        case 'group':
        case 'directory':
        case 'workspaceAccess':
        case 'pathTraversal':
        case 'file':
        case 'command':
        case 'script':
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
/** A started check observes current native state; only a started apply attempts an effect. */
export type MachineSetupProgressV1 = Readonly<{ stepId: string; phase: 'check' | 'apply' | 'verify'; status: string; reason?: string }>;
export type MachineSetupNativeEffectIntentV1 = Readonly<{
    basis: Extract<MachineSetupEffectPlanV1['basis'], { kind: 'adminAccess' | 'reboot' }>;
    steps: MachineRecipeStepV1[];
}>;
export type MachineSetupApplyResultV1 = Readonly<{
    status: 'applied' | 'plan_changed' | 'unsupported' | 'unavailable' | 'failed' | 'cancelled' | 'outcome_unknown';
    completedStepIds: readonly string[]; daemonRestartRequired: boolean; stepId?: string; reason?: string; requiredFact?: string;
    failure?: MachineElevationFailureV1;
    restoration?: MachineSetupFirewallRestorationV1;
    /** Executing-process presence, in admitted plan order, before any mutation. */
    initialPresence?: readonly ('present' | 'absent' | 'unknown')[];
    comparison?: MachineSetupPlanComparisonV1;
    /** Public-only evidence from the same effective native receiver check. */
    sshHostKeys?: readonly MachineSetupNativeSshHostKeyV1[];
}>;

/** CHECK and its isolation preview expose the same native prerequisite and repair. */
export function readMachineSetupObservationFailureV1(observation: MachineSetupStepObservationV1): MachineElevationFailureV1 | undefined {
    const failure = MachineElevationFailureV1Schema.safeParse({
        kind: observation.status === 'unsupported' ? 'native_check_unsupported' : 'native_check_unavailable',
        ...(observation.reason ? { reason: observation.reason } : {}),
        requiredFact: typeof observation.facts.requiredFact === 'string' ? observation.facts.requiredFact : observation.stepId,
        ...(typeof observation.facts.remedy === 'string' ? { remedy: observation.facts.remedy } : {}),
    });
    return failure.success ? failure.data : undefined;
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
/** Ordered source/package effects can establish later package/tool availability.
 * Missing tools stay unavailable until re-observed after the earlier install. */
function stepsAwaitingEarlierEffects(plan: Pick<MachineSetupEffectPlanV1, 'steps' | 'nativeFacts'>): ReadonlySet<string> {
    const sources = new Set<string>(), awaiting = new Set<string>();
    const groups = new Set<string>();
    let installingPackage = false;
    for (const [index, fact] of plan.nativeFacts.entries()) {
        const step = plan.steps[index];
        // An existing, explicitly mutable directory can be reviewed before its
        // declared group exists. APPLY resolves that identity again after groupadd.
        if (step?.kind === 'directory' && !step.preserveExistingOwnership && !step.ownershipMarker
            && fact.status === 'unavailable' && fact.reason === 'required_fact_unavailable'
            && step.owner !== step.group && Array.isArray(fact.facts.missingIdentity)
            && fact.facts.missingIdentity.length === 1 && fact.facts.missingIdentity[0] === step.group
            && groups.has(step.group)) awaiting.add(step.id);
        if (step?.kind === 'group' && step.state !== 'absent' && !step.existingOnly
            && fact.status === 'drifted' && fact.facts.present === false) groups.add(step.name);
        if (step?.kind === 'packageSource' && fact.status === 'drifted') sources.add(step.manager);
        if (step?.kind === 'package' && sources.has(step.manager) && isMachineSetupPackageUnavailableV1(step, fact)) awaiting.add(step.id);
        if (installingPackage && (fact.status === 'unsupported' || fact.status === 'unavailable')
            && fact.reason === 'required_fact_unavailable' && fact.facts.requiredFact === 'commandExecutable'
            && typeof fact.facts.executable === 'string') awaiting.add(fact.stepId);
        if (step?.kind === 'package' && step.state !== 'absent' && (fact.status === 'drifted' || awaiting.has(step.id))) installingPackage = true;
    }
    return awaiting;
}
/** Selection evidence stays in the digest even when an alternative is unavailable.
 * Only selected branches can block a nonempty program; an empty unresolved
 * selection must still refuse instead of claiming an installed no-op. */
export function findMachineSetupBlockingObservationV1(plan: Pick<MachineSetupEffectPlanV1,
    'steps' | 'nativeFacts' | 'checks' | 'checkFacts' | 'selectedCheckIds'>): MachineSetupStepObservationV1 | undefined {
    const selected = plan.selectedCheckIds === undefined ? undefined : new Set(plan.selectedCheckIds);
    const awaiting = stepsAwaitingEarlierEffects(plan);
    return plan.nativeFacts.find(fact => (fact.status === 'unsupported' || fact.status === 'unavailable') && !awaiting.has(fact.stepId))
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
    let comparison: MachineSetupPlanComparisonV1 | undefined;
    const initialPresence: NonNullable<MachineSetupApplyResultV1['initialPresence']>[number][] = [];
    const sshHostKeys = new Map<string, MachineSetupNativeSshHostKeyV1>();
    const captureHostKey = (planIndex: number, fact: MachineSetupStepObservationV1) => {
        if (fact.facts.sshHostKeyEvidence === undefined) return;
        const evidence = MachineSetupSshHostKeyEvidenceV1Schema.safeParse(fact.facts.sshHostKeyEvidence);
        if (fact.status === 'satisfied' && evidence.success) sshHostKeys.set(`${planIndex}:${fact.stepId}`,
            { planIndex, stepId: fact.stepId, evidence: evidence.data });
    };
    const result = (status: MachineSetupApplyResultV1['status'], stepId?: string, reason?: string, requiredFact?: string, failure?: MachineElevationFailureV1): MachineSetupApplyResultV1 => ({
        status, completedStepIds: [...completedStepIds], daemonRestartRequired,
        ...(stepId ? { stepId } : {}), ...(reason ? { reason } : {}),
        ...(requiredFact ? { requiredFact } : {}), ...(failure ? { failure } : {}),
        ...(restoration ? { restoration } : {}),
        ...(comparison ? { comparison } : {}),
        ...(status === 'applied' && sshHostKeys.size ? { sshHostKeys: [...sshHostKeys.values()] } : {}),
        ...(status === 'applied' && entries.some(entry => 'plan' in entry && entry.plan.basis.kind === 'setup')
            ? { initialPresence: [...initialPresence] } : {}),
    });
    const establishment = input.administratorEstablishment;
    const entries: readonly (Readonly<{ plan: MachineSetupEffectPlanV1 }> | Readonly<{ intent: MachineSetupNativeEffectIntentV1 }>)[] =
        'plans' in input ? input.plans : [{ intent: input.intent }];
    const stages: MachineSetupNativeStageV1[] = [];
    let nativeStopUnconfirmed = false;
    let stagesCommitted = false;
    const undoStages = async () => {
        const recovery = stages[0]?.recovery;
        let failed = false;
        let unconfirmedStop: unknown;
        for (const stage of [...stages].reverse()) {
            try { await stage.undo(); }
            catch (error) { failed = true; if (isUnconfirmedNativeProcessStop(error)) unconfirmedStop = error; }
        }
        stages.length = 0;
        if (unconfirmedStop) throw unconfirmedStop;
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
            if (reviewed?.basis.kind === 'agentIsolation') {
                const native = compareMachineSetupEffectPlansV1(reviewed, current);
                comparison = { targetChanged: native.targetChanged,
                    fields: [...(comparison?.fields ?? []), ...native.fields.map(field => entries.length === 1 ? field
                        : { ...field, field: `plans[${planIndex}].${field.field}` })] };
                if (comparison.targetChanged) return result('plan_changed', undefined, 'plan_stale');
            }
            const blocked = findMachineSetupBlockingObservationV1(current);
            if (blocked) {
                const requiredFact = typeof blocked.facts.requiredFact === 'string' ? blocked.facts.requiredFact : blocked.stepId;
                return result(blocked.status === 'unsupported' ? 'unsupported' : 'unavailable', blocked.stepId, blocked.reason,
                    requiredFact, readMachineSetupObservationFailureV1(blocked));
            }
            if (administratorStep) {
                const account = nativeFacts.find(fact => fact.stepId === administratorStep.id)!;
                if (account.facts.present !== false && (!Number.isSafeInteger(account.facts.uid) || Number(account.facts.uid) <= 0)) {
                    return result('failed', administratorStep.id, 'validation_failed');
                }
            }
            initialPresence.push(readMachineSetupInitialPresenceV1(current) ?? 'unknown');
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
            for (const fact of nativeFacts) captureHostKey(planIndex, fact);
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
                    if (isUnconfirmedNativeProcessStop(error)) throw error;
                    return result(restored ? input.signal?.aborted ? 'cancelled' : 'failed' : 'outcome_unknown', step.id,
                        error instanceof MachineSetupEffectError ? error.reasonCode : 'required_fact_unavailable');
                }
                continue;
            }
            const daemonUsername = input.daemonUsername ?? (isMachineSetupBootstrapBasisV1(plan.basis) ? 'happier' : undefined);
            const awaiting = stepsAwaitingEarlierEffects({ steps: plan.steps, nativeFacts });
            const potentialEffects = new Set(potentialEffectSteps[planIndex]);
            for (let index = 0; index < plan.steps.length; index++) {
                const step = plan.steps[index]!;
                if (input.signal?.aborted) return result('cancelled', step.id);
                if (!potentialEffects.has(step)) continue;
                const establishesAdministrator = step.id === administratorStep?.id;
                let observed: MachineSetupStepObservationV1;
                // Earlier effects can invalidate an initially satisfied step
                // in this same program (for example a user manager's groups).
                try {
                    if (planIndex === 0 && completedStepIds.length === 0 && !awaiting.has(step.id)) observed = nativeFacts[index]!;
                    else {
                        // Re-observation can fail before Apply starts. Publish the
                        // executing plan/step rather than retaining preflight success.
                        input.onProgress?.({ planIndex, stepId: step.id, phase: 'check', status: 'started' });
                        observed = await input.backend.observe(step);
                        input.onProgress?.({ planIndex, stepId: step.id, phase: 'check', status: observed.status,
                            ...(observed.reason ? { reason: observed.reason } : {}) });
                    }
                }
                catch (error) {
                    if (isUnconfirmedNativeProcessStop(error)) throw error;
                    return result('outcome_unknown', step.id, input.signal?.aborted ? 'cancelled' : 'required_fact_unavailable');
                }
                if (observed.status === 'unsupported' || observed.status === 'unavailable') {
                    const failure = readMachineSetupObservationFailureV1(observed);
                    return result(observed.status, step.id, observed.reason, failure?.requiredFact, failure);
                }
                captureHostKey(planIndex, observed);
                if (observed.status === 'satisfied' && !establishesAdministrator) continue;
                // chpasswd establishes the verifier before the full locked:false user
                // declaration is verified. Never unlock an empty-verifier new account.
                const accountStep = establishesAdministrator && step.kind === 'user'
                    ? { ...step, locked: undefined } : step;
                input.onProgress?.({ planIndex, stepId: step.id, phase: 'apply', status: 'started' });
                try {
                    let createdUser = false;
                    if (observed.status !== 'satisfied') {
                        const handler = step.kind === 'file' ? step.onChange : undefined;
                        const service = handler ? plan.steps.find(candidate => candidate.kind === 'serviceUnit' && candidate.id === handler.serviceStepId) : undefined;
                        if (handler && (service?.kind !== 'serviceUnit' || !input.backend.onChange)) {
                            throw new MachineSetupEffectError('required_fact_unavailable');
                        }
                        const applied = step.kind === 'packageHold' ? await input.backend.apply(step, observed)
                            : await input.backend.apply(accountStep);
                        createdUser = applied?.createdUser === true;
                        completedStepIds.push(step.id);
                        if (handler && service?.kind === 'serviceUnit') await input.backend.onChange!(service, handler.action);
                    }
                    if (establishesAdministrator && createdUser && administratorStep && establishment) {
                        const account = await input.backend.observe(accountStep);
                        if (account.status !== 'satisfied') return result('failed', step.id, 'required_fact_unavailable');
                        await input.backend.establishAdministrator!({ step: administratorStep, password: establishment.password });
                    }
                } catch (error) {
                    if (isUnconfirmedNativeProcessStop(error)) throw error;
                    if (input.signal?.aborted) return result('outcome_unknown', step.id, 'cancelled');
                    if (step.kind === 'reboot') return result('outcome_unknown', step.id, 'native_effect_failed');
                    if (error instanceof MachineSetupEffectError) return result('failed', step.id, error.reasonCode, error.failure?.requiredFact, error.failure);
                    // A native exception does not prove that its effect did not occur.
                    // Keep completed effects and raw diagnostics inside this boundary.
                    return result('outcome_unknown', step.id, 'native_effect_failed');
                }
                if (daemonUsername && machineSetupStepChangesDaemonGroupsV1(step, daemonUsername)
                    && (step.kind !== 'user' || !Array.isArray(observed.facts.desiredSupplementaryGroupIds)
                        || JSON.stringify(observed.facts.supplementaryGroupIds) !== JSON.stringify(observed.facts.desiredSupplementaryGroupIds))) {
                    daemonRestartRequired = true;
                }
                // Native command acceptance is dispatch only. Restoration is
                // observed by the reboot Action after the Machine reconnects.
                if (step.kind === 'reboot') continue;
                if (step.kind === 'script' && !step.check) {
                    input.onProgress?.({ planIndex, stepId: step.id, phase: 'apply', status: 'satisfied' });
                    continue;
                }
                let verified: MachineSetupStepObservationV1;
                try {
                    verified = await input.backend.observe(step);
                } catch (error) {
                    if (isUnconfirmedNativeProcessStop(error)) throw error;
                    // The effect already completed; lost verification (including an
                    // abort at native close) cannot prove rollback or authorize replay.
                    return result('outcome_unknown', step.id, input.signal?.aborted ? 'cancelled' : 'required_fact_unavailable');
                }
                input.onProgress?.({ planIndex, stepId: step.id, phase: 'verify', status: verified.status, ...(verified.reason ? { reason: verified.reason } : {}) });
                if (verified.status !== 'satisfied') return result('failed', step.id, verified.reason ?? 'required_fact_unavailable');
                captureHostKey(planIndex, verified);
            }
        }
        return result('applied');
    } catch (error) {
        nativeStopUnconfirmed = isUnconfirmedNativeProcessStop(error);
        throw error;
    } finally {
        try {
            if (!stagesCommitted && stages.length) await undoStages();
        } catch (error) {
            if (isUnconfirmedNativeProcessStop(error)) nativeStopUnconfirmed = true;
            throw error;
        } finally {
            establishment?.password.fill(0);
            // Unlinking invocation files preserves already-open descriptors; the
            // process owner still retains custody of an unconfirmed child.
            try { await input.backend.finishInvocation?.(); }
            catch {
                if (!nativeStopUnconfirmed) return result('outcome_unknown', undefined, 'native_effect_failed');
            }
        }
    }
}
