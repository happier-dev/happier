import { describe, expect, it } from 'vitest';
import { openGithubDeploymentMonitoringV1 } from './deploymentMonitoring.js';
import { GITHUB_CONNECTED_ACCOUNT_SERVICE, GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';

const input = { repository: 'acme/widgets', credentialRef: { service: GITHUB_CONNECTED_ACCOUNT_SERVICE, accountId: 'selected-account' },
  monitoringMachineId: 'monitor-machine' };

describe('Deployment monitoring authoring intent', () => {
  it('opens the existing generic Event editor with the exact source/account/placement without enrolling', async () => {
    const opened: unknown[] = [];
    const signal = new AbortController().signal;
    // The public UI host is the real process boundary; no setup Action,
    // definition writer or internal editor logic is replaced here.
    expect(await openGithubDeploymentMonitoringV1(input, { signal, ui: {
      openAutomationEvent: async (request, options) => { expect(options?.signal).toBe(signal); opened.push(request); },
    } })).toEqual({ status: 'opened' });
    expect(opened).toEqual([{ eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: 'automation/deployment-review-v1' },
      monitoringMachineId: input.monitoringMachineId, connectedAccount: input.credentialRef,
      setupInput: { repository: input.repository, credentialRef: input.credentialRef,
        deploymentReview: { monitoringMachineId: input.monitoringMachineId } } }]);
  });

  it('does not open for a withdrawn intent or a different provider account', async () => {
    let opens = 0;
    const ui = { openAutomationEvent: async () => { opens++; } };
    expect(await openGithubDeploymentMonitoringV1(input, { signal: AbortSignal.abort(), ui })).toEqual({ status: 'unavailable' });
    await expect(openGithubDeploymentMonitoringV1({ ...input,
      credentialRef: { ...input.credentialRef, service: { pluginId: 'example.other', localId: 'account' } },
    }, { signal: new AbortController().signal, ui })).rejects.toMatchObject({ code: 'github_monitoring_input_invalid' });
    expect(opens).toBe(0);
  });

  it('opens repository-only intent with account and monitoring Machine left for the existing editor', async () => {
    const opened: unknown[] = [];
    expect(await openGithubDeploymentMonitoringV1({ repository: input.repository }, {
      signal: new AbortController().signal, ui: { openAutomationEvent: async request => { opened.push(request); } },
    })).toEqual({ status: 'opened' });
    expect(opened).toEqual([{ eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: 'automation/deployment-review-v1' },
      setupInput: { repository: input.repository } }]);
  });
});
