import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createSessionHandoffSourceExportStore } from '@/session/handoff/state/sessionHandoffSourceExportStore';
import { createSessionHandoffPrepareTargetJobStore } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import type { MemberSessionHandoffImport } from '@/session/handoff/agentBundle/memberImport';
import { createSessionHandoffPrepareTargetActionHandler } from './prepareTarget';

// HANDOFF-MEMBER-CAPTURE-1114 V2 (owner ruling 2026-11-15): a requester without Manage
// on a separate-users Machine gets the Session import and its cwd from a member process,
// inside their own member folder. The member process is the OS identity boundary here;
// admission, the prepare job and its stores stay real.
it('imports a Can use handoff through the member, inside the member folder, and refuses any other path', async () => {
  const activeServerDir = await mkdtemp(
    join(tmpdir(), 'handoff-member-import-'),
  );
  const activePrepareJobs = new Map<string, Promise<void>>();
  try {
    const memberRoot = join(activeServerDir, 'members', 'member-a');
    await mkdir(memberRoot, { recursive: true });
    const sourceExportStore = createSessionHandoffSourceExportStore({
      activeServerDir,
    });
    for (const handoffId of ['outside', 'inside']) {
      const agentBundle = await sourceExportStore.writeAgentBundleFile({
        handoffId,
        agentBundle: {
          agentId: 'claude',
          remoteSessionId: 'native',
          transcriptBase64: 'e30K',
        },
      });
      await sourceExportStore.save({ handoffId, exportedAtMs: 1, agentBundle });
    }
    const prepareJobStore = createSessionHandoffPrepareTargetJobStore({
      activeServerDir,
    });
    const hostImport = vi.fn(async () => {
      throw new Error('The host must not import a Can use handoff');
    });
    const memberImports: Array<
      Parameters<MemberSessionHandoffImport['import']>[0]
    > = [];
    const memberImport: MemberSessionHandoffImport = {
      workspaceRoot: memberRoot,
      import: async (input) => {
        memberImports.push(input);
        return {
          remoteSessionId: 'native',
          directSource: {
            kind: 'claudeConfig',
            configDir: null,
            projectId: null,
          },
          resume: {
            directory: input.targetPath,
            agent: 'claude',
            agentTarget: {
              kind: 'agent',
              identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
            },
            resume: 'native',
            transcriptStorage: 'persisted',
            approvedNewDirectoryCreation: true,
          },
        };
      },
    };
    const handler = createSessionHandoffPrepareTargetActionHandler({
      prepareJobStore,
      sourceExportStore,
      activePrepareJobs,
      prepareTargetJobLeaseOwnerId: 'member-import-test',
      runtimeConfig: { activeServerDir },
      machineTransferChannel: undefined,
      directPeerTransfer: {
        publishTransfer: () => [],
        clearPublishedTransfer: () => undefined,
        requestPayloadFile: async () => {
          throw new Error('The local source export carries the bundle');
        },
      },
      importSessionBundle: hostImport,
      prepareMemberImport: async () => memberImport,
    });
    const request = (handoffId: string, targetPath: string) => ({
      handoffId,
      sourceMachineId: 'source',
      targetMachineId: 'source',
      sourceSessionStorageMode: 'persisted' as const,
      negotiatedTransportStrategy: 'direct_peer' as const,
      targetPath,
    });
    const context = { signal: new AbortController().signal };

    expect(
      await handler.handle(request('outside', '/srv/host/.ssh'), context),
    ).toMatchObject({ ok: false, errorCode: 'workspace_private_checkout_review_required' });
    expect(await prepareJobStore.read('prepare_outside')).toBeNull();

    const targetPath = join(memberRoot, 'workspace');
    await handler.handle(request('inside', targetPath), context);
    await Promise.all(activePrepareJobs.values());
    const job = await prepareJobStore.read('prepare_inside');
    expect(job?.lastErrorMessage).toBeUndefined();
    expect(hostImport).not.toHaveBeenCalled();
    expect(memberImports).toEqual([
      expect.objectContaining({
        targetPath,
        sessionStorageMode: 'persisted',
        bundle: expect.objectContaining({ agentId: 'claude' }),
      }),
    ]);
  } finally {
    await Promise.all(activePrepareJobs.values());
    await rm(activeServerDir, { recursive: true, force: true });
  }
});
