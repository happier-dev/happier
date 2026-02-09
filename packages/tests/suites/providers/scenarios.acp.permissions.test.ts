import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  makeAcpPermissionDenyOutsideWorkspaceReadScenario,
  makeAcpPermissionDenyReadScenario,
  makeAcpPermissionExecuteWritesWorkspaceFileScenario,
  makeAcpPermissionOutsideWorkspaceScenario,
  makeAcpPermissionPatchApplyScenario,
} from '../../src/testkit/providers/scenarios.acp';

describe('providers: ACP scenario builders (permissions)', () => {
  it('can disable permission-request fixture requirements for providers that auto-approve edits', () => {
    const scenario = makeAcpPermissionOutsideWorkspaceScenario({
      providerId: 'codex',
      content: 'AUTO_APPROVED',
      decision: 'approve',
      expectPermissionRequest: false,
    });

    const buckets = scenario.requiredAnyFixtureKeys ?? [];
    const flattened = buckets.flat();
    const hasPermissionRequest = flattened.some((key) => key.includes('/permission-request/'));
    expect(hasPermissionRequest).toBe(false);
  });

  it('accepts execute fallback for outside-workspace approve scenarios without permission prompts', () => {
    const scenario = makeAcpPermissionOutsideWorkspaceScenario({
      providerId: 'kilo',
      content: 'AUTO_APPROVED',
      decision: 'approve',
      expectPermissionRequest: false,
    });

    const prompt = scenario.prompt?.({ workspaceDir: '/tmp/e2e-workspace' }) ?? '';
    expect(prompt.includes('Do not use execute')).toBe(false);

    const flat = (scenario.requiredAnyFixtureKeys ?? []).flat();
    expect(flat.some((key) => key.includes('/tool-call/Bash'))).toBe(true);
    expect(flat.some((key) => key.includes('/tool-result/Bash'))).toBe(true);
  });

  it('builds a permission deny scenario that expects a permission request and no file contents in tool trace', () => {
    const scenario = makeAcpPermissionDenyReadScenario({
      providerId: 'opencode',
      token: 'DENY_TOKEN',
    });

    expect(scenario.permissionAutoDecision).toBe('denied');
    const buckets = scenario.requiredAnyFixtureKeys ?? [];
    const flat = buckets.flat();
    expect(flat.some((key) => key.includes('/permission-request/'))).toBe(true);
  });

  it('builds a deny outside-workspace edit scenario that does not require tool-result fixtures', () => {
    const scenario = makeAcpPermissionOutsideWorkspaceScenario({
      providerId: 'opencode',
      content: 'DENY_OUTSIDE_WORKSPACE',
      decision: 'deny',
      expectPermissionRequest: true,
    });

    const buckets = scenario.requiredAnyFixtureKeys ?? [];
    const flat = buckets.flat();
    expect(flat.some((key) => key.includes('/permission-request/'))).toBe(true);
    expect(flat.some((key) => key.includes('/tool-call/'))).toBe(true);
    expect(flat.some((key) => key.includes('/tool-result/'))).toBe(false);
  });

  it('allows deny outside-workspace scenarios without permission requests', () => {
    const scenario = makeAcpPermissionOutsideWorkspaceScenario({
      providerId: 'opencode',
      content: 'DENY_WITHOUT_PROMPT',
      decision: 'deny',
      expectPermissionRequest: false,
    });

    expect(scenario.permissionAutoDecision).toBe('denied');
    const flat = (scenario.requiredAnyFixtureKeys ?? []).flat();
    expect(flat.some((key) => key.includes('/permission-request/'))).toBe(false);
    expect(flat.some((key) => key.includes('/tool-call/'))).toBe(false);
    expect(flat.some((key) => key.includes('/tool-result/'))).toBe(false);
  });

  it('accepts Kimi unknown permission-request payloads and extracts path from toolCall content', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'happier-acp-outside-kimi-'));
    const outsidePath = join(tmpdir(), `happier-kimi-outside-${Date.now()}.txt`);
    try {
      const scenario = makeAcpPermissionOutsideWorkspaceScenario({
        providerId: 'kimi',
        content: 'KIMI_OUTSIDE_OK',
        decision: 'approve',
        expectPermissionRequest: true,
        expectWriteCompletion: false,
      });

      await writeFile(outsidePath, 'KIMI_OUTSIDE_OK\n', 'utf8');

      await scenario.verify?.({
        workspaceDir,
        fixtures: {
          examples: {
            'acp/kimi/permission-request/unknown': [
              {
                payload: {
                  options: {
                    toolCall: {
                      content: [{ path: outsidePath, type: 'diff' }],
                    },
                  },
                },
              },
            ],
          },
        } as any,
      });
    } finally {
      await rm(outsidePath, { force: true });
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('builds a permission deny outside-workspace read scenario', () => {
    const scenario = makeAcpPermissionDenyOutsideWorkspaceReadScenario({
      providerId: 'opencode',
      token: 'DENY_OUTSIDE_TOKEN',
    });

    expect(scenario.permissionAutoDecision).toBe('denied');
    const buckets = scenario.requiredAnyFixtureKeys ?? [];
    const flat = buckets.flat();
    expect(flat.some((key) => key.includes('/permission-request/'))).toBe(true);
    expect(flat.some((key) => key.includes('/Read'))).toBe(true);
  });

  it('builds an execute permission scenario that asserts permission-request trace + workspace file side effect (approve)', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'happier-acp-execperm-'));
    try {
      const scenario = makeAcpPermissionExecuteWritesWorkspaceFileScenario({
        providerId: 'codex',
        filename: 'e2e-exec-perm.txt',
        content: 'EXEC_PERM_OK',
        decision: 'approve',
      });

      expect(scenario.yolo).toBe(false);
      expect(scenario.permissionAutoDecision).toBe('approved');
      await writeFile(join(workspaceDir, 'e2e-exec-perm.txt'), 'EXEC_PERM_OK\n', 'utf8');

      await scenario.verify?.({
        workspaceDir,
        traceEvents: [{ payload: { type: 'permission-request' } }],
      });
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('builds an execute permission scenario that asserts permission-request trace + no workspace file side effect (deny)', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'happier-acp-execperm-'));
    try {
      const scenario = makeAcpPermissionExecuteWritesWorkspaceFileScenario({
        providerId: 'codex',
        filename: 'e2e-exec-perm.txt',
        content: 'EXEC_PERM_NO',
        decision: 'deny',
      });

      expect(scenario.yolo).toBe(false);
      expect(scenario.permissionAutoDecision).toBe('denied');

      await scenario.verify?.({
        workspaceDir,
        traceEvents: [{ payload: { type: 'permission-request' } }],
      });
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('builds a patch-apply permission scenario that asserts permission-request trace + file content update (approve)', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'happier-acp-patchperm-'));
    try {
      const scenario = makeAcpPermissionPatchApplyScenario({
        providerId: 'codex',
        filename: 'e2e-patch-perm.txt',
        before: 'PATCH_BEFORE',
        after: 'PATCH_AFTER',
        decision: 'approve',
      });

      await scenario.setup?.({ workspaceDir });
      await writeFile(join(workspaceDir, 'e2e-patch-perm.txt'), 'PATCH_AFTER\n', 'utf8');

      await scenario.verify?.({
        workspaceDir,
        traceEvents: [{ payload: { type: 'permission-request' } }],
      });
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('builds a patch-apply permission scenario that asserts permission-request trace + file content unchanged (deny)', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'happier-acp-patchperm-'));
    try {
      const scenario = makeAcpPermissionPatchApplyScenario({
        providerId: 'codex',
        filename: 'e2e-patch-perm.txt',
        before: 'PATCH_BEFORE',
        after: 'PATCH_AFTER',
        decision: 'deny',
      });

      await scenario.setup?.({ workspaceDir });
      await scenario.verify?.({
        workspaceDir,
        traceEvents: [{ payload: { type: 'permission-request' } }],
      });
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('builds a patch-apply scenario without permission-request requirements when prompts are disabled', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'happier-acp-patchperm-noprompt-'));
    try {
      const scenario = makeAcpPermissionPatchApplyScenario({
        providerId: 'codex',
        filename: 'e2e-patch-perm.txt',
        before: 'PATCH_BEFORE',
        after: 'PATCH_AFTER',
        decision: 'approve',
        expectPermissionRequest: false,
      });

      await scenario.setup?.({ workspaceDir });
      await writeFile(join(workspaceDir, 'e2e-patch-perm.txt'), 'PATCH_AFTER\n', 'utf8');
      expect((scenario.requiredTraceSubstrings ?? []).some((value) => value.includes('permission-request'))).toBe(false);

      await scenario.verify?.({
        workspaceDir,
        traceEvents: [],
      });
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
