import { describe, expect, it } from 'vitest';
import { createMcpPermissionChoices } from '@/mcp/runtime/mcpPermissionChoices';
import type { ResolvedMcpToolIdentityV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { resolveNativePermissionImmediateDecision } from './nativePermissionChoice';

const mcpTool: ResolvedMcpToolIdentityV1 = { server: 'a', tool: 'echo', serverTitle: 'A',
    item: { serverId: 'a' }, decision: { approval: 'allow', exposed: true, source: 'tool', effectClass: 'unknown' } };

describe('automatic native permission decisions', () => {
    it.each(['approved', 'approved_for_session'] as const)('applies host %s through its exact offered response', decision => {
        const offered = createMcpPermissionChoices('contract', null);
        expect(resolveNativePermissionImmediateDecision({ decision }, offered, mcpTool)).toEqual({ decision,
            nativeChoice: { requirementId: offered.requirementId, choiceId: decision } });
    });
    it('keeps Ask pending and preserves the mode ceiling', () => {
        const offered = createMcpPermissionChoices('contract', null);
        expect(resolveNativePermissionImmediateDecision(null, offered)).toBeNull();
        expect(resolveNativePermissionImmediateDecision({ decision: 'denied' }, offered)).toEqual({ decision: 'denied' });
    });
    it('does not choose between ambiguous native approvals or invent an unavailable scope', () => {
        const offered = createMcpPermissionChoices('contract', null);
        const once = offered.choices[0]!;
        expect(resolveNativePermissionImmediateDecision({ decision: 'approved' }, { ...offered,
            choices: [...offered.choices, { ...once, id: 'other' }] }, mcpTool)).toBeNull();
        expect(resolveNativePermissionImmediateDecision({ decision: 'approved' }, { ...offered,
            choices: offered.choices.filter(choice => choice.scope !== 'once') }, mcpTool)).toBeNull();
    });
});
