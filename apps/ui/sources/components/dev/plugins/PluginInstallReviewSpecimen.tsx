import * as React from 'react';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';

import { useInPlaceApprovalReview } from '@/components/approvals/ApprovalReviewInPlace';
import {
  usePluginInstallOnMachinesSheet,
  type PluginInstallOnMachinesSheetInput,
} from '@/components/settings/plugins/listing/PluginInstallOnMachines';
import type {
  PluginInstallReviewRow,
  PluginInstallReviewSet,
} from '@/components/settings/plugins/model/usePluginInstallReviewSet';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { MachineAdministrationCandidateV1 } from '@/sync/domains/machines/administration/targetSelection';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { preparePluginInstallReviewHttpFixture } from './pluginInstallReviewHttpFixture';

/**
 * Dev-only specimen of the combined plugin install review (PL-41) drawn by its real sheet over HTTP fixture approvals,
 * one per Machine, with the evaluated facts a daemon returns. `?state=review` (default): one Machine ready, one
 * declined elsewhere (left out of the press), one on a Home this device cannot name. `?state=settled`: installed,
 * declined, changed since review, and failed with its reason. `?state=single&machine=<id>` opens the single in-place
 * review of an Update on a Machine this Home knows. Rows come from fixture data and `run` decides nothing; pressing
 * Install would reach the real route and fail for these fixture approvals. It proves composition only.
 */
type Status = 'open' | 'rejected' | 'executed' | 'superseded' | 'failed';
type Fixture = Readonly<{
  machineId: string;
  machine: string;
  home: string | null;
  availability: MachineAdministrationCandidateV1['availability'];
  review?: Status;
  settled?: Status;
  /** A Home this device has no single sign-in for. */
  foreignHome?: boolean;
  /** Answered without an approval (refused before any review). */
  refused?: string;
}>;

const PLUGIN = {
  pluginId: 'acme.storage-sync',
  title: 'Storage Sync',
  sourceId: 'acme-catalog',
  version: '2.4.0',
} as const;
const FIXTURES: readonly Fixture[] = [
  {
    machineId: 'studio-mac-mini',
    machine: 'Studio Mac mini',
    home: null,
    availability: 'online',
    review: 'open',
    settled: 'executed',
  },
  {
    machineId: 'build-box',
    machine: 'build-box',
    home: null,
    availability: 'online',
    review: 'rejected',
    settled: 'rejected',
  },
  {
    machineId: 'lab-pi',
    machine: 'lab-pi',
    home: 'Lab Home',
    availability: 'online',
    review: 'open',
    foreignHome: true,
  },
  {
    machineId: 'media-server',
    machine: 'Media server',
    home: null,
    availability: 'online',
    settled: 'superseded',
  },
  {
    machineId: 'office-nas',
    machine: 'Office NAS',
    home: null,
    availability: 'online',
    settled: 'failed',
  },
  {
    machineId: 'guest-laptop',
    machine: 'Guest laptop',
    home: null,
    availability: 'online',
    review: 'open',
    refused: 'This Machine does not allow plugin installation.',
  },
  {
    machineId: 'old-thinkpad',
    machine: 'Old ThinkPad',
    home: null,
    availability: 'offline',
  },
  {
    machineId: 'travel-air',
    machine: 'Travel MacBook Air',
    home: null,
    availability: 'unknown',
  },
];

function artifactId(state: string, machineId: string) {
  return `plugin-install-review-specimen:${state}:${machineId}`;
}

