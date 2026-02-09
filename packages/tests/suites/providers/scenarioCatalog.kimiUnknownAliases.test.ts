import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { scenarioCatalog } from '../../src/testkit/providers/scenarioCatalog';

describe('providers: kimi scenario fixture aliasing', () => {
  const kimiProvider = {
    id: 'kimi',
    protocol: 'acp',
    traceProvider: 'kimi',
  } as any;

  it('allows Read/unknown aliases for read_known_file fixture requirements', () => {
    const scenario = scenarioCatalog.read_known_file(kimiProvider);
    expect(scenario.requiredFixtureKeys ?? []).toEqual([]);
    const flat = (scenario.requiredAnyFixtureKeys ?? []).flat();
    expect(flat).toContain('acp/kimi/tool-call/Read');
    expect(flat).toContain('acp/kimi/tool-call/unknown');
    expect(flat).toContain('acp/kimi/tool-result/Read');
    expect(flat).toContain('acp/kimi/tool-result/unknown');
  });

  it('adds unknown tool aliases inside requiredAny fixture buckets', () => {
    const scenario = scenarioCatalog.search_known_token(kimiProvider);
    const flat = (scenario.requiredAnyFixtureKeys ?? []).flat();
    expect(flat).toContain('acp/kimi/tool-call/CodeSearch');
    expect(flat).toContain('acp/kimi/tool-call/unknown');
    expect(flat).toContain('acp/kimi/tool-result/CodeSearch');
    expect(flat).toContain('acp/kimi/tool-result/unknown');
  });

  it('uses a workspace-relative read path for read_known_file prompts', () => {
    const scenario = scenarioCatalog.read_known_file(kimiProvider);
    const workspaceDir = '/tmp/happier-kimi-read';
    const prompt = scenario.prompt?.({ workspaceDir }) ?? '';
    expect(prompt).toContain('- Use the read tool to read: e2e-read.txt');
    expect(prompt).not.toContain(join(workspaceDir, 'e2e-read.txt'));
    expect(prompt).not.toContain('cat "');
  });

  it('uses absolute path + execute fallback for read_missing_file_in_workspace prompts', () => {
    const scenario = scenarioCatalog.read_missing_file_in_workspace(kimiProvider);
    const workspaceDir = '/tmp/happier-kimi-read-missing';
    const prompt = scenario.prompt?.({ workspaceDir }) ?? '';
    const missingPath = join(workspaceDir, 'e2e-missing.txt');
    expect(prompt).toContain(`- Use the read tool to read a file that does NOT exist: ${missingPath}`);
    expect(prompt).toContain(`cat "${missingPath}"`);
  });

  it('adds unknown permission-request alias for permission mode outside-workspace scenario', () => {
    const scenario = scenarioCatalog.permission_mode_default_outside_workspace(kimiProvider);
    const flat = (scenario.requiredAnyFixtureKeys ?? []).flat();
    expect(flat).toContain('acp/kimi/permission-request/Write');
    expect(flat).toContain('acp/kimi/permission-request/unknown');
  });
});
