import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
import { MACHINE_TERMINAL_PACKAGE_SCRIPT_CHILD_V1 } from '@happier-dev/protocol/actions/specs/machineTerminalActionIdsV1';
import { afterEach, expect, it, vi } from 'vitest';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { acceptedProjectSetupPath, createHarness, resetFilesystemApprovalSocketBoundary } from './executeExternalAction.filesystemApprovals.testkit';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetFilesystemApprovalSocketBoundary();
  withdrawActiveProjectAccountRowsSnapshot();
});

const terminalOpen = 'machines.terminal.open';

async function finishSetupBeforeTerminal<T>(h: Awaited<ReturnType<typeof createHarness>>, opening: Promise<T>): Promise<T> {
  const setup = await Promise.race([h.waitForSpawn(0), opening.then(() => null)]);
  setup?.exit(0);
  return await opening;
}

it('runs the reviewed package script under the terminal open approval, with no second approval', async () => {
  resetServerFeaturesClientForTests();
  const h = await createHarness(terminalOpen, 'ask', false, undefined, undefined, false, false,
    { authentication: 'account', acceptedProjectSetup: true, allowedActionIds: [PROJECT_PREPARE_ACTION_ID_V1] });
  try {
    await writeFile(join(h.rootPath, 'package.json'), JSON.stringify({ name: 'pkg', scripts: { dev: 'vite' } }));
    expect(await h.runOriginalCli({ serverId: 'srv_n2', machineId: 'machine', terminalKey: 'pkg-dev', cwd: h.rootPath,
      launch: { kind: 'package_script', runTargetId: 'pkg:dev' } }, terminalOpen))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(h.spawned).toHaveLength(0);
    const approvalNetworkStart = h.networkPaths.length;
    const decided = await finishSetupBeforeTerminal(h, h.decide('approve'));
    expect(decided, JSON.stringify({ decided, outcomes: h.rpcOutcomes, finite: h.finiteIngress })).toMatchObject({
      ok: true, result: { status: 'executed', execution: { ok: true, result: { terminalId: expect.any(String) } } } });
    expect(h.spawned).toHaveLength(2);
    expect(h.networkPaths.slice(approvalNetworkStart)).toContain(`GET ${acceptedProjectSetupPath}`);
  } finally { await h.close(); }
});

it('runs a present person package-script terminal from the app after one in-place review that names the script', async () => {
  resetServerFeaturesClientForTests();
  const h = await createHarness(terminalOpen, 'default', false, undefined, undefined, false, false,
    { authentication: 'account', acceptedProjectSetup: true, allowedActionIds: [PROJECT_PREPARE_ACTION_ID_V1] });
  try {
    await writeFile(join(h.rootPath, 'package.json'), JSON.stringify({ name: 'pkg', scripts: { dev: 'vite' } }));
    const input = { serverId: 'srv_n2', machineId: 'machine', terminalKey: 'pkg-dev-ui', cwd: h.rootPath,
      launch: { kind: 'package_script', runTargetId: 'pkg:dev' } };
    // The app's one in-place review names the script child; nothing runs before it.
    const review = await h.run(input, 'ui', false, 'present_user');
    expect(review).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required', details: { review: { preview: {
      hostReviewedChildren: { children: [MACHINE_TERMINAL_PACKAGE_SCRIPT_CHILD_V1] } } } } });
    expect(h.spawned).toHaveLength(0);
    const reviewDigest = !review.ok && typeof review.details === 'object' && review.details && 'reviewDigest' in review.details
      && typeof review.details.reviewDigest === 'string' ? review.details.reviewDigest : undefined;
    const confirmationNetworkStart = h.networkPaths.length;
    const opened = await finishSetupBeforeTerminal(h,
      h.run(input, 'ui', false, 'present_user', terminalOpen, 'confirmed-request', undefined, reviewDigest));
    expect(opened, JSON.stringify({ opened, outcomes: h.rpcOutcomes })).toMatchObject({ ok: true, result: { terminalId: expect.any(String) } });
    expect(h.spawned).toHaveLength(2);
    expect(h.networkPaths.slice(confirmationNetworkStart)).toContain(`GET ${acceptedProjectSetupPath}`);
  } finally { await h.close(); }
});

it('runs an Allowed package-script terminal from an external MCP agent with no prompt, as its requester', async () => {
  resetServerFeaturesClientForTests();
  const h = await createHarness(terminalOpen, 'default', false, undefined, undefined, false, false,
    { authentication: 'account', acceptedProjectSetup: true,
      allowedActionIds: [terminalOpen, MACHINE_TERMINAL_PACKAGE_SCRIPT_CHILD_V1.action, PROJECT_PREPARE_ACTION_ID_V1] });
  try {
    await writeFile(join(h.rootPath, 'package.json'), JSON.stringify({ name: 'pkg', scripts: { dev: 'vite' } }));
    const opened = await finishSetupBeforeTerminal(h,
      h.runSavedProfileMcp({ serverId: 'srv_n2', machineId: 'machine', terminalKey: 'pkg-dev-allowed',
        cwd: h.rootPath, launch: { kind: 'package_script', runTargetId: 'pkg:dev' } }, terminalOpen, true));
    expect(opened, JSON.stringify({ opened, outcomes: h.rpcOutcomes })).toMatchObject({ terminalId: expect.any(String) });
    expect(h.hasApproval()).toBe(false);
    expect(h.spawned).toHaveLength(2);
    expect(h.networkPaths).toContain(`GET ${acceptedProjectSetupPath}`);
    // The terminal belongs to the admitted requester Account, not to an anonymous daemon caller.
    const terminalId = opened && typeof opened === 'object' && 'terminalId' in opened ? String(opened.terminalId) : '';
    expect(await h.readTerminalAs(terminalId, 'account')).toMatchObject({ ok: true });
    expect(await h.readTerminalAs(terminalId, 'another-account')).toMatchObject({ ok: false, code: 'terminal_forbidden' });
  } finally { await h.close(); }
});