function buildRequest(
  params: Readonly<{
    serverId: string;
    accountId: string;
    serverIdentityId?: string;
    machineId: string;
    status: Status;
    update: boolean;
    id: string;
  }>,
) {
  const actionArgs = {
    machineId: params.machineId,
    source: {
      kind: 'marketplace',
      sourceId: PLUGIN.sourceId,
      pluginId: PLUGIN.pluginId,
      version: PLUGIN.version,
    },
  };
  const summary = `${params.update ? 'Update' : 'Install'} ${PLUGIN.title}`;
  const executionOriginV1 = buildApprovalExecutionOriginV1({
    actionId: 'plugins.install',
    input: actionArgs,
    targetSessionId: null,
    context: {
      surface: 'ui',
      authority: 'present_user',
      serverId: params.serverId,
      serverIdentityId: params.serverIdentityId,
      runtimeAccountId: params.accountId,
      actionRequestId: params.id,
      actionCaller: { kind: 'host' },
      externalActionTarget: { kind: 'machine', machineId: params.machineId },
    },
  });
  const review = createPluginInstallationReviewFixture({
    pluginId: PLUGIN.pluginId,
    displayName: PLUGIN.title,
    version: PLUGIN.version,
    publisherIdentity: { status: 'unavailable' },
    requiredHostAccess: [
      {
        id: 'account-storage',
        capability: 'storage.account',
        reason: 'Keeps your sync folders and history',
        authorizationClass: 'cooperativeDisclosure',
        normalizedScope: { enabled: true },
      },
    ],
  });
  const now = 1_793_491_200_000;
  const decidedAtMs = now - 60_000;
  const status = params.status === 'superseded' ? 'failed' : params.status;
  const settlement =
    params.status === 'open'
      ? {}
      : params.status === 'rejected'
        ? { decision: { kind: 'reject', decidedAtMs } }
        : params.status === 'executed'
          ? {
              decision: { kind: 'approve', decidedAtMs },
              execution: { executedAtMs: decidedAtMs, ok: true,
                result: { ok: true, kind: 'plugins_install', outcome: 'applied' } },
            }
          : {
              decision: { kind: 'approve', decidedAtMs },
              execution: {
                executedAtMs: decidedAtMs,
                ok: false,
                effectAttempted: false,
                ...(params.status === 'superseded'
                  ? {
                      errorCode: 'plugin_change_superseded',
                      error: 'The release changed after it was reviewed.',
                    }
                  : {
                      errorCode: 'plugin_install_failed',
                      error:
                        'This Machine runs Happier 0.2.14; Storage Sync needs 0.3 or later.',
                    }),
              },
            };
  return ApprovalRequestV2Schema.parse({
    v: 2,
    status,
    createdAtMs: now - 240_000,
    updatedAtMs: now - 60_000,
    createdBy: { surface: 'system' },
    requestedSurface: 'ui',
    actionId: 'plugins.install',
    actionArgs,
    executionOriginV1,
    summary,
    preview: {
      actionId: 'plugins.install',
      actionArgs,
      summary,
      pluginInstall: {
        permissionsDisclosure: 'daemonEvaluated',
        pendingReview: {
          kind: 'reviewRequired',
          reviewKind: 'installation',
          pendingChangeId: `candidate-${params.machineId}`,
          reason: params.update ? 'authorityExpansion' : 'firstInstall',
          currentVersion: params.update ? '2.3.1' : null,
          authorityExpansion: params.update ? ['requiredHostAccess'] : [],
          review,
        },
      },
    },
    ...settlement,
  });
}

export function PluginInstallReviewSpecimen(
  props: Readonly<{ state: string; machineId?: string }>,
) {
  const scope = useActiveServerAccountScope();
  const serverId = scope?.serverId;
  const accountId = scope?.accountId;
  useServerProfilesGeneration();
  const serverIdentityId = serverId ? getServerProfileById(serverId)?.serverIdentityId : null;
  const state = props.state === 'single' ? 'single' : props.state === 'settled' ? 'settled' : 'review';
  const machineId = props.machineId ?? 'machine-specimen';
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    if (!serverId || !accountId || !serverIdentityId) return;
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    setReady(false);
    const fixtures = state === 'single'
      ? [{ machineId, status: 'open' as const }]
      : FIXTURES.flatMap(fixture => {
          const status = state === 'settled' ? fixture.settled : fixture.review;
          return status && !fixture.foreignHome && !fixture.refused ? [{ machineId: fixture.machineId, status }] : [];
        });
    const artifacts = fixtures.map(fixture => {
      const id = artifactId(state, fixture.machineId);
      const request = buildRequest({ ...fixture, serverId, accountId,
        serverIdentityId,
        id, update: state === 'single' });
      return { id, header: buildApprovalRequestArtifactHeaderV1(request), title: request.summary ?? '',
        body: JSON.stringify(request), headerVersion: 1, bodyVersion: 1, seq: 1,
        createdAt: 1, updatedAt: 1, isDecrypted: true } satisfies DecryptedArtifact;
    });
    void preparePluginInstallReviewHttpFixture(serverId, artifacts, controller.signal).then(install => {
      if (controller.signal.aborted) return;
      dispose = install();
      setReady(true);
    }).catch(error => { if (!controller.signal.aborted) throw error; });
    return () => { controller.abort(); dispose?.(); };
  }, [accountId, machineId, serverId, serverIdentityId, state]);
  if (!ready) return <ItemList presentation="page" />;
  return state === 'single' ? <SingleReview machineId={machineId} /> : <CombinedReview state={state} />;
}

