import {
  ApiTokenGrantV1Schema,
  evaluateApiTokenGrantV1,
  type ApiTokenGrantV1,
} from '../auth/apiTokenGrant.js';
import { EmbedConfigV1Schema, type EmbedConfigV1 } from './embedConfigV1.js';

/** Settings controls project the canonical grant; they are not a second authority format. */
export type EmbedAccessV1 = {
  send: boolean;
  approve: boolean;
  changeModel: boolean;
  models: ApiTokenGrantV1['models'];
  permissionModes: ApiTokenGrantV1['permissionModes'];
  sites: ApiTokenGrantV1['origins'];
  create: ApiTokenGrantV1['create'];
};

export function buildEmbedParentGrantV1(options: EmbedAccessV1, embedConfig: EmbedConfigV1): ApiTokenGrantV1 {
  const config = EmbedConfigV1Schema.parse(embedConfig);
  if (config.newChat?.enabled && options.create === null) {
    throw new Error('An enabled new chat requires a creation grant.');
  }
  const actions: NonNullable<ApiTokenGrantV1['actions']> = {
    families: ['session_transcripts', 'session_targeting'],
    ids: [],
  };
  if (options.send) {
    actions.families.push('messaging');
    actions.ids.push('session.turn.cancel');
  }
  if (options.create !== null) actions.ids.push('session.spawn_new');
  if (options.changeModel) actions.ids.push('session.model.set');
  if ((options.permissionModes?.length ?? 0) > 1) actions.ids.push('session.permission_mode.set');

  return ApiTokenGrantV1Schema.parse({
    v: 1,
    actions,
    targets: null,
    approve: options.approve,
    origins: options.sites,
    models: options.models,
    permissionModes: options.permissionModes,
    create: options.create === null ? null : {
      machineId: options.create.machineId,
      agentTargetKey: options.create.agentTargetKey,
      directory: 'managed',
      placement: config.organization,
    },
  });
}

export function deriveEmbedAccessFromGrantV1(input: ApiTokenGrantV1): EmbedAccessV1 {
  const grant = ApiTokenGrantV1Schema.parse(input);
  // This is an action-control projection, not target admission. The canonical
  // evaluator still decides action membership, including family grants.
  const actionGrant = { ...grant, targets: null };
  const allows = (actionId: string): boolean => evaluateApiTokenGrantV1({ grant: actionGrant, actionId }).ok;
  const create = grant.create !== null && evaluateApiTokenGrantV1({
    grant: actionGrant,
    actionId: 'session.spawn_new',
    target: { kind: 'machine', machineId: grant.create.machineId },
  }).ok ? grant.create : null;
  return {
    send: allows('session.message.send') && allows('session.user_action.answer'),
    approve: grant.approve,
    changeModel: allows('session.model.set'),
    models: grant.models,
    permissionModes: grant.permissionModes,
    sites: grant.origins,
    create,
  };
}
