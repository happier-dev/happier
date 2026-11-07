import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import {
  MANAGED_IDENTITY_PROVIDER_ACTION_IDS_V1,
  MANAGED_IDENTITY_PROVIDER_ACTION_INPUT_SCHEMAS_V1,
  MANAGED_IDENTITY_PROVIDER_ACTION_OUTPUT_SCHEMAS_V1,
  MANAGED_IDENTITY_PROVIDER_ACTION_PATHS_V1,
  type ManagedIdentityProviderActionIdV1,
} from '../../identity/providers.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { redactObservationInputPaths } from './observationRedaction.js';

const METADATA = {
  'identity.providers.list': {
    title: 'List identity providers', description: 'List redacted managed identity providers on this Home.',
    safety: 'safe', sideEffectClass: 'read', presentUser: false, cliPath: ['identity', 'providers', 'list'],
  },
  'identity.providers.create': {
    title: 'Create identity provider', description: 'Create a disabled managed OIDC provider without returning its secret.',
    safety: 'danger', sideEffectClass: 'danger', presentUser: true, cliPath: ['identity', 'providers', 'create'],
  },
  'identity.providers.update': {
    title: 'Update identity provider', description: 'Update non-secret managed OIDC configuration at the expected revision.',
    safety: 'danger', sideEffectClass: 'danger', presentUser: true, cliPath: ['identity', 'providers', 'update'],
  },
  'identity.providers.secret.replace': {
    title: 'Replace identity provider secret', description: 'Replace the managed OIDC client secret without returning it.',
    safety: 'danger', sideEffectClass: 'danger', presentUser: true, cliPath: ['identity', 'providers', 'secret', 'replace'],
  },
  'identity.providers.validate': {
    title: 'Validate identity provider', description: 'Validate managed OIDC discovery through the current Home network policy.',
    safety: 'danger', sideEffectClass: 'danger', presentUser: true, cliPath: ['identity', 'providers', 'validate'],
  },
  'identity.providers.test.start': {
    title: 'Test identity provider', description: 'Open a real non-mutating sign-in test for this managed identity provider.',
    safety: 'danger', sideEffectClass: 'danger', presentUser: false, cliPath: ['identity', 'providers', 'test', 'start'],
  },
  'identity.providers.test.consume': {
    title: 'Finish identity provider test', description: 'Consume the initiating administrator’s one-time sign-in test result.',
    safety: 'danger', sideEffectClass: 'danger', presentUser: false, cliPath: ['identity', 'providers', 'test', 'consume'],
  },
  'identity.providers.enable': {
    title: 'Enable identity provider', description: 'Enable a managed identity provider at its current security revision.',
    safety: 'danger', sideEffectClass: 'danger', presentUser: true, cliPath: ['identity', 'providers', 'enable'],
  },
  'identity.providers.disable': {
    title: 'Disable identity provider', description: 'Stop new sign-ins while preserving configuration and linked identities.',
    safety: 'danger', sideEffectClass: 'danger', presentUser: true, cliPath: ['identity', 'providers', 'disable'],
  },
  'identity.providers.remove.preview': {
    title: 'Preview identity provider removal', description: 'Read current bounded blockers and impact before removing an identity provider.',
    safety: 'safe', sideEffectClass: 'read', presentUser: false, cliPath: ['identity', 'providers', 'remove', 'preview'],
  },
  'identity.providers.remove': {
    title: 'Remove identity provider', description: 'Remove an unused managed identity provider at its expected revision.',
    safety: 'danger', sideEffectClass: 'danger', presentUser: true, cliPath: ['identity', 'providers', 'remove'],
  },
} as const satisfies Readonly<Record<ManagedIdentityProviderActionIdV1, Readonly<{
  title: string;
  description: string;
  safety: 'safe' | 'danger';
  sideEffectClass: 'read' | 'write' | 'danger';
  presentUser: boolean;
  cliPath: readonly string[];
}>>>;

