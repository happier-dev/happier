import { describe, expect, it } from 'vitest';
import { normalizeRawMessage } from './normalize';
import { formatPermissionRequestSummary } from '@/components/tools/normalization/policy/permissionSummary';

describe('typesRaw.normalizeRawMessage (permission-request)', () => {
  it('uses description as a permission title when options are missing', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'acp',
        provider: 'codex',
        data: {
          type: 'permission-request',
          permissionId: 'perm_1',
          toolName: 'Bash',
          description: 'Run: echo hello',
        },
      },
      meta: { source: 'cli' },
    };

    const normalized = normalizeRawMessage('msg_perm_1', null, 1000, raw);
    expect(normalized).not.toBeNull();

    const toolCall = (normalized as any)?.content?.[0];
    expect(toolCall?.type).toBe('tool-call');
    expect(toolCall?.name).toBe('Bash');

    const summary = formatPermissionRequestSummary({ toolName: toolCall.name, toolInput: toolCall.input });
    expect(summary).toBe('Run: echo hello');
  });
});
