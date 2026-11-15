import { describe, expect, it } from 'vitest';
import { isPluginError } from '@happier-dev/plugin-sdk';

import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import type {
  HostAgentIsolationLaunchContext,
  HostAgentIsolationLaunchSnapshot,
} from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { createMemberAgentCliLaunchContext, readMemberAgentCliLaunchContext } from './memberAgentCliLaunch';

const machine: HostAgentIsolationLaunchSnapshot = {
  enabled: true,
  memberProvisioning: 'linuxUsersV1',
  status: { kind: 'effective', platform: 'linux' },
  workspaceRoots: [],
};
const member = deriveAgentIsolationMemberIdentity({
  homeServerIdentityId: 'home',
  requester: {
    serverId: 'server',
    accountId: 'member',
    machineId: 'machine',
    installationId: 'installation',
  },
});

function readCause(
  context: HostAgentIsolationLaunchContext,
  site: Parameters<typeof readMemberAgentCliLaunchContext>[1],
) {
  try {
    readMemberAgentCliLaunchContext(context, site);
  } catch (error) {
    if (!isPluginError(error)) throw error;
    return { code: error.code, details: error.details };
  }
  return null;
}

describe.skipIf(process.platform !== 'linux')(
  'member Agent CLI launch refusal cause (R126U3)',
  () => {
    it('names the services family and whether the member was absent or not yet prepared', () => {
      // The daemon's Machine-level context: member placement, no Session member.
      const machineLevel: HostAgentIsolationLaunchContext = {
        managedHappierBinaryPath: '/opt/happier/cli/current/happier',
        read: () => machine,
      };
      // A Session context before its launch is prepared: member known, launch absent.
      const sessionBeforeLaunch: HostAgentIsolationLaunchContext = {
        read: () => ({ ...machine, memberIdentity: member }),
      };

      expect(readCause(machineLevel, 'agent_invocation_services')).toEqual({
        code: 'agent_isolation_unavailable',
        details: {
          phase: 'agent_invocation_services',
          reason: 'member_identity_absent',
        },
      });
      expect(readCause(machineLevel, 'retained_runner_agent_services')).toEqual(
        {
          code: 'agent_isolation_unavailable',
          details: {
            phase: 'retained_runner_agent_services',
            reason: 'member_identity_absent',
          },
        },
      );
      expect(
        readCause(sessionBeforeLaunch, 'agent_invocation_services'),
      ).toEqual({
        code: 'agent_isolation_unavailable',
        details: {
          phase: 'agent_invocation_services',
          reason: 'member_launch_not_prepared',
        },
      });
      // Spawn preparation with a Session member but no installed Happier CLI on the context.
      expect(() => createMemberAgentCliLaunchContext({
        material: { runtimeHome: member.home, memberIdentity: member },
      })).toThrow(expect.objectContaining({
        code: 'agent_isolation_unavailable',
        details: { phase: 'member_launch_preparation', reason: 'installed_cli_absent' },
      }));
    });
  },
);
