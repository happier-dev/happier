import { z } from 'zod';
import { MachineAdministratorUsernameV1Schema, MachineFirewallRecoveryV1Schema, MachineFirewallRestorationV1Schema } from '@happier-dev/protocol/machines/adminAccessV1';
import { MachineSetupEffectPlanV1Schema, MachineSetupElevatedEffectV1Schema, MachineSetupBootstrapBasisV1Schema, isMachineSetupBootstrapBasisV1, MachineFirewallTransitionIntentV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type * as machineSetup from './index.js';
import type { MachineFirewallRecoveryV1 } from '@happier-dev/protocol/machines/adminAccessV1';
import type { MachineElevatedEffectV1, MachineSetupBootstrapBasisV1, MachineFirewallTransitionIntentV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

// Portable domain types keep declarations independent of the concrete Zod
// instances composed below (including Protocol's full/mini schema inputs).
type OnlineIdentity = {
    machineId: string; installationId: string; operationId: string;
    connectorSecretGrant?: true;
    daemonUsername?: string | null;
    daemonExecutionContext?: { home: string; path: string };
};
type Plan = machineSetup.MachineSetupEffectPlanV1;
type EffectPlans = MachineElevatedEffectV1['plans'];
type AdministratorInput = { stepId: string; username: string };
type CheckInput = { v: 1; mode: 'check'; steps: Plan['steps']; checks?: Plan['checks'] };
type ApplyInput = { v: 1; mode: 'apply'; firewallStages?: true };
export type MachineAdministratorEstablishFrame = AdministratorInput & {
    type: 'administrator.establish'; operationId: string; planDigest: string; password: string;
};
export type MachineEffectInternalRequest =
    | (OnlineIdentity & { v: 1; mode: 'check'; continueWithApply: true; firewallStages: true;
        basis: Plan['basis']; firewallIntent: MachineFirewallTransitionIntentV1 })
    | (OnlineIdentity & { v: 1; mode: 'check'; continueWithApply: true; firewallStages: true; plans: EffectPlans })
    | (CheckInput & { basis: MachineSetupBootstrapBasisV1 })
    | (CheckInput & OnlineIdentity & { continueWithApply?: true; basis: Plan['basis'] })
    | (ApplyInput & { plans: EffectPlans; administrator?: AdministratorInput })
    | (ApplyInput & OnlineIdentity & { plans: EffectPlans })
    | (OnlineIdentity & { v: 1; mode: 'apply'; intent: {
        basis: Extract<Plan['basis'], { kind: 'adminAccess' | 'reboot' }>; steps: Plan['steps'];
    } });
type CheckedResult = { status: 'checked'; plan: Plan } | { status: 'checked'; plans: EffectPlans };
export type MachineEffectInternalResult = machineSetup.MachineSetupApplyResultV1 | CheckedResult;
export type MachineEffectInternalRecord =
    | { type: 'ready' }
    | { type: 'firewall.staged'; planIndex: number; planDigest: string; recovery: MachineFirewallRecoveryV1 }
    | { type: 'firewall.verified'; planIndex: number; planDigest: string; ok: boolean }
    | { type: 'progress'; stepId: string; planIndex?: number; phase: 'check' | 'apply' | 'verify'; status: string; reason?: string }
    | { type: 'result'; result: MachineEffectInternalResult };

const OnlineIds = {
    machineId: z.string().min(1),
    installationId: z.string().min(1),
    operationId: z.string().min(1),
    connectorSecretGrant: z.literal(true).optional(),
    /** Originating daemon observation, before elevation; never the root interpreter uid. */
    daemonUsername: z.string().min(1).nullable().optional(),
    /** Native user context only; never applied to the root process environment. */
    daemonExecutionContext: z.object({
        home: z.string().refine(value => !value.includes('\0')),
        path: z.string().refine(value => !value.includes('\0')),
    }).strict().optional(),
};
const Basis = MachineSetupEffectPlanV1Schema.shape.basis;
const Check = { v: z.literal(1), mode: z.literal('check'), steps: MachineSetupEffectPlanV1Schema.shape.steps,
    checks: MachineSetupEffectPlanV1Schema.shape.checks };
const Apply = { v: z.literal(1), mode: z.literal('apply'), firewallStages: z.literal(true).optional() };
const Plans = MachineSetupElevatedEffectV1Schema.shape.plans;
const Administrator = z.object({ stepId: z.string().min(1), username: MachineAdministratorUsernameV1Schema }).strict();
const NativeIntent = z.object({ basis: Basis, steps: Check.steps }).strict().transform((value, context) => {
    if (value.basis.kind !== 'adminAccess' && value.basis.kind !== 'reboot') {
        context.addIssue({ code: 'custom', message: 'Native Apply requires an admitted administrator transition or reboot' });
        return z.NEVER;
    }
    return { basis: value.basis, steps: value.steps };
});

/** Transient stdin only: never part of a plan, argv, environment or result. */
export const MachineAdministratorEstablishFrameSchema: z.ZodType<MachineAdministratorEstablishFrame> = z.object({
    type: z.literal('administrator.establish'),
    operationId: z.string().min(1),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/),
    ...Administrator.shape,
    password: z.string().min(1),
}).strict();

/** Bootstrap names retained admission, never a not-yet-registered target. */
export const MachineEffectInternalRequestSchema: z.ZodType<MachineEffectInternalRequest> = z.union([
    z.object({ v: z.literal(1), mode: z.literal('check'), ...OnlineIds,
        continueWithApply: z.literal(true), firewallStages: z.literal(true),
        basis: Basis.refine(basis => basis.kind === 'setup'), firewallIntent: MachineFirewallTransitionIntentV1Schema }).strict(),
    z.object({ v: z.literal(1), mode: z.literal('check'), ...OnlineIds,
        continueWithApply: z.literal(true), firewallStages: z.literal(true),
        plans: Plans.refine(plans => plans.every(entry => !isMachineSetupBootstrapBasisV1(entry.plan.basis)
            && entry.plan.steps.length === 1 && entry.plan.steps[0]?.kind === 'firewall')) }).strict(),
    z.object({ ...Check, basis: MachineSetupBootstrapBasisV1Schema }).strict(),
    z.object({ ...Check, ...OnlineIds, continueWithApply: z.literal(true).optional(), basis: Basis.refine(basis => !isMachineSetupBootstrapBasisV1(basis)) }).strict(),
    z.object({ ...Apply, plans: Plans.refine(plans => plans.length === 1 && isMachineSetupBootstrapBasisV1(plans[0]!.plan.basis)), administrator: Administrator.optional() }).strict(),
    z.object({ ...Apply, ...OnlineIds, plans: Plans.refine(plans => plans.every(entry => !isMachineSetupBootstrapBasisV1(entry.plan.basis))) }).strict(),
    z.object({ v: z.literal(1), mode: z.literal('apply'), ...OnlineIds, intent: NativeIntent }).strict(),
]);

const FirewallIndex = { planIndex: z.number().int().nonnegative(), planDigest: z.string().regex(/^[a-f0-9]{64}$/) };
export const MachineEffectInternalFirewallControlSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('firewall.verify'), ...FirewallIndex }).strict(),
    z.object({ type: z.literal('firewall.settle'), ...FirewallIndex,
        machineId: OnlineIds.machineId, installationId: OnlineIds.installationId, operationId: OnlineIds.operationId,
        decision: z.enum(['continue', 'commit', 'undo']) }).strict(),
]);

