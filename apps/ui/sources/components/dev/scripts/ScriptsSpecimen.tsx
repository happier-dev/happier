import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import {
  readProjectManifestDocument,
  type ProjectManifestFileSnapshot,
} from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import type {
  ProjectDefinitionDetectionV1,
  ProjectNativeRefV1,
} from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';

import { ProjectManifestEditor } from '@/components/projects/projectSetup/ProjectManifestEditor';
import { ProjectScriptsContent } from '@/components/projects/projectSetup/ProjectScriptsBody';
import { createProjectManifestActionClient } from '@/components/projects/projectSetup/projectManifestActionClient';
import type { ProjectScriptsController } from '@/components/projects/projectSetup/useProjectScriptsController';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ProjectSetupReview } from '@/components/projects/projectSetup/ProjectSetupReview';
import { ActionOperationDetailModal } from '@/components/inbox/actionOperations/ActionOperationDetailModal';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';

/**
 * Dev-only specimen of the Scripts page, project file editor and setup review (Lane 12 lab
 * `s-scripts` PAGE/FIRST/EDIT/SETUP/SHARED/STATES/RAIL/OUTPUT), drawn through the real Scripts body, rows, editor model
 * and operation store with the lab's data so the lab can be compared side by side without a
 * signed-in Home or a daemon. Every control is a local stand-in; no Action is issued.
 */
const SERVER = 'server-specimen';
const MACHINE = 'devbox';
const WORKSPACE = {
  serverId: SERVER,
  workspaceId: 'w-specimen',
  machineId: MACHINE,
  rootPath: '/src/happier',
} as const;
const HASH = 'a41c9e2'.padEnd(64, '0');
const NOW = Date.now();

const pkg = (target: string): ProjectNativeRefV1 => ({
  kind: 'native',
  tool: 'package_script',
  file: 'package.json',
  target,
});
const MANIFEST = {
  version: 1,
  environment: { kind: 'toolchain', tool: 'mise', configPath: '.mise.toml' },
  environmentVariables: [
    { name: 'DATABASE_URL', kind: 'secret', required: true },
    { name: 'SENTRY_AUTH_TOKEN', kind: 'secret', required: false },
  ],
  workspace: {
    setup: [
      { kind: 'command', command: 'mise install' },
      { kind: 'command', command: 'yarn install --immutable' },
      { kind: 'command', command: 'yarn build:protocol' },
    ],
  },
  scripts: {
    test: {
      source: pkg('test'),
      execution: 'portable',
      memoryDemand: { bytes: 8 * 2 ** 30, basis: { kind: 'declared' } },
    },
    typecheck: { source: pkg('typecheck'), execution: 'portable' },
    lint: { source: pkg('lint') },
    e2e: { source: pkg('test:e2e') },
    'release-notes': {
      source: {
        kind: 'native',
        tool: 'mise',
        file: 'mise.toml',
        target: 'release-notes',
      },
    },
  },
  services: {
    web: { source: pkg('dev:ui'), port: 5173 },
    server: { source: pkg('dev:server'), port: 3005 },
  },
};
const DETECTION: ProjectDefinitionDetectionV1 = {
  entries: [
    ...['test', 'typecheck', 'lint', 'build', 'test:e2e'].map((target) => ({
      source: pkg(target),
      usage: 'script' as const,
    })),
    ...['dev:ui', 'dev:server', 'storybook'].map((target) => ({
      source: pkg(target),
      usage: 'service' as const,
    })),
    {
      source: {
        kind: 'native',
        tool: 'mise',
        file: 'mise.toml',
        target: 'release-notes',
      },
      usage: 'script',
    },
    {
      source: {
        kind: 'native',
        tool: 'make',
        file: 'Makefile',
        target: 'docker-build',
      },
      usage: 'script',
    },
    {
      source: {
        kind: 'native',
        tool: 'compose',
        file: 'compose.yaml',
        target: 'db',
      },
      usage: 'service',
    },
  ],
  environments: [
    { kind: 'toolchain', tool: 'mise', configPath: '.mise.toml' },
    { kind: 'toolchain', tool: 'nix_flake', configPath: 'flake.nix' },
  ],
  devcontainers: [],
  coverage: 'complete',
  diagnostics: [],
};

