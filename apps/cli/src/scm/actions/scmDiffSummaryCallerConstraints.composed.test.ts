import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createActionExecutor,
  buildBackendTargetKeyV2,
  type ActionExecutorDeps,
  type ActionExecutorContext,
} from '@happier-dev/protocol';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol/scm/diffSummary';

import { runWithScmAccountScope } from '@/scm/accountScope';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { removeTempDir } from '@/testkit/fs/tempDir';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { captureScmComparison } from '@/scm/comparisons/captureScmComparison';
import { executeScmActionOperation } from './executeScmActionOperation';

const BACKEND_TARGET = {
  kind: 'backend' as const,
  backendId: 'codex',
  sourceKind: 'built_in' as const,
};
const AGENT_TARGET_KEY = buildBackendTargetKeyV2(BACKEND_TARGET);
const SAVED_TEAM_GENERATOR = {
  source: 'team_resource' as const,
  agentTargetKey: AGENT_TARGET_KEY,
  modelId: 'team-model',
  resourceId: 'saved-resource',
  teamId: 'saved-team',
  expectedResourceRevision: 3,
  deliveryMode: 'brokered' as const,
};

afterEach(() => vi.restoreAllMocks());

describe('restricted API-token constraints on nested Run starts', () => {
  it('refuses a saved Team generator started by a nested Action before any Run reaches the host', async () =>
    runWithScmAccountScope('scm-caller-constraints-test', async () => {
      const repository = createLocalScmRepositoryFixture({
        executable: 'git',
        repoMode: '.git',
        prefix: 'happier-summary-constraints-',
      });
      const cwd = repository.rootPath;
      try {
        await writeFile(join(cwd, repository.trackedPath), 'Captured change\n');
        const captured = await captureScmComparison({
          cwd,
          source: { kind: 'workingTree' },
        });
        const changeRefs = captured.comparison.inventory.files.flatMap((file) =>
          file.occurrences.map((occurrence) => occurrence.id),
        );
        // The saved result's generator is the Team ref a person chose earlier, not caller input.
        const saved = await scmDiffSummaryResultStore.create({
          cwd,
          output: ScmDiffSummaryGenerateOutputSchema.parse({
            success: true,
            sourceKey: captured.comparison.id,
            comparison: captured.comparison,
            metadata: captured.metadata,
            requestedOutputs: ['summary'],
            outputs: {
              summary: {
                state: 'complete',
                value: { summaryMarkdown: 'Saved explanation' },
              },
            },
            analysis: {
              suppliedChangeRefs: changeRefs,
              analysedChangeRefs: changeRefs,
              remainingChangeRefs: [],
            },
          }),
          generator: {
            backendTarget: BACKEND_TARGET,
            modelSelection: SAVED_TEAM_GENERATOR,
          },
        });

        // The host transport is the boundary: any call here means a Run reached a daemon.
        const executionRunStart = vi.fn(async () => ({
          runId: 'unexpected-run',
          callId: 'call',
          sidechainId: 'sidechain',
        }));
        const executor = createActionExecutor({
          scmActionExecute: ({
            actionId,
            input,
            context,
            executeCanonicalAction,
          }) =>
            executeScmActionOperation({
              actionId,
              input,
              actionContext: context,
              executeCanonicalAction,
              workingDirectory: cwd,
              accessPolicy: { kind: 'restrictedRoots', roots: [cwd] },
            }),
          executionRunCheckProtocolV2: async () => ({ ok: true }),
          executionRunStart,
          isActionEnabled: () => true,
        } as ActionExecutorDeps);
        // The token's model allowlist names one native model and no Team ref.
        const restricted: ActionExecutorContext = {
          surface: 'api',
          authority: 'account_automation',
          externalActionTarget: {
            kind: 'machine',
            machineId: 'constraints-machine',
          },
          externalActionCredential: {
            accountId: 'account',
            principalId: 'principal',
            credentialId: 'credential',
            grant: {
              ...API_TOKEN_FULL_GRANT_V1,
              models: [
                {
                  agentTargetKey: AGENT_TARGET_KEY,
                  providerConnectionId: null,
                  modelId: 'allowed-model',
                },
              ],
            },
          },
        };

        const discussed = await executor.execute(
          'scm.diffSummary.discuss',
          {
            cwd,
            resultId: saved.resultId,
            expectedRevision: saved.revision,
            message: 'Walk me through this',
            startNew: true,
          },
          restricted,
        );
        expect(discussed).toMatchObject({
          ok: true,
          result: { success: false, errorCode: 'admission_failed' },
        });

        // The same Team ref authored directly is refused with the typed constraint code.
        const direct = await executor.execute(
          'execution.run.start',
          {
            sessionId: null,
            machineId: 'constraints-machine',
            cwd,
            intent: 'delegate',
            backendTarget: BACKEND_TARGET,
            instructions: 'Explain',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
            teamCredentialModel: {
              kind: 'team_credential_provider_model',
              agentTargetKey: AGENT_TARGET_KEY,
              modelId: 'team-model',
              resourceId: 'saved-resource',
              teamId: 'saved-team',
              expectedResourceRevision: 3,
              deliveryMode: 'brokered',
            },
          },
          restricted,
        );
        expect(direct).toMatchObject({
          ok: false,
          errorCode: 'model_not_granted',
          details: { executionRunStart: { runCreation: 'noRunCreated' } },
        });
        expect(executionRunStart).not.toHaveBeenCalled();
      } finally {
        removeTempDir(repository.rootPath);
      }
    }));
});
