import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ManagedAcquireInputV1Schema, resolveManagedAcquireReviewV1 } from '../../machines/managed/actionsV1.js';
import { ManagedMachineEnrollmentIdentityV1Schema, type ManagedMachineEnrollmentIdentityV1 } from '../../machines/managed/enrollmentIdentityV1.js';
import { ManagedAcquireAgentStartV1Schema } from '../../machines/managed/agentStartV1.js';
import { MachineSetupV1Schema } from '../../machines/managed/machineSetupV1.js';
import { ProviderNativeOptionFactsV1Schema } from '../../machines/managed/providerFactsV1.js';
import type { ProviderNativeOptionFactsV1 } from '../../machines/managed/providerFactsV1.js';
import { describeManagedSize, describeRetention, formatProviderAmount, formatPriceUnit, formatRetentionDuration,
  presentManagedCost, resolveManagedConfigurationCost } from '../../machines/managed/configurationPresentation.js';
import { resolveMachineRetentionNativeIntentV1 } from '../../machines/managed/resolveMachineRetentionPolicyV1.js';
import { resolvePluginLocalizedStringV2Text } from '../../plugins/contributions/publicTypes.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import type { ActionInputOption } from '../actionInputHintsRuntime.js';
import { selectTeamCredentialSourcesForApproval } from './teamCredentialApproval.js';
import { readRecord } from '../../inputs/inputRecords.js';

const reviewSchema = lazyZodSchema(() => z.strictObject({
  homeId: z.string(), provider: z.string(), name: z.optional(z.string()), size: z.string(),
  price: z.string(), lifetime: z.string(),
  // RELOAD 78 retained raw native facts. Read those through the same presenter as new reviews.
  nativeFacts: z.optional(z.pipe(z.union([z.string(), ProviderNativeOptionFactsV1Schema]),
    z.transform(value => typeof value === 'string' ? value : describeNativeChoices(value)))),
  enrollmentIdentity: z.optional(ManagedMachineEnrollmentIdentityV1Schema),
  setup: z.optional(MachineSetupV1Schema), agentStart: z.optional(ManagedAcquireAgentStartV1Schema),
}));

function describeNativeChoices(facts: ProviderNativeOptionFactsV1): string {
  // Keep the recorded size title and dimensions together, as on the configuration receipt.
  return [facts.size ? describeManagedSize(resolvePluginLocalizedStringV2Text(facts.size.title), facts.size) : null,
    ...[facts.image, facts.location, facts.network, facts.duration].flatMap(fact => fact ? [resolvePluginLocalizedStringV2Text(fact.title)] : []),
    facts.monthlyCapStatus === undefined ? null : facts.monthlyCapStatus === 'none' ? 'No monthly cap' : 'Monthly cap unavailable']
    .filter((part): part is string => part !== null).join(' · ');
}

/** Only declared receipt facts enter review; provider input and credential bindings stay private. */
function projectReview(value: unknown) {
  const input = ManagedAcquireInputV1Schema.parse(value);
  const effect = resolveManagedAcquireReviewV1(input);
  const oneOffInput = 'enrollmentIdentity' in input ? input : undefined;
  const facts = oneOffInput?.reviewedFacts;
  const launch = facts?.launch ?? oneOffInput?.selection.launch;
  const provider = facts?.provisioner
    ? resolvePluginLocalizedStringV2Text(facts.provisioner.title) : launch?.provider.pluginId ?? 'the selected provider';
  const size = facts?.nativeFacts?.size;
  const retention = effect.retention;
  const parking = facts && resolveMachineRetentionNativeIntentV1('stop', facts.retentionCapabilities.supportedIntents) === 'suspend'
    ? 'suspend' : 'stop';
  const keep = describeRetention(retention, { parking })
    + (retention.kind === 'deadline' ? '; running work may be interrupted' : '');
  const expiry = facts?.retentionCapabilities.nativeExpiry;
  const nativeLifetime = expiry?.kind === 'unused' ? `Native expiry after ${formatRetentionDuration(expiry.afterMs)} without provider activity`
    : expiry?.kind === 'deadline' ? `Native expiry at ${new Date(expiry.at).toLocaleString()}; running work may be interrupted`
      : facts?.retentionCapabilities.finiteOnly ? 'Finite provider lifetime; exact expiry unavailable' : undefined;
  const lifetime = nativeLifetime ? `${keep} · ${nativeLifetime}` : keep;
  const cost = resolveManagedConfigurationCost({ prices: facts?.prices, billing: facts?.billing, provider });
  return {
    homeId: effect.homeId, provider, ...(launch ? { name: launch.name } : {}),
    size: size ? resolvePluginLocalizedStringV2Text(size.title) : 'Size unavailable',
    price: cost.kind === 'price' ? cost.prices.map(price => [
      price.label === undefined ? null : resolvePluginLocalizedStringV2Text(price.label),
      `${formatProviderAmount(price)} ${formatPriceUnit(price.unit)}`, price.source,
    ].filter(Boolean).join(' · ')).join('; ') : presentManagedCost(cost).value,
    lifetime, ...(facts?.nativeFacts ? { nativeFacts: describeNativeChoices(facts.nativeFacts) } : {}),
    ...(oneOffInput ? { enrollmentIdentity: oneOffInput.enrollmentIdentity } : {}),
    ...(facts?.setup ? { setup: facts.setup } : {}), ...(input.agentStart ? { agentStart: input.agentStart } : {}),
  };
}

