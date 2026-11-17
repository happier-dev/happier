import { randomUUID } from 'node:crypto';
import { mkdir, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import React from 'react';
import { Alert } from 'react-native';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import { AuthProvider } from '../../../../apps/ui/sources/auth/context/AuthContext';
import { TokenStorage } from '../../../../apps/ui/sources/auth/storage/tokenStorage';
import { renderScreen } from '../../../../apps/ui/sources/dev/testkit';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { db, initDbPostgres, shutdownDbClient } from '../../../../apps/server/sources/storage/db';
import { inTx } from '../../../../apps/server/sources/storage/inTx';
import { initFilesLocalFromEnv, loadFiles } from '../../../../apps/server/sources/storage/blob/files';
import { discussionAttachmentWritingUploadPrefix, discussionAttachmentRejectedUploadPrefix,
  writeAccountPrivateFileCandidate, settleAccountPrivateFileUploadInTx } from '../../../../apps/server/sources/storage/privateFiles/accountPrivateFileCustody';
import { applyEnvOverrides } from '../testkit/env';
import type { TeamSetupFFixture } from '../testkit/teamSetupF';

/** J6: a real captured upload, real erasure HTTP/Action routes and real disk IO.
 * The producer deliberately remains between capture and settle, as after an
 * interrupted upload; the erasure owner and its status decision are never stubbed. */
export async function runAccountErasureJourney(fixture: TeamSetupFFixture, databaseUrl: string) {
  const server = fixture.server;
  const restoreEnv = applyEnvOverrides({ HAPPIER_DB_PROVIDER: 'postgres', HAPPY_DB_PROVIDER: 'postgres',
    DATABASE_URL: databaseUrl,
    HAPPIER_SERVER_LIGHT_DATA_DIR: server.dataDir,
    HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR: join(server.dataDir, 'private-files'),
    HAPPIER_SERVER_LIGHT_FILES_DIR: join(server.dataDir, 'files') });
  try {
    initDbPostgres();
    await db.$connect();
    initFilesLocalFromEnv();
    await loadFiles();
    const administrator = await fixture.createAccount('erasure-administrator');
    expect((await fixture.claimHomeOwner(administrator)).result.status).toBe('claimed');
    const administratorId = readAccountIdFromToken(administrator.auth.token);
    if (!administratorId) throw new Error('Home owner token omitted its Account ID');
    const removeByAdministrator = (accountId: string) => administrator.execute('home.accounts.delete', { accountId },
      { presentUserConfirmation: { actionId: 'home.accounts.delete' } });

    const removeSelf = async (account: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>) => {
      const accountId = readAccountIdFromToken(account.auth.token);
      if (!accountId) throw new Error('Self-erasure token omitted its Account ID');
      const ui = await connectUiPersonActionClient({ serverUrl: fixture.actionServerApiUrl,
        accountSecret: account.auth.accountSigningSeed });
      let mounted: Awaited<ReturnType<typeof renderScreen>> | undefined;
      // The native alert renderer is an OS boundary; this person acknowledges
      // the informational completion alert after the real lifecycle settles.
      const alert = vi.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
        buttons?.[0]?.onPress?.();
      });
      try {
        const before = await TokenStorage.getCredentialsForServerUrl(server.baseUrl, { serverId: ui.serverId });
        if (!before) throw new Error('Signed-in Account omitted its real UI credentials');
        mounted = await renderScreen(React.createElement(AuthProvider, { initialCredentials: before, children: null }));
        const result = await ui.executeConfirmed('account.delete', { serverId: ui.serverId, accountId },
          { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: ui.serverId, serverIdentityId: fixture.serverId, actionRequestId: randomUUID() });
        const after = await TokenStorage.getCredentialsForServerUrl(server.baseUrl, { serverId: ui.serverId });
        return { result, before, after };
      } finally {
        alert.mockRestore();
        try { await mounted?.unmount(); }
        finally { await ui.close(); }
      }
    };

    const self = await fixture.createAccount('erasure-self-success');
    const selfId = readAccountIdFromToken(self.auth.token);
    if (!selfId) throw new Error('Successful self-erasure token omitted its Account ID');
    const deleted = await removeSelf(self);
    expect(deleted.result, JSON.stringify(deleted.result)).toMatchObject({ ok: true, result: { status: 'deleted' } });
    expect(deleted.after, 'Completed erasure must remove local Account credentials').toBeNull();
    expect(await db.account.findUnique({ where: { id: selfId } })).toBeNull();
    console.info('[account-erasure-journey] self-erasure control completed');

    const administratorTarget = await fixture.createAccount('erasure-home-administrator-success');
    const administratorTargetId = readAccountIdFromToken(administratorTarget.auth.token);
    if (!administratorTargetId) throw new Error('Home erasure control token omitted its Account ID');
    expect(await removeByAdministrator(administratorTargetId), 'Home owner control completes physical erasure')
      .toMatchObject({ ok: true, result: { status: 'deleted' } });
    expect(await db.account.findUnique({ where: { id: administratorTargetId } })).toBeNull();
    console.info('[account-erasure-journey] Home-administrator control completed');

    for (const ingress of ['self', 'home-administrator'] as const) {
      const account = await fixture.createAccount(`erasure-${ingress}`);
      const accountId = readAccountIdFromToken(account.auth.token);
      if (!accountId) throw new Error('Erasure fixture token omitted its Account ID');
      const machine = await fixture.enrollDaemon(account);
      await fixture.assertKnownGoodMachineControl(account, machine);
      expect(await account.execute('machines.command.run', { command: 'echo erasure-control' }, {
        presentUserConfirmation: { actionId: 'machines.command.run' },
        externalActionTarget: { kind: 'machine', machineId: machine.target.machineId,
          project: { machineId: machine.target.machineId, directory: machine.workspaceDir } },
      })).toMatchObject({ ok: true, result: { exitCode: 0, stdout: expect.stringContaining('erasure-control') } });
      console.info(`[account-erasure-journey] ${ingress} daemon command control completed`);
      const before = await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { status: true, tokenEpoch: true } });
      const blobId = randomUUID();
      const path = `discussions/${blobId}/interrupted-upload`;
      const writingReuseKey = `${discussionAttachmentWritingUploadPrefix}${blobId}`;
      const rejectedReuseKey = `${discussionAttachmentRejectedUploadPrefix}${blobId}`;
      await writeAccountPrivateFileCandidate({ accountId, path, bytes: new Uint8Array([1, 2, 3]), writingReuseKey, rejectedReuseKey });
      if (ingress === 'self') {
        const refused = await removeSelf(account);
        expect(refused.result, 'Pending upload must remain a typed refusal at the real UI lifecycle Action result')
          .toMatchObject({ ok: false, errorCode: 'account_erasure_upload_pending' });
        expect(refused.after, 'A retryable refusal must retain the signed-in Account credentials').toEqual(refused.before);
      } else {
        expect(await removeByAdministrator(accountId), 'Home Action must preserve the pre-retirement cause')
          .toMatchObject({ ok: false, errorCode: 'account_erasure_upload_pending' });
      }
      expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { status: true, tokenEpoch: true } }))
        .toEqual(before);
      console.info(`[account-erasure-journey] ${ingress} pending-upload refusal preserved active credentials`);
      await fixture.assertKnownGoodMachineControl(account, machine);
      expect(await inTx(tx => settleAccountPrivateFileUploadInTx(tx, { accountId, file: { path }, writingReuseKey,
        reuseKey: rejectedReuseKey }))).toBe('settled');

      // A directory at the exact captured locator produces a genuine local
      // filesystem refusal, after retirement; no result or storage mock is used.
      const physicalPath = join(server.dataDir, 'private-files', path);
      await unlink(physicalPath);
      await mkdir(physicalPath);
      const selfPartial = ingress === 'self' ? await removeSelf(account) : null;
      const partial = selfPartial ? selfPartial.result : await removeByAdministrator(accountId);
      expect(partial, 'A post-retirement IO failure must explicitly report partial completion')
        .toMatchObject({ ok: true, result: { status: 'disabled_pending_completion' } });
      if (selfPartial) expect(selfPartial.after, 'Committed retirement must remove local Account credentials').toBeNull();
      const retired = await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { status: true, tokenEpoch: true } });
      expect(retired.status).toBe('disabled');
      expect(retired.tokenEpoch).toBeGreaterThan(before.tokenEpoch);
      const staleAccess = await fetch(`${fixture.server.baseUrl}/v1/account/settings`, {
        headers: { Authorization: `Bearer ${account.auth.token}` },
      });
      expect(staleAccess.status, 'Retirement must revoke the original Account bearer').toBe(401);
      console.info(`[account-erasure-journey] ${ingress} partial erasure retired credentials`);
      await rmdir(physicalPath);
      await writeFile(physicalPath, new Uint8Array([1, 2, 3]));
      expect(await removeByAdministrator(accountId), 'Home owner finishes physical erasure after fixing storage')
        .toMatchObject({ ok: true, result: { status: 'deleted' } });
      expect(await db.account.findUnique({ where: { id: accountId } })).toBeNull();
      await expect(stat(physicalPath), 'Completed erasure must remove the captured private bytes').rejects.toMatchObject({ code: 'ENOENT' });
    }

    expect(await db.account.findUniqueOrThrow({ where: { id: administratorId }, select: { status: true } }))
      .toEqual({ status: 'active' });
  } finally {
    try { await shutdownDbClient(); } finally { restoreEnv(); }
  }
}
