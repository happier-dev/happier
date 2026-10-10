import { z } from 'zod';

import type { HomeIdentityActionIdV1 } from '../../teams/identity/actionIds.js';
import * as home from '../../home/identity.js';
import { TeamIdentityConnectionRemoveResultV1Schema, TeamIdentityConnectionTestStartResultV1Schema } from '../../teams/identity/connection.js';
import { TeamIdentityWorkosAdminPortalLinkCreateResultV1Schema } from '../../teams/identity/workos.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import type { HomeDomainActionRow } from './homeDomainRow.js';
import { TEAM_ACTION_SPECS } from './teams.js';

export const HOME_IDENTITY_ACTION_PATHS_V1 = Object.freeze({
  'home.identity.connections.list': '/v1/home/identity/connections/list',
  'home.identity.connections.create': '/v1/home/identity/connections/create',
  'home.identity.connections.settings.update': '/v1/home/identity/connections/settings/update',
  'home.identity.connections.enable': '/v1/home/identity/connections/enable',
  'home.identity.connections.disable': '/v1/home/identity/connections/disable',
  'home.identity.connections.remove.preview': '/v1/home/identity/connections/remove/preflight',
  'home.identity.connections.remove': '/v1/home/identity/connections/remove',
  'home.identity.connections.test.start': '/v1/home/identity/connections/test/start',
  'home.identity.connections.test.consume': '/v1/home/identity/connections/test/consume',
  'home.identity.workos.adminPortalLink.create': '/v1/home/identity/workos/admin-portal-link/create',
  'home.identity.workos.connection.create': '/v1/home/identity/workos/connection/create',
  'home.identity.workos.reconcile': '/v1/home/identity/workos/reconcile',
  'home.identity.workos.connection.set': '/v1/home/identity/workos/connection/set',
} satisfies Record<HomeIdentityActionIdV1, string>);

export const HOME_IDENTITY_ACTION_INPUT_SCHEMAS_V1 = Object.freeze({
  'home.identity.connections.list': home.HomeIdentityConnectionListInputV1Schema,
  'home.identity.connections.create': home.HomeIdentityConnectionCreateInputV1Schema,
  'home.identity.connections.settings.update': home.HomeIdentityConnectionSettingsUpdateInputV1Schema,
  'home.identity.connections.enable': home.HomeIdentityConnectionRefInputV1Schema,
  'home.identity.connections.disable': home.HomeIdentityConnectionRefInputV1Schema,
  'home.identity.connections.remove.preview': home.HomeIdentityConnectionRefInputV1Schema,
  'home.identity.connections.remove': home.HomeIdentityConnectionRefInputV1Schema,
  'home.identity.connections.test.start': home.HomeIdentityConnectionTestStartInputV1Schema,
  'home.identity.connections.test.consume': home.HomeIdentityConnectionTestConsumeInputV1Schema,
  'home.identity.workos.adminPortalLink.create': home.HomeIdentityWorkosAdminPortalLinkCreateInputV1Schema,
  'home.identity.workos.connection.create': home.HomeIdentityWorkosConnectionCreateInputV1Schema,
  'home.identity.workos.reconcile': home.HomeIdentityWorkosReconcileInputV1Schema,
  'home.identity.workos.connection.set': home.HomeIdentityWorkosConnectionSetInputV1Schema,
} satisfies Record<HomeIdentityActionIdV1, z.ZodType>);

export const HOME_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1 = Object.freeze({
  'home.identity.connections.list': home.HomeIdentityConnectionListResultV1Schema,
  'home.identity.connections.create': home.HomeIdentityConnectionMutationResultV1Schema,
  'home.identity.connections.settings.update': home.HomeIdentityConnectionMutationResultV1Schema,
  'home.identity.connections.enable': home.HomeIdentityConnectionMutationResultV1Schema,
  'home.identity.connections.disable': home.HomeIdentityConnectionMutationResultV1Schema,
  'home.identity.connections.remove.preview': home.HomeIdentityConnectionRemovalPreflightV1Schema,
  'home.identity.connections.remove': TeamIdentityConnectionRemoveResultV1Schema,
  'home.identity.connections.test.start': TeamIdentityConnectionTestStartResultV1Schema,
  'home.identity.connections.test.consume': home.HomeIdentityConnectionTestConsumeResultV1Schema,
  'home.identity.workos.adminPortalLink.create': TeamIdentityWorkosAdminPortalLinkCreateResultV1Schema,
  'home.identity.workos.connection.create': home.HomeIdentityConnectionMutationResultV1Schema,
  'home.identity.workos.reconcile': home.HomeIdentityWorkosReconcileResultV1Schema,
  'home.identity.workos.connection.set': home.HomeIdentityConnectionMutationResultV1Schema,
} satisfies Record<HomeIdentityActionIdV1, z.ZodType>);