export const managedAcquireApprovalPresentation = {
  teamCredentialSources: (input: unknown) => {
    const request = readRecord(input);
    const serverId = readRecord(request.selection).homeId;
    return { ...selectTeamCredentialSourcesForApproval(request.agentStart),
      ...(typeof serverId === 'string' ? { serverId } : {}) };
  },
  projectInput: projectReview,
  inputSchema: reviewSchema,
  inputHints: { fields: [
    { path: 'homeId', title: 'Home', widget: 'text', required: true },
    { path: 'provider', title: 'Provider', widget: 'text', required: true },
    { path: 'name', title: 'Machine name', widget: 'text' },
    { path: 'size', title: 'Selected size', widget: 'text', required: true },
    { path: 'price', title: 'Provider price', widget: 'text', required: true },
    { path: 'lifetime', title: 'Keep and lifetime', widget: 'text', required: true },
    { path: 'nativeFacts', title: 'Selected native choices', widget: 'text' },
    { path: 'enrollmentIdentity.role', title: 'Enrollment identity', widget: 'select', options: Object.values({
      server: { value: 'server', label: 'Runs as a dedicated user on the machine.\nAgents share a Linux user until separate users are enabled in Security.',
        labelKey: 'managedMachines.identity.approvalServer' },
      deployTarget: { value: 'deployTarget', label: 'Runs as a dedicated user on the machine.\nAgents share a Linux user until separate users are enabled in Security.',
        labelKey: 'managedMachines.identity.approvalDeployTarget' },
      personal: { value: 'personal', label: 'Runs as your existing account on your personal machine. No separate Happier user is set up.',
        labelKey: 'managedMachines.identity.approvalPersonal' },
      adopted: { value: 'adopted', label: 'Runs as the existing account on the adopted machine. No separate Happier user is set up.',
        labelKey: 'managedMachines.identity.approvalAdopted' },
      sandbox: { value: 'sandbox', label: 'Runs as a process inside the sandbox. No separate user is set up.',
        labelKey: 'managedMachines.identity.approvalSandbox' },
    } satisfies Record<ManagedMachineEnrollmentIdentityV1['role'], ActionInputOption>) },
    { path: 'enrollmentIdentity.username', title: 'Happier user', widget: 'text' },
    { path: 'enrollmentIdentity.serviceMode', title: 'Service', widget: 'select', options: [
      { value: 'user', label: 'User service', labelKey: 'managedMachines.identity.approvalUserService' },
    ] },
    { path: 'enrollmentIdentity.adminAccessAtCreation', title: 'Administrator access', widget: 'select', options: [
      { value: 'preauthorized', label: 'Preauthorized', labelKey: 'managedMachines.identity.preauthorized' },
      { value: 'ask', label: 'Ask each time', labelKey: 'managedMachines.identity.ask' },
      { value: 'none', label: 'None', labelKey: 'managedMachines.identity.none' },
    ] },
    { path: 'enrollmentIdentity.administrator.username', title: 'Administrator account', widget: 'text' },
    { path: 'setup', title: 'Machine setup', widget: 'json' },
    { path: 'agentStart', title: 'Agent startup', widget: 'json' },
  ] },
  technicalInputPaths: ['homeId'],
  summary: (input: unknown) => {
    const review = projectReview(input);
    return `${review.provider} · ${review.size} · ${review.price} · ${review.lifetime}`;
  },
} satisfies NonNullable<PreNormalizedActionSpec['approvalPresentation']>;