function definition(manifest: unknown): ProjectManifestFileSnapshot {
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const document = readProjectManifestDocument(bytes);
  return {
    basis: { kind: 'present', hash: HASH },
    document,
  } as ProjectManifestFileSnapshot;
}

function operation(
  id: string,
  purpose: 'setup' | 'script',
  state: ActionOperationSnapshotV1['state'],
  extra: Partial<ActionOperationSnapshotV1> = {},
): ActionOperationSnapshotV1 {
  const terminal =
    state === 'succeeded' || state === 'failed' || state === 'cancelled';
  return {
    version: 1,
    operationId: id,
    revision: 1,
    actionId: purpose === 'setup' ? 'projects.prepare' : 'projects.script.run',
    state,
    scope: { accountId: 'specimen', machineId: MACHINE },
    title: id,
    createdAt: NOW - 120_000,
    ...(state === 'accepted' ? {} : { startedAt: NOW - 106_000 }),
    ...(terminal ? { settledAt: NOW - 60_000 } : {}),
    ...(state === 'failed'
      ? { error: { errorCode: 'project_command_step_failed', error: 'project_command_step_failed' } }
      : {}),
    domainRef: {
      kind: 'projectCommand',
      purpose,
      serverId: SERVER,
      machineId:
        purpose === 'script' && id === 'op-test' ? 'hz-build-1' : MACHINE,
      workspaceRefId: WORKSPACE.workspaceId,
      cwd: WORKSPACE.rootPath,
      sourceWorkspace: WORKSPACE,
      ...(state === 'accepted' ? {} : { terminalId: `term-${id}` }),
    },
    cancellation: 'supported',
    ...extra,
  } as ActionOperationSnapshotV1;
}

function seedRuns(frame: string) {
  actionOperationStore.reset();
  const runs: Array<[string | null, ActionOperationSnapshotV1]> =
    frame === 'STATES'
      ? [
          ['test', operation('op-s1', 'script', 'accepted')],
          [
            'typecheck',
            operation('op-s2', 'script', 'running', {
              observation: {
                kind: 'stop_unconfirmed',
                code: 'stop_unconfirmed',
              },
            }),
          ],
          ['lint', operation('op-s3', 'script', 'failed')],
          [
            'e2e',
            operation('op-s4', 'script', 'running', {
              observation: {
                kind: 'outcome_uncertain',
                code: 'outcome_uncertain',
              },
            }),
          ],
        ]
      : [
          [
            null,
            operation(
              'op-setup',
              'setup',
              frame === 'SETUP' ? 'running' : 'succeeded',
              frame === 'SETUP'
                ? {
                    setupReview: {
                      kind: 'pendingApproval',
                      code: 'project_setup_consent_required',
                      reviewedEffect: {},
                      reviewedEffectDigest: 'd',
                    },
                  }
                : {},
            ),
          ],
          ['test', operation('op-test', 'script', 'running', { progress: { kind: 'indeterminate', label: '✓ sources/sync/runtime/orchestration/connectionManager.test.ts (38 tests) 812ms' } })],
          ['typecheck', operation('op-typecheck', 'script', 'succeeded', { startedAt: NOW - 168_000 })],
          ['lint', operation('op-lint', 'script', 'failed')],
        ];
  actionOperationStore.mergeSnapshots({
    serverId: SERVER,
    snapshots: runs.map(([name, snapshot]) => {
      if (!name || snapshot.domainRef?.kind !== 'projectCommand') return snapshot;
      const declared = (MANIFEST.scripts as Record<string, { source: unknown }>)[name];
      return { ...snapshot, domainRef: { ...snapshot.domainRef, script: { name, source: declared!.source },
        ...(snapshot.state === 'failed' ? { exitCode: 1 } : {}) } } as ActionOperationSnapshotV1;
    }),
  });
}