type SharedIdentitySpec<TId extends HomeIdentityActionIdV1> = Extract<
  (typeof TEAM_ACTION_SPECS)[number],
  { id: TId extends `home.${infer TSuffix}` ? `teams.${TSuffix}` : never }
>;

type HomeIdentityActionRow<TId extends HomeIdentityActionIdV1> = HomeDomainActionRow<
  TId,
  (typeof HOME_IDENTITY_ACTION_INPUT_SCHEMAS_V1)[TId],
  (typeof HOME_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1)[TId],
  SharedIdentitySpec<TId>['requiredAuthority']
>;

function homeIdentityActionRow<const TId extends HomeIdentityActionIdV1>(id: TId): HomeIdentityActionRow<TId>;
function homeIdentityActionRow(id: HomeIdentityActionIdV1): HomeIdentityActionRow<HomeIdentityActionIdV1> {
  // The checked exact id mapping preserves each row's authority and schema
  // types in generated SDK declarations as well as in the runtime catalog.
  const source = TEAM_ACTION_SPECS.find(
    (spec) => spec.id === id.replace('home.', 'teams.'),
  ) as SharedIdentitySpec<HomeIdentityActionIdV1> | undefined;
  if (!source) throw new TypeError(`Missing shared identity Action: ${id}`);
  const metadata: PreNormalizedActionSpec = source;
  return {
    ...metadata,
    id,
    requiredAuthority: source.requiredAuthority,
    executionPlacement: source.executionPlacement,
    title: source.title.replaceAll('Team', 'Home'),
    description: source.description!.replaceAll('Team', 'Home'),
    inputSchema: HOME_IDENTITY_ACTION_INPUT_SCHEMAS_V1[id],
    outputSchema: HOME_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1[id],
    serverTransport: { method: 'POST' as const, path: HOME_IDENTITY_ACTION_PATHS_V1[id] },
    cli: { commands: metadata.cli?.commands?.map((command) => ({
      ...command, path: ['home', ...command.path.slice(1)],
    })) ?? [], acceptsServerId: true, requiresServerId: true },
    inputHints: { fields: source.inputHints?.fields.filter((field) => field.path !== 'teamId') ?? [] },
    ...(metadata.bindings ? { bindings: {
      ...metadata.bindings,
      ...(metadata.bindings.sdkMethod ? { sdkMethod: metadata.bindings.sdkMethod.replace('teams.', 'home.') } : {}),
    } } : {}),
  };
}

// The scope adapter inherits authority, approval and bearer custody from the
// canonical identity rows rather than maintaining another security policy.
export const HOME_IDENTITY_ACTION_SPECS = Object.freeze([
  homeIdentityActionRow('home.identity.connections.list'),
  homeIdentityActionRow('home.identity.connections.create'),
  homeIdentityActionRow('home.identity.connections.settings.update'),
  homeIdentityActionRow('home.identity.connections.enable'),
  homeIdentityActionRow('home.identity.connections.disable'),
  homeIdentityActionRow('home.identity.connections.remove.preview'),
  homeIdentityActionRow('home.identity.connections.remove'),
  homeIdentityActionRow('home.identity.connections.test.start'),
  homeIdentityActionRow('home.identity.connections.test.consume'),
  homeIdentityActionRow('home.identity.workos.adminPortalLink.create'),
  homeIdentityActionRow('home.identity.workos.connection.create'),
  homeIdentityActionRow('home.identity.workos.reconcile'),
  homeIdentityActionRow('home.identity.workos.connection.set'),
]);
