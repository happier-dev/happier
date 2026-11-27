import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createHarness, resetFilesystemApprovalSocketBoundary } from './executeExternalAction.filesystemApprovals.testkit';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetFilesystemApprovalSocketBoundary();
  withdrawActiveProjectAccountRowsSnapshot();
});

it('runs the reviewed package script under the terminal open approval, with no second approval', async () => {
  resetServerFeaturesClientForTests();
  const h = await createHarness('machines.terminal.open', 'ask');
  try {
    await writeFile(join(h.rootPath, 'package.json'), JSON.stringify({ name: 'pkg', scripts: { dev: 'vite' } }));
    expect(await h.runOriginalCli({ serverId: 'srv_n2', machineId: 'machine', terminalKey: 'pkg-dev', cwd: h.rootPath,
      launch: { kind: 'package_script', runTargetId: 'pkg:dev' } }, 'machines.terminal.open'))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(h.spawned).toHaveLength(0);
    const decided = await h.decide('approve');
    expect(decided, JSON.stringify({ decided, outcomes: h.rpcOutcomes, finite: h.finiteIngress })).toMatchObject({
      ok: true, result: { status: 'executed', execution: { ok: true, result: { terminalId: expect.any(String) } } } });
    expect(h.spawned).toHaveLength(1);
  } finally { await h.close(); }
});

it('runs a present person package-script terminal from the app after one in-place review that names the script', async () => {
  resetServerFeaturesClientForTests();
  const h = await createHarness('machines.terminal.open', 'default');
  try {
    await writeFile(join(h.rootPath, 'package.json'), JSON.stringify({ name: 'pkg', scripts: { dev: 'vite' } }));
    const input = { serverId: 'srv_n2', machineId: 'machine', terminalKey: 'pkg-dev-ui', cwd: h.rootPath,
      launch: { kind: 'package_script', runTargetId: 'pkg:dev' } };
    // The app's one in-place review names the script child; nothing runs before it.
    const review = await h.run(input, 'ui', false, 'present_user');
    expect(review).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required', details: { review: { preview: {
      hostReviewedChildren: { children: [{ action: 'projects.script.run', role: 'package_script' }] } } } } });
    expect(h.spawned).toHaveLength(0);
    const reviewDigest = !review.ok && typeof review.details === 'object' && review.details && 'reviewDigest' in review.details
      && typeof review.details.reviewDigest === 'string' ? review.details.reviewDigest : undefined;
    const opened = await h.run(input, 'ui', false, 'present_user', 'machines.terminal.open', 'confirmed-request', undefined, reviewDigest);
    expect(opened, JSON.stringify({ opened, outcomes: h.rpcOutcomes })).toMatchObject({ ok: true, result: { terminalId: expect.any(String) } });
    expect(h.spawned).toHaveLength(1);
  } finally { await h.close(); }
});

it('runs an Allowed package-script terminal from an external MCP agent with no prompt, as its requester', async () => {
  resetServerFeaturesClientForTests();
  const h = await createHarness('machines.terminal.open', 'default', false, undefined, undefined, false, false,
    { authentication: 'account', allowedActionIds: ['machines.terminal.open', 'projects.script.run'] });
  try {
    await writeFile(join(h.rootPath, 'package.json'), JSON.stringify({ name: 'pkg', scripts: { dev: 'vite' } }));
    const opened = await h.runSavedProfileMcp({ serverId: 'srv_n2', machineId: 'machine', terminalKey: 'pkg-dev-allowed',
      cwd: h.rootPath, launch: { kind: 'package_script', runTargetId: 'pkg:dev' } }, 'machines.terminal.open', true);
    expect(opened, JSON.stringify({ opened, outcomes: h.rpcOutcomes })).toMatchObject({ terminalId: expect.any(String) });
    expect(h.hasApproval()).toBe(false);
    expect(h.spawned).toHaveLength(1);
    // The terminal belongs to the admitted requester Account, not to an anonymous daemon caller.
    const terminalId = opened && typeof opened === 'object' && 'terminalId' in opened ? String(opened.terminalId) : '';
    expect(await h.readTerminalAs(terminalId, 'account')).toMatchObject({ ok: true });
    expect(await h.readTerminalAs(terminalId, 'another-account')).toMatchObject({ ok: false, code: 'terminal_forbidden' });
  } finally { await h.close(); }
});
