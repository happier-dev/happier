// Enter through the mounted catalog consumer, matching App-shell evaluation.
import '@/components/settings/catalog/runtime/useResolvedSettingsPageCatalog';
import { expect, it } from 'vitest';
import type { SessionApprovalConsentsStoreV1 } from '@happier-dev/protocol/actions/sessionApprovalConsentsV1';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { createSettingsDeclarationAction } from './settingsDeclarationAction';

/** The Account Artifact transport is the persisted boundary; the policy Action and the consent owner stay real. */
function createArtifactBoundary(): SessionApprovalConsentsStoreV1 {
  const records = new Map<
    string,
    { header: Readonly<Record<string, unknown>>; body: string; version: number }
  >();
  return {
    list: async (options) => ({
      items: [...records]
        .filter(
          ([, record]) =>
            record.header.kind === options.kinds?.[0] &&
            options.approvalSessionIds?.includes(
              String(record.header.sessionId),
            ),
        )
        .map(([artifactId, record]) => ({
          artifactId,
          header: record.header,
          body: record.body,
          access: 'owner' as const,
          revision: {
            headerVersion: record.version,
            bodyVersion: record.version,
          },
        })),
    }),
    create: async ({ header, body }) => {
      records.set('consents', { header, body, version: 1 });
      return {
        artifactId: 'consents',
        revision: { headerVersion: 1, bodyVersion: 1 },
      };
    },
    update: async ({ artifactId, header, body }) => {
      const version = (records.get(artifactId)?.version ?? 0) + 1;
      records.set(artifactId, { header, body, version });
      return {
        ok: true,
        revision: { headerVersion: version, bodyVersion: version },
      };
    },
  };
}

it('saves the approval sheet\'s "On {Machine}" choice as a Machine-scoped Session row', async () => {
  const action = createSettingsDeclarationAction({
    host: { os: 'web', desktop: false },
    tauriDesktop: false,
    readPageGate: () => undefined,
    isFeatureEnabled: async () => true,
    isCurrent: () => true,
    readAccountSettings: async () => settingsDefaults,
    writeAccountSettings: async () => {},
    mutateAccountSettings: async () => {},
    readLocalSettings: () => localSettingsDefaults,
    writeLocalSettings: () => {},
    sessionApprovalConsents: createArtifactBoundary(),
  });
  const session = { sessionId: 'agent-session' };
  const scope = { kind: 'machine' as const, machineId: 'machine-1' };
  // The input `useSessionApprovalConsents.setRow` sends for the sheet's scoped rung.
  expect(
    await action({
      actionId: 'actions.policy.set',
      input: {
        actionId: 'machines.reachability.inspect',
        audience: 'agent',
        session,
        scope,
        mode: 'allowed',
      },
    }),
  ).toMatchObject({ session, scope, mode: 'allowed' });
  expect(
    await action({ actionId: 'actions.policy.get', input: { session } }),
  ).toEqual({
    session,
    rows: [
      {
        actionId: 'machines.reachability.inspect',
        audience: 'agent',
        scope,
        mode: 'allowed',
      },
    ],
  });
});
