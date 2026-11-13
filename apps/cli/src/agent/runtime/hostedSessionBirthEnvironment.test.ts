import { describe, expect, it } from 'vitest';
import { initializeBackendRunSession } from './initializeBackendRunSession';
import type { InitializeBackendRunSessionOptions } from './initializeBackendRunSession';
import { runAddedHostedSession } from './lifecycle/hostedSessionScope';
import { captureSessionLaunchControlMetadata } from './createSessionMetadata';
import { readSessionAttachMetadataIdentityPolicyFromEnv } from './readSessionAttachMetadataIdentityPolicyFromEnv';
import { readSessionCreateOriginFromEnv } from '@/session/shared/sessionCreateOrigin';
import { readSessionCreateManagerFromEnv } from '@/session/shared/sessionCreateManager';
import { readSessionCreateRolesFromEnv } from '@/session/shared/sessionCreateRoles';
import { readSessionCreateAuthoringOriginFromEnv } from '@/session/shared/sessionCreateAuthoringOrigin';

// Exercise the actual launch-carrier adapters used by runHostSessionRuntime and
// initializeBackendRunSession, with interleaved Sessions on one process.
const paths = [
  { name: 'launch metadata', key: 'HAPPIER_SESSION_PROFILE_ID', values: ['profile-a', 'profile-b'],
    read: () => captureSessionLaunchControlMetadata().profileId },
  { name: 'attach identity policy', key: 'HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY',
    values: ['preserve_current_identity', 'replace_with_runtime_identity'], read: readSessionAttachMetadataIdentityPolicyFromEnv, consumed: true },
  { name: 'creation origin', key: 'HAPPIER_SESSION_CREATE_ORIGIN_V1_JSON',
    values: [{ originKind: 'session', originSessionId: 'parent-a' }, { originKind: 'session', originSessionId: 'parent-b' }], read: readSessionCreateOriginFromEnv },
  { name: 'creation manager', key: 'HAPPIER_SESSION_CREATE_MANAGER_V1_JSON',
    values: [{ sessionId: 'manager-a' }, { sessionId: 'manager-b' }], read: readSessionCreateManagerFromEnv },
  { name: 'creation roles', key: 'HAPPIER_SESSION_CREATE_ROLES_V1_JSON',
    values: ['a', 'b'].map(role => ({ roleId: role, overrides: {}, sessionRoles: {}, notes: role })), read: readSessionCreateRolesFromEnv },
  { name: 'authoring origin', key: 'HAPPIER_SESSION_CREATE_AUTHORING_ORIGIN_V1_JSON',
    values: ['a', 'b'].map(id => ({ kind: 'project', accountId: `account-${id}`, page: 'overview',
      workspace: { serverId: 'home', workspaceId: `workspace-${id}`, machineId: 'machine', rootPath: '/repo' } })),
    read: readSessionCreateAuthoringOriginFromEnv, consumed: true },
];

describe('hosted Session birth carriers', () => {
  for (const path of paths) {
    it(`reads ${path.name} from its Session without consuming another Session's carrier`, async () => {
      const environments = path.values.map(value => ({ [path.key]: typeof value === 'string' ? value : JSON.stringify(value) }));
      const results = await Promise.all(environments.map(environment => runAddedHostedSession({
        environment, workingDirectory: '/repo', end: () => undefined,
      }, async () => {
        await Promise.resolve();
        return path.read();
      })));
      expect(results).toEqual(path.values);
      if (path.consumed) for (const environment of environments) expect(environment[path.key]).toBeUndefined();
    });
  }
});

// Stop at the server boundary after production initialization has built the
// create request. No lifecycle, metadata, or carrier reader is replaced.
describe('hosted Session initialization to server creation', () => {
  it('keeps birth attribution, roles and consumed carriers local across interleaved Sessions', async () => {
    const outcomes = await Promise.all(['a', 'b'].map(id => {
      const authoringOrigin = { kind: 'project', accountId: `account-${id}`, page: 'overview',
        workspace: { serverId: 'home', workspaceId: `workspace-${id}`, machineId: 'machine', rootPath: '/repo' } };
      const roles = { roleId: id, overrides: {}, sessionRoles: {}, notes: id };
      const environment: NodeJS.ProcessEnv = {
        HAPPIER_SESSION_CREATE_ORIGIN_V1_JSON: JSON.stringify({ originKind: 'session', originSessionId: `parent-${id}` }),
        HAPPIER_SESSION_CREATE_MANAGER_V1_JSON: JSON.stringify({ sessionId: `manager-${id}` }),
        HAPPIER_SESSION_CREATE_ROLES_V1_JSON: JSON.stringify(roles),
        HAPPIER_SESSION_CREATE_AUTHORING_ORIGIN_V1_JSON: JSON.stringify(authoringOrigin),
        HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY: 'preserve_current_identity',
      };
      return runAddedHostedSession({ environment, workingDirectory: '/repo', end: () => undefined }, async () => {
        await Promise.resolve();
        let request: Parameters<InitializeBackendRunSessionOptions['api']['getOrCreateSession']>[0] | undefined;
        const boundaryStop = new Error('server boundary stop');
        await expect(initializeBackendRunSession({
          api: {
            getOrCreateSession: async input => { request = input; throw boundaryStop; },
            sessionSyncClient: () => { throw new Error('creation must stop at the server boundary'); },
          },
          sessionTag: `tag-${id}`,
          metadata: {} as InitializeBackendRunSessionOptions['metadata'],
          state: { controlledByUser: false },
          uiLogPrefix: '[hosted birth]',
          startupMetadataOverrides: { permissionModeOverride: { mode: 'default', updatedAt: 1 } },
        })).rejects.toBe(boundaryStop);
        return { request, environment, authoringOrigin, roles, id };
      });
    }));
    for (const { request, environment, authoringOrigin, roles, id } of outcomes) {
      expect(request).toMatchObject({ originKind: 'session', originSessionId: `parent-${id}`,
        manager: { sessionId: `manager-${id}` }, metadata: { work: { authoringOriginV1: authoringOrigin, sessionRolesV1: roles } } });
      expect(environment.HAPPIER_SESSION_CREATE_AUTHORING_ORIGIN_V1_JSON).toBeUndefined();
      expect(environment.HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY).toBeUndefined();
    }
  });
});
