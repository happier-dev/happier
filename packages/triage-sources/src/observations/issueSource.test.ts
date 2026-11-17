import { describe, expect, it } from 'vitest';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createTriageIssueEventSourceSetupV1 } from './issueSource.js';

const accountData = {
  v: 1,
  instance: {
    source: { pluginId: 'happier.telemetry', localId: 'exceptions' },
    sourceInstanceId: '0b0e57a0-3c7e-4c7a-9f39-6a4f1f0a1b2c',
  },
  binding: { purpose: 'exceptions', source: 'accountData' },
  localInstanceKey: 'happier-exceptions',
  configuration: { v: 1, token: 'happier-exceptions-v1' },
};
const connected = {
  ...accountData,
  instance: {
    ...accountData.instance,
    sourceInstanceId: '1b0e57a0-3c7e-4c7a-9f39-6a4f1f0a1b2c',
  },
  binding: {
    purpose: 'exceptions',
    account: {
      service: { pluginId: 'happier.telemetry', localId: 'account' },
      accountId: 'acct',
    },
  },
};

/** The configured-source read is the plugin-to-host Action boundary; setup logic above it is real. */
function context(configured: unknown): PluginInvocationContext {
  return {
    signal: new AbortController().signal,
    services: {
      actions: {
        execute: async () => ({
          kind: 'read',
          status: 'complete',
          instances: [{ v: 1, lifecycle: 'active', configured }],
        }),
      },
    },
  } as unknown as PluginInvocationContext;
}

describe('issue event setup', () => {
  const commit = createTriageIssueEventSourceSetupV1({
    pluginId: 'happier.telemetry',
    sourceLocalId: 'exceptions',
    displayName: 'Happier exceptions',
    publication: 'commit',
  });
  const scan = createTriageIssueEventSourceSetupV1({
    pluginId: 'happier.telemetry',
    sourceLocalId: 'exceptions',
    displayName: 'Happier exceptions',
  });

  it('arms a commit-published Account-data source without a polling period', async () => {
    const result = await commit(
      { sourceInstanceId: accountData.instance.sourceInstanceId },
      context(accountData),
    );
    expect(result).toMatchObject({
      sourceInstanceId: accountData.instance.sourceInstanceId,
      sourceConfig: {
        v: 1,
        instance: accountData,
        investigation: { mode: 'inbox' },
      },
    });
    expect(JSON.stringify(result)).not.toContain('checkPeriodMs');
  });

  it('refuses a polling interval, a connected-account instance for commit mode, and an Account-data instance for polling', async () => {
    await expect(
      commit(
        {
          sourceInstanceId: accountData.instance.sourceInstanceId,
          checkPeriodSeconds: 60,
        },
        context(accountData),
      ),
    ).rejects.toMatchObject({ code: 'triage_issue_source_unavailable' });
    await expect(
      commit(
        { sourceInstanceId: connected.instance.sourceInstanceId },
        context(connected),
      ),
    ).rejects.toMatchObject({ code: 'triage_issue_source_unavailable' });
    await expect(
      scan(
        { sourceInstanceId: accountData.instance.sourceInstanceId },
        context(accountData),
      ),
    ).rejects.toMatchObject({ code: 'triage_issue_source_unavailable' });
  });
});