export type ManagedIdentityProviderRequiredAuthority<
  TActionId extends ManagedIdentityProviderActionIdV1,
> = (typeof METADATA)[TActionId]['presentUser'] extends true
  ? 'present_user'
  : 'account_automation';

export const MANAGED_IDENTITY_PROVIDER_ACTION_SPECS: readonly PreNormalizedActionSpec[] = lazyActionSpecArray(() => Object.freeze(
  MANAGED_IDENTITY_PROVIDER_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => {
    const metadata = METADATA[id];
    const reviewSchema = id === 'identity.providers.create'
      ? lazyZodSchema(() => z.omit(MANAGED_IDENTITY_PROVIDER_ACTION_INPUT_SCHEMAS_V1['identity.providers.create'], { clientSecret: true }))
      : id === 'identity.providers.secret.replace'
        ? lazyZodSchema(() => z.omit(MANAGED_IDENTITY_PROVIDER_ACTION_INPUT_SCHEMAS_V1['identity.providers.secret.replace'], { clientSecret: true }))
        : undefined;
    return {
      id, approval: { result: 'required' },
      ...(id === 'identity.providers.secret.replace' || id === 'identity.providers.remove'
        ? { irreversible: true as const } : {}),
      // Removal and secret replacement destroy retained configuration. Other
      // configuration/test effects are reversible.
      ...(['identity.providers.create', 'identity.providers.update', 'identity.providers.validate',
        'identity.providers.test.start', 'identity.providers.test.consume',
        'identity.providers.enable', 'identity.providers.disable'].includes(id)
        ? { approvalPolicy: { uiConfirmation: 'direct' as const } } : {}),
      title: metadata.title,
      description: metadata.description,
      safety: metadata.safety,
      requiredAuthority: metadata.presentUser ? 'present_user' : 'account_automation',
      executionPlacement: 'account',
      placements: [],
      surfaces: {
        ui: true,
        voice: false,
        agent: !metadata.presentUser,
        mcp: false,
        cli: true,
        rpc: false,
      },
      sideEffectClass: metadata.sideEffectClass,
      inputSchema: MANAGED_IDENTITY_PROVIDER_ACTION_INPUT_SCHEMAS_V1[id],
      outputSchema: MANAGED_IDENTITY_PROVIDER_ACTION_OUTPUT_SCHEMAS_V1[id],
      // The executable input retains the write-only secret. Review declares
      // only its safe operands, rather than requiring the redacted material.
      ...(reviewSchema ? { approvalPresentation: { summary: () => null, inputSchema: reviewSchema, inputHints: { fields: [] },
        projectInput: (input: unknown) => reviewSchema.parse(redactObservationInputPaths('clientSecret')(input)),
      } } : {}),
      ...(id === 'identity.providers.test.start'
        ? { projectObservationOutput: () => ({ redacted: true }) }
        : {}),
      ...(id === 'identity.providers.test.consume'
        ? { projectObservationInput: redactObservationInputPaths('resultHandle') }
        : {}),
      // `create` and `secret.replace` are the only provider intents whose strict
      // input carries the write-only client secret. Observation reaches every
      // installed plugin's after-hook, so the secret is dropped at this owner.
      ...(id === 'identity.providers.create' || id === 'identity.providers.secret.replace'
        ? { projectObservationInput: redactObservationInputPaths('clientSecret') }
        : {}),
      inputHints: { fields: [] },
      cli: {
        commands: [{ path: [...metadata.cliPath], visibility: 'canonical' }],
        acceptsServerId: true,
        requiresServerId: true,
      },
      ...(id === 'identity.providers.remove'
        ? { bindings: { sdkMethod: 'identity.providers.remove.execute' } }
        : {}),
      serverTransport: { method: 'POST', path: MANAGED_IDENTITY_PROVIDER_ACTION_PATHS_V1[id] },
    };
  }),
));