const Result = z.object({
    status: z.enum(['applied', 'plan_changed', 'unsupported', 'unavailable', 'failed', 'cancelled', 'outcome_unknown']),
    completedStepIds: z.array(z.string()),
    daemonRestartRequired: z.boolean(),
    stepId: z.string().optional(),
    reason: z.string().optional(),
    restoration: z.optional(MachineFirewallRestorationV1Schema),
}).strict() satisfies z.ZodType<machineSetup.MachineSetupApplyResultV1>;
const Checked: z.ZodType<CheckedResult> = z.union([
    z.object({ status: z.literal('checked'), plan: MachineSetupEffectPlanV1Schema }).strict(),
    z.object({ status: z.literal('checked'), plans: Plans }).strict(),
]);

export const MachineEffectInternalRecordSchema: z.ZodType<MachineEffectInternalRecord> = z.discriminatedUnion('type', [
    z.object({ type: z.literal('ready') }).strict(),
    z.object({ type: z.literal('firewall.staged'), ...FirewallIndex, recovery: MachineFirewallRecoveryV1Schema }).strict(),
    z.object({ type: z.literal('firewall.verified'), ...FirewallIndex, ok: z.boolean() }).strict(),
    z.object({
        type: z.literal('progress'),
        stepId: z.string(),
        planIndex: z.number().int().nonnegative().optional(),
        phase: z.enum(['check', 'apply', 'verify']),
        status: z.string(),
        reason: z.string().optional(),
    }).strict(),
    z.object({ type: z.literal('result'), result: z.union([Result, Checked]) }).strict(),
]);