function CombinedReview(props: Readonly<{ state: 'review' | 'settled' }>) {
  const scope = useActiveServerAccountScope();
  const homeLabel = 'Home';
  const candidates = React.useMemo(
    (): readonly MachineAdministrationCandidateV1[] =>
      FIXTURES.map((fixture) => ({
        target: {
          serverIdentityId: fixture.foreignHome
            ? 'srv_specimen_lab_home'
            : (scope?.serverId ?? 'specimen'),
          machineId: fixture.machineId,
        },
        displayName: fixture.machine,
        serverLabel: fixture.home ?? homeLabel,
        availability: fixture.availability,
        observation: 'live',
        observedAt: Date.now(),
      })),
    [scope?.serverId],
  );
  const [review, setReview] = React.useState<PluginInstallReviewSet | null>(
    null,
  );
  const run = React.useCallback(
    async (targets: readonly MachineAdministrationTargetV1[]) => {
      if (!scope) return;
      await new Promise((resolve) => setTimeout(resolve, 600));
      const chosen = new Set(targets.map((target) => target.machineId));
      setReview({
        pluginId: PLUGIN.pluginId,
        rows: FIXTURES.filter((fixture) => chosen.has(fixture.machineId)).map(
          (fixture): PluginInstallReviewRow => {
            const target = {
              serverIdentityId: fixture.foreignHome
                ? 'srv_specimen_lab_home'
                : scope.serverId,
              machineId: fixture.machineId,
            };
            const targetLabel = {
              machine: fixture.machine,
              server: fixture.home ?? homeLabel,
            };
            const status =
              props.state === 'review' ? fixture.review : fixture.settled;
            if (!status || fixture.refused) {
              const result: ActionExecuteResult = {
                ok: false,
                errorCode: 'plugin_change_daemon_unavailable',
                error:
                  fixture.refused ?? 'This Machine is not reachable right now.',
              };
              return { kind: 'settled', target, targetLabel, result };
            }
            // A Home with no single sign-in here keeps its portable identity, as the review set does.
            return {
              kind: 'approval',
              target,
              targetLabel,
              artifactId: artifactId(props.state, fixture.machineId),
              serverId: fixture.foreignHome
                ? target.serverIdentityId
                : scope.serverId,
            };
          },
        ),
      });
    },
    [props.state, scope],
  );
  const input = React.useMemo(
    (): PluginInstallOnMachinesSheetInput => ({
      name: PLUGIN.title,
      candidates,
      initialTarget: candidates[0]?.target ?? null,
      review,
      run,
    }),
    [candidates, review, run],
  );
  const open = usePluginInstallOnMachinesSheet(input);
  const ready = Boolean(scope);
  React.useEffect(() => {
    if (ready) open();
  }, [open, ready]);
  return (
    <ItemList presentation="page">
      <RoundButton
        title={`Open the combined review (${props.state})`}
        onPress={() => {
          setReview(null);
          open();
        }}
      />
    </ItemList>
  );
}

function SingleReview(props: Readonly<{ machineId: string }>) {
  const scope = useActiveServerAccountScope();
  const id = artifactId('single', props.machineId);
  useInPlaceApprovalReview({
    approvalId: id,
    approvalPending: true,
    serverId: scope?.serverId ?? null,
  });
  return <ItemList presentation="page" />;
}
