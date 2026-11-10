import { z } from '../../zodRuntimePolicy.js';

import {
  TeamIdentityConnectionCreateInputV1Schema,
  TeamIdentityConnectionListInputV1Schema,
  TeamIdentityConnectionListResultV1Schema,
  TeamIdentityConnectionMutationResultV1Schema,
  TeamIdentityConnectionRefInputV1Schema,
  TeamIdentityConnectionSettingsUpdateInputV1Schema,
  TeamIdentityConnectionRemoveResultV1Schema,
  TeamIdentityConnectionRemovalPreflightV1Schema,
  TeamIdentityConnectionTestConsumeInputV1Schema,
  TeamIdentityConnectionTestConsumeResultV1Schema,
  TeamIdentityConnectionTestStartInputV1Schema,
  TeamIdentityConnectionTestStartResultV1Schema,
} from '../../teams/identity/connection.js';
import {
  TeamIdentityWorkosAdminPortalLinkCreateInputV1Schema,
  TeamIdentityWorkosAdminPortalLinkCreateResultV1Schema,
  TeamIdentityWorkosConnectionCreateInputV1Schema,
  TeamIdentityWorkosConnectionCreateResultV1Schema,
  TeamIdentityWorkosConnectionSetInputV1Schema,
  TeamIdentityWorkosReconcileInputV1Schema,
  TeamIdentityWorkosReconcileResultV1Schema,
} from '../../teams/identity/workos.js';
import type { TeamIdentityActionIdV1 } from '../../teams/actionsV1.js';

/**
 * The Team identity family's transport and codec lookup.
 *
 * It lives in the Action layer rather than beside the ids because the id
 * registry is initialized before any domain schema module: pulling the identity
 * schema graph into it made `ACTION_ID_FAMILIES_V1.teams` evaluate before its
 * own module finished, which left the whole Action catalog uninitialized. Ids
 * stay dependency-free; codecs live here with the rows that declare them.
 */
export const TEAM_IDENTITY_ACTION_PATHS_V1 = Object.freeze({
  'teams.identity.connections.list': '/v1/teams/identity/connections/list',
  'teams.identity.connections.create': '/v1/teams/identity/connections/create',
  'teams.identity.connections.settings.update': '/v1/teams/identity/connections/settings/update',
  'teams.identity.connections.enable': '/v1/teams/identity/connections/enable',
  'teams.identity.connections.disable': '/v1/teams/identity/connections/disable',
  'teams.identity.connections.remove.preview': '/v1/teams/identity/connections/remove/preflight',
  'teams.identity.connections.remove': '/v1/teams/identity/connections/remove',
  'teams.identity.connections.test.start': '/v1/teams/identity/connections/test/start',
  'teams.identity.connections.test.consume': '/v1/teams/identity/connections/test/consume',
  'teams.identity.workos.adminPortalLink.create': '/v1/teams/identity/workos/admin-portal-link/create',
  'teams.identity.workos.connection.create': '/v1/teams/identity/workos/connection/create',
  'teams.identity.workos.reconcile': '/v1/teams/identity/workos/reconcile',
  'teams.identity.workos.connection.set': '/v1/teams/identity/workos/connection/set',
} satisfies Record<TeamIdentityActionIdV1, string>);

export const TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1 = Object.freeze({
  'teams.identity.connections.list': TeamIdentityConnectionListInputV1Schema,
  'teams.identity.connections.create': TeamIdentityConnectionCreateInputV1Schema,
  'teams.identity.connections.settings.update': TeamIdentityConnectionSettingsUpdateInputV1Schema,
  'teams.identity.connections.enable': TeamIdentityConnectionRefInputV1Schema,
  'teams.identity.connections.disable': TeamIdentityConnectionRefInputV1Schema,
  'teams.identity.connections.remove.preview': TeamIdentityConnectionRefInputV1Schema,
  'teams.identity.connections.remove': TeamIdentityConnectionRefInputV1Schema,
  'teams.identity.connections.test.start': TeamIdentityConnectionTestStartInputV1Schema,
  'teams.identity.connections.test.consume': TeamIdentityConnectionTestConsumeInputV1Schema,
  'teams.identity.workos.adminPortalLink.create': TeamIdentityWorkosAdminPortalLinkCreateInputV1Schema,
  'teams.identity.workos.connection.create': TeamIdentityWorkosConnectionCreateInputV1Schema,
  'teams.identity.workos.reconcile': TeamIdentityWorkosReconcileInputV1Schema,
  'teams.identity.workos.connection.set': TeamIdentityWorkosConnectionSetInputV1Schema,
} satisfies Record<TeamIdentityActionIdV1, z.ZodMiniType>);

export const TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1 = Object.freeze({
  'teams.identity.connections.list': TeamIdentityConnectionListResultV1Schema,
  'teams.identity.connections.create': TeamIdentityConnectionMutationResultV1Schema,
  'teams.identity.connections.settings.update': TeamIdentityConnectionMutationResultV1Schema,
  'teams.identity.connections.enable': TeamIdentityConnectionMutationResultV1Schema,
  'teams.identity.connections.disable': TeamIdentityConnectionMutationResultV1Schema,
  'teams.identity.connections.remove.preview': TeamIdentityConnectionRemovalPreflightV1Schema,
  'teams.identity.connections.remove': TeamIdentityConnectionRemoveResultV1Schema,
  'teams.identity.connections.test.start': TeamIdentityConnectionTestStartResultV1Schema,
  'teams.identity.connections.test.consume': TeamIdentityConnectionTestConsumeResultV1Schema,
  'teams.identity.workos.adminPortalLink.create': TeamIdentityWorkosAdminPortalLinkCreateResultV1Schema,
  'teams.identity.workos.connection.create': TeamIdentityWorkosConnectionCreateResultV1Schema,
  'teams.identity.workos.reconcile': TeamIdentityWorkosReconcileResultV1Schema,
  'teams.identity.workos.connection.set': TeamIdentityConnectionMutationResultV1Schema,
} satisfies Record<TeamIdentityActionIdV1, z.ZodMiniType>);