const client = createProjectManifestActionClient({
  workspace: WORKSPACE,
  expectedAccountId: 'specimen',
  execute: async () => ({
    ok: false,
    errorCode: 'specimen',
    error: 'specimen',
  }),
});

function controller(frame: string): ProjectScriptsController {
  const noop = async () => {};
  return {
    accountId: 'specimen',
    ready: true,
    client,
    add: noop,
    run: noop,
    prepare: noop,
    pendingKeys: {},
    managedCreations: {},
    resumeManagedRun: noop,
    cancelRun: () => {},
    retainedOperation: null,
    choiceRequired: null,
    dismissChoice: () => {},
    chooseForRun: noop,
    failure: null,
    approvalId: null,
    consent:
      frame === 'SETUP'
        ? { code: 'project_setup_consent_required', reviewedEffectDigest: 'd' }
        : null,
    dismissConsent: () => {},
    setupOperation: null,
    // A specimen never stops anything: the Stop control reads as idle.
    setupStop: { pending: false, feedback: null, failureCode: null, stopRequested: false,
      retryUnconfirmedStop: false, requestStop: () => {}, pendingApproval: null },
    setupReviewOpen: frame === 'SETUP',
    openSetupReview: () => {},
  };
}

function OutputFrame() {
  return <ActionOperationDetailModal serverId={SERVER} operationId="op-test" onClose={() => {}} />;
}

export function ScriptsSpecimen(
  props: Readonly<{ frame: string | null; phone: boolean }>,
) {
  const frame = props.frame ?? 'PAGE';
  React.useMemo(() => seedRuns(frame), [frame]);
  const declared = definition(MANIFEST);
  const inspection = {
    definition:
      frame === 'FIRST'
        ? { basis: { kind: 'absent' as const }, document: null }
        : frame === 'STATES'
          ? definition({
              ...MANIFEST,
              workspace: undefined,
              environment: undefined,
            })
          : declared,
    detection: DETECTION,
    importCandidates: [],
  };
  const body =
    frame === 'OUTPUT' ? (
      <OutputFrame />
    ) : frame === 'SHARED' ? (
      <ItemGroup>
        <ProjectSetupReview testID="scripts-specimen.shared" manifest={MANIFEST as never} machineName="build-01" sharedRunAs="ben"
          pending={false} onRun={() => {}} onNotNow={() => {}} onViewFile={() => {}} />
      </ItemGroup>
    ) : frame === 'RAIL' ? (
      <View style={styles.rail}>
        <ProjectScriptsContent workspace={WORKSPACE} inspection={inspection} controller={controller(frame)} page={false}
          testID="scripts-specimen" onEdit={null} onOpenServices={() => {}} onRetry={() => {}} />
      </View>
    ) : frame === 'EDIT' ? (
      <ProjectManifestEditor
        workspace={WORKSPACE}
        accountId="specimen"
        client={client}
        definition={declared}
        detection={DETECTION}
        importCandidates={[]}
        seedFromDetection={false}
        initialMode="form"
        onBack={() => {}}
        onSaved={() => {}}
      />
    ) : (
      <ProjectScriptsContent
        workspace={WORKSPACE}
        inspection={inspection}
        controller={controller(frame)}
        page
        testID="scripts-specimen"
        onEdit={() => {}}
        onOpenServices={() => {}}
        onRetry={() => {}}
      />
    );
  return (
    <View style={styles.root}>
      <View style={[styles.frame, props.phone ? styles.phone : null]}>
        <ItemList testID="scripts-specimen-list">{body}</ItemList>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: theme.colors.surface.base,
  },
  frame: { flex: 1, width: '100%', maxWidth: 1440 },
  phone: { maxWidth: 390 },
  rail: { width: 460, alignSelf: 'flex-end', paddingHorizontal: 12 },
}));
